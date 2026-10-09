import { randomUUID } from 'node:crypto';
import { requestError } from './errors.mjs';

const own = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonName = (namespace, name) => namespace && namespace !== 'functions' ? `${namespace}.${name}` : name;

/** Keep native wire names, namespaces, custom formats and JSON schemas intact. */
export function decodeTools(items = []) {
  const out = [];
  const push = (tool, namespace) => {
    if (!own(tool) || typeof tool.name !== 'string' || !tool.name) return;
    if (!['function', 'custom', 'tool_search'].includes(tool.type)) return;
    out.push({ wireName: canonName(namespace, tool.name), name: tool.name, namespace: namespace || null,
      kind: tool.type, description: typeof tool.description === 'string' ? tool.description : '',
      parameters: own(tool.parameters) ? structuredClone(tool.parameters) : { type: 'object', properties: {} },
      ...(own(tool.format) ? { format: structuredClone(tool.format) } : {}) });
  };
  for (const tool of items) {
    if (!own(tool)) continue;
    if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
      for (const nested of tool.tools) push(nested, tool.name);
    } else push(tool, null);
  }
  return out.filter((tool, i) => out.findIndex(other => other.wireName === tool.wireName) === i);
}

export class TurnBroker {
  constructor({ ttlMs = 60 * 60_000, maxTurns = 256 } = {}) {
    this.turns = new Map(); this.ttlMs = ttlMs; this.maxTurns = maxTurns; this.cancelListeners = new Set();
  }
  onCancel(listener) { this.cancelListeners.add(listener); return () => this.cancelListeners.delete(listener); }
  start(tools) {
    this.sweep();
    if (this.turns.size >= this.maxTurns) throw requestError('Too many retained Codex turns; wait for expiration', 429);
    const token = `turn_${randomUUID().replaceAll('-', '')}`;
    const turn = { token, tools: decodeTools(tools), pending: new Map(), queued: [], waiters: [],
      responseIds: [], conversationId: null, jobId: null, createdAt: Date.now(), touchedAt: Date.now(),
      completed: false, usedCallIds: new Set(), controller: new AbortController() };
    this.turns.set(token, turn);
    return turn;
  }
  get(token) {
    this.sweep();
    const turn = this.turns.get(token);
    if (!turn) throw requestError('Unknown or expired turn_token');
    return turn;
  }
  live(token) {
    const turn = this.get(token);
    if (turn.completed) throw requestError('Codex turn is completed; its tool capability is closed');
    turn.touchedAt = Date.now();
    return turn;
  }
  list(token, { query = '', offset = 0, limit = 20 } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw requestError('offset must be a non-negative integer');
    if (!Number.isSafeInteger(limit) || limit < 1) throw requestError('limit must be a positive integer');
    if (typeof query !== 'string') throw requestError('query must be a string');
    const q = query.toLowerCase().trim(), size = Math.min(limit, 50);
    const tools = this.live(token).tools.filter(tool => !q || `${tool.wireName}\n${tool.description}`.toLowerCase().includes(q));
    return { tools: tools.slice(offset, offset + size).map(({ wireName, kind, description, parameters, format }) =>
      ({ wire_name: wireName, kind, description, parameters, ...(format ? { format } : {}) })), total: tools.length,
      next_offset: offset + size < tools.length ? offset + size : null };
  }
  invoke(token, wireName, args = {}, input, { signal } = {}) {
    signal?.throwIfAborted();
    const turn = this.live(token);
    const tool = turn.tools.find(tool => tool.wireName === wireName);
    if (!tool) throw requestError(`Tool not declared by this Codex request: ${wireName}`);
    if (tool.kind === 'custom' && typeof input !== 'string') throw requestError('Custom tool requires input string');
    if (tool.kind === 'custom' && own(args) && Object.keys(args).length) throw requestError('Custom tool accepts input, not arguments');
    if (tool.kind !== 'custom' && (input !== undefined || !own(args))) throw requestError('Function tool requires arguments object');
    if (turn.pending.size >= 32) throw requestError('Too many pending tool calls', 429);
    const call_id = `call_${randomUUID().replaceAll('-', '')}`;
    const request = { call_id, tool, arguments: tool.kind === 'custom' ? undefined : structuredClone(args),
      input: tool.kind === 'custom' ? input : undefined };
    const abort = () => this.cancel(token, 'MCP caller disconnected before the tool result was delivered');
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const promise = new Promise((resolve, reject) => turn.pending.set(call_id, { request, resolve, reject, cleanup, delivered: false }));
    // Keep rejected abandoned invocations handled without changing the promise returned to callers.
    promise.catch(() => {});
    signal?.addEventListener('abort', abort, { once: true });
    turn.queued.push(call_id);
    this.wake(token);
    return promise;
  }
  wake(token) { for (const wake of this.turns.get(token)?.waiters.splice(0) || []) wake(); }
  take(token) {
    const turn = this.live(token);
    const batch = turn.queued.splice(0).map(id => turn.pending.get(id)).filter(Boolean);
    for (const item of batch) item.delivered = true;
    return batch.map(({ request }) => request);
  }
  wait(token, timeoutMs = 1000, { signal } = {}) {
    signal?.throwIfAborted();
    const turn = this.get(token);
    if (turn.queued.length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        turn.waiters = turn.waiters.filter(waiter => waiter !== wake);
      };
      const wake = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(signal.reason || new Error('Request aborted')); };
      const timer = setTimeout(wake, timeoutMs);
      turn.waiters.push(wake);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  assertCompletable(token, callId) {
    const turn = this.live(token), pending = turn.pending.get(callId);
    if (!pending || !pending.delivered || turn.usedCallIds.has(callId)) throw requestError(`Unexpected tool output: ${callId}`);
    return pending;
  }
  complete(token, callId, result) {
    const pending = this.assertCompletable(token, callId), turn = this.get(token);
    turn.pending.delete(callId); turn.usedCallIds.add(callId); pending.cleanup(); pending.resolve(result);
  }
  finish(token) {
    const turn = this.live(token);
    if (turn.pending.size) throw requestError('Cannot complete a turn with pending Codex tool calls');
    turn.completed = true; turn.touchedAt = Date.now();
    this.wake(token);
  }
  cancel(token, message = 'Turn expired') {
    const turn = this.turns.get(token);
    if (!turn) return;
    this.turns.delete(token);
    turn.controller.abort(new Error(message));
    for (const entry of turn.pending.values()) { entry.cleanup(); entry.reject(new Error(message)); }
    this.wakeDetached(turn);
    for (const listener of this.cancelListeners) listener(token, turn);
  }
  wakeDetached(turn) { for (const wake of turn.waiters.splice(0)) wake(); }
  sweep() {
    const now = Date.now();
    for (const [token, turn] of this.turns) if (now - turn.touchedAt > this.ttlMs) this.cancel(token);
  }
  close() { for (const token of [...this.turns.keys()]) this.cancel(token, 'Bridge stopped'); }
}

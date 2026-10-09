import { createHash } from 'node:crypto';
import { TurnBroker, decodeTools } from './broker.mjs';
import { requestError } from './errors.mjs';
import { buildPrompt, extractInputs, responseObject, responseOutput } from './response.mjs';

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const resultDigest = result => digest({ type: result.type, output: result.output ?? result.tools ?? null });
const requestDigest = body => { const { stream, ...rest } = body; return digest(rest); };
const outputType = kind => kind === 'custom' ? 'custom_tool_call_output' : kind === 'tool_search' ? 'tool_search_output' : 'function_call_output';
function parseToolOutput(output) {
  return { content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output ?? '') }] };
}
function newUserAfterHistory(entries) {
  const user = entries.findLastIndex(entry => entry?.role === 'user');
  const lastOutput = entries.findLastIndex(entry => /_output$/.test(entry?.type || '') || entry?.role === 'assistant');
  return user >= 0 && user > lastOutput;
}

/** Stateful two-way bridge; consumed results stay indexed for Codex's stateless full-history requests. */
export class CodexNotionBridge {
  constructor(notion, { broker = new TurnBroker(), model = '', reasoningEffort = '', timeoutMs = 180_000,
    pollIntervalMs = 950, connectorName = 'Codex Native' } = {}) {
    this.notion = notion; this.broker = broker; this.model = model; this.reasoningEffort = reasoningEffort;
    this.timeoutMs = timeoutMs; this.pollIntervalMs = pollIntervalMs; this.connectorName = connectorName;
    this.responseTurns = new Map(); this.callTurns = new Map(); this.itemTurns = new Map();
    this.resultHashes = new Map(); this.cache = new Map(); this.active = new Map(); this.initialTurns = new Map();
    this.unsubscribe = broker.onCancel(token => this.forget(token));
    this.sweeper = setInterval(() => broker.sweep(), Math.max(10, Math.min(30_000, broker.ttlMs / 2)));
    this.sweeper.unref();
  }
  forget(token) {
    for (const map of [this.responseTurns, this.callTurns, this.itemTurns, this.initialTurns]) for (const [key, owner] of map) if (owner === token) {
      map.delete(key); if (map === this.callTurns) this.resultHashes.delete(key);
    }
    for (const [key, value] of this.cache) if (value.token === token) this.cache.delete(key);
    this.active.delete(token);
  }
  resolveTurn(body) {
    const { entries, results } = extractInputs(body);
    if (body.previous_response_id) {
      const token = this.responseTurns.get(body.previous_response_id);
      if (!token) throw requestError('Unknown or expired previous_response_id');
      return token;
    }
    const liveOwners = new Set(results.map(result => this.callTurns.get(result.call_id)).filter(token => token &&
      results.some(result => this.broker.turns.get(token)?.pending.has(result.call_id))));
    if (liveOwners.size > 1) throw requestError('Foreign call_id: outputs belong to different live Codex turns');
    if (liveOwners.size === 1) return [...liveOwners][0];
    for (const entry of [...entries].reverse()) {
      const token = this.callTurns.get(entry.call_id) || this.itemTurns.get(entry.id);
      if (token) return token;
    }
    if (results.length) throw requestError('Tool results have no matching live Codex turn; previous_response_id state expired');
    return undefined;
  }
  async run(body, { signal, sessionId, model, reasoningEffort } = {}) {
    signal?.throwIfAborted(); this.broker.sweep();
    const { entries, results, tools } = extractInputs(body), seen = new Set();
    for (const result of results) {
      if (typeof result.call_id !== 'string' || !result.call_id) throw requestError('Tool output requires call_id');
      if (seen.has(result.call_id)) throw requestError(`Duplicate call_id: ${result.call_id}`);
      seen.add(result.call_id);
    }
    const key = requestDigest(body);
    const initialKey = typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 200 ? digest(sessionId) + ':' + key : null;
    let token = this.resolveTurn(body) || (initialKey ? this.initialTurns.get(initialKey) : null);
    let turn = token ? this.broker.get(token) : null;
    const cached = token ? this.cache.get(token + ':' + key) : null;
    if (cached && cached.token === token) return cached.response;
    if (token && this.active.has(token)) {
      const active = this.active.get(token);
      if (active.key === key) return active.promise;
      throw requestError('Another Responses request is already processing this Codex turn', 409);
    }
    const fresh = [];
    for (const result of results) {
      const owner = this.callTurns.get(result.call_id), ownerTurn = owner ? this.broker.get(owner) : null;
      if (!ownerTurn) throw requestError(`Foreign or expired call_id: ${result.call_id}`);
      if (ownerTurn.usedCallIds.has(result.call_id)) {
        if (this.resultHashes.get(result.call_id) !== resultDigest(result)) throw requestError(`Historical tool output changed: ${result.call_id}`);
        const inHistory = entries.some(entry => ['function_call', 'custom_tool_call', 'tool_search_call'].includes(entry?.type) && entry.call_id === result.call_id);
        if (!inHistory) throw requestError(`Replayed tool output is not part of full conversation history: ${result.call_id}`);
        continue;
      }
      if (owner !== token) throw requestError(`Foreign call_id: ${result.call_id}`);
      const pending = this.broker.assertCompletable(token, result.call_id);
      if (result.type !== outputType(pending.request.tool.kind)) throw requestError('Tool output type does not match its native call');
      fresh.push(result);
    }
    const resumeConversationId = turn?.completed && newUserAfterHistory(entries) ? turn.conversationId : null;
    if (turn?.completed) {
      if (!newUserAfterHistory(entries)) throw requestError('Cannot replay tool results or continue a completed Codex turn without a new user message');
      turn = null; token = undefined;
    }
    if (turn) {
      if (!turn.jobId) throw requestError('Notion job not initialized');
      const delivered = [...turn.pending.values()].filter(pending => pending.delivered);
      if (delivered.length !== fresh.length) throw requestError('Not all pending parallel tool results were returned');
      // All validation happens BEFORE any result resolves a remote MCP call.
      if (Array.isArray(body.tools)) turn.tools = decodeTools(tools);
      for (const result of fresh) this.resultHashes.set(result.call_id, resultDigest(result));
      for (const result of fresh) this.broker.complete(token, result.call_id, parseToolOutput(result.output ?? result.tools));
    } else {
      turn = this.broker.start(tools); token = turn.token;
      if (initialKey && results.length === 0 && !body.previous_response_id) this.initialTurns.set(initialKey, token);
    }
    const promise = this.runTurn(body, turn, { signal, resumeConversationId, needsStart: !turn.jobId, model, reasoningEffort });
    this.active.set(token, { key, promise });
    try {
      const response = await promise;
      this.cache.set(token + ':' + key, { token, response });
      return response;
    } finally { if (this.active.get(token)?.promise === promise) this.active.delete(token); }
  }
  async runTurn(body, turn, { signal, resumeConversationId, needsStart, model: notionModel, reasoningEffort }) {
    const token = turn.token;
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any([turn.controller.signal, deadline, ...(signal ? [signal] : [])]);
    try {
      if (needsStart) {
        const prompt = buildPrompt(body, token, turn.tools, { connectorName: this.connectorName });
        // One Notion model per Codex turn: the request's resolved model wins, the profile default is the fallback.
        const effort = reasoningEffort || this.reasoningEffort;
        const started = await this.notion.start(prompt, { model: notionModel || this.model, signal: combined,
          ...(effort ? { reasoningEffort: effort } : {}),
          ...(resumeConversationId ? { conversationId: resumeConversationId } : {}) });
        combined.throwIfAborted();
        if (!started?.jobId) throw new Error('Notion chat did not return a background job');
        turn.jobId = started.jobId; turn.conversationId = started.conversationId || null;
      }
      let finalText = null, batch = [], usage;
      while (true) {
        combined.throwIfAborted();
        batch = this.broker.take(token);
        if (batch.length) break;
        if (turn.pollResult) {
          const outcome = turn.pollResult;
          turn.pollResult = null; turn.pollPromise = null;
          if (outcome.error) throw outcome.error;
          const state = outcome.state;
          if (state.conversationId) turn.conversationId = state.conversationId;
          if (state.status === 'completed') { finalText = state.text ?? ''; usage = state.usage; break; }
          if (state.status === 'failed' || state.status === 'orphaned') throw new Error(`Notion job ${state.status}: ${state.error || 'unknown reason'}`);
          await this.broker.wait(token, this.pollIntervalMs, { signal: combined });
          continue;
        }
        if (!turn.pollPromise) {
          turn.pollPromise = Promise.resolve().then(() => this.notion.poll(turn.jobId, { signal: turn.controller.signal }))
            .then(state => { turn.pollResult = { state }; this.broker.wake(token); },
              error => { turn.pollResult = { error }; this.broker.wake(token); });
        }
        await this.broker.wait(token, this.pollIntervalMs, { signal: combined });
      }
      const { model } = extractInputs(body);
      const response = responseObject({ model, output: responseOutput(token, batch, finalText), usage });
      turn.responseIds.push(response.id); this.responseTurns.set(response.id, token);
      for (const item of response.output) this.itemTurns.set(item.id, token);
      for (const call of batch) this.callTurns.set(call.call_id, token);
      if (finalText !== null) this.broker.finish(token);
      return response;
    } catch (error) {
      this.broker.cancel(token, error.message);
      if (deadline.aborted) throw requestError('Notion agent timed out; the Codex turn was cancelled and its tool capability revoked', 504);
      if (signal?.aborted) throw requestError('Codex caller disconnected; the turn was cancelled', 499);
      throw error;
    }
  }
  close() { clearInterval(this.sweeper); this.broker.close(); this.unsubscribe(); }
}

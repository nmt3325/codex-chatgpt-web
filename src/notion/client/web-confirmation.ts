import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { unwrapRecord } from "./workspace-manager.js";

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const short = (id: string): string => id.slice(0, 8);
const detail = (error: unknown): string => error instanceof Error ? error.message : "unknown error";

export interface WebConfirmationOptions {
  enabled: boolean;
  pollMs: number;
  discoveryMs: number;
  concurrency: number;
  stateFilePath?: string | undefined;
  /** Diagnostics: name the gate that stopped an approval. Never logs URLs, arguments or page text. */
  debug?: boolean | undefined;
}
export const DEFAULT_WEB_CONFIRMATION = { enabled: true, pollMs: 5_000, discoveryMs: 30_000, concurrency: 8, debug: false };
export interface WebConfirmationScope { spaceId: string; userId: string }
export interface WebConfirmationReply { text: string; inputTokens: number; outputTokens: number; eventTypes: Record<string, number> }
export interface WebConfirmationRuntime {
  scopes(signal: AbortSignal): Promise<WebConfirmationScope[]>;
  post(scope: WebConfirmationScope, endpoint: string, body: Json, signal: AbortSignal): Promise<Json>;
  confirm(scope: WebConfirmationScope, body: Json, signal: AbortSignal): Promise<WebConfirmationReply>;
}
export class WebConfirmationHttpError extends Error {
  constructor(readonly status: number) { super(`Web confirmation request returned HTTP ${status}`); }
  // 408/5xx/network failures may have happened after submission. Never blindly replay them.
  get rejected(): boolean { return this.status >= 400 && this.status < 500 && this.status !== 408; }
}

/** Match persisted permissions, never assistant prose or the mere presence of an old permission. */
export function isPendingWebConfirmation(step: Json): boolean {
  const input = object(step.input);
  if (step.type !== "agent-tool-result" || step.state !== "confirmation:requested" || !string(step.id)) return false;
  if (step.toolName !== "callFunction" || object(step.moduleInfo).type !== "web") return false;
  if (input.function !== "connections.web.loadPage" || input.namespace !== "connections" || input.connectionName !== "web" || input.isCustomToolCall === true) return false;
  const pending = step.pendingConfirmations;
  // confirmToolStepIds grants the entire step, so a mixed URL + write permission is not eligible.
  return Array.isArray(pending) && pending.length > 0 && pending.every(value => {
    const item = object(value);
    return item.type === "urlSafety" && Array.isArray(item.urls) && item.urls.length > 0 && item.urls.every(value => {
      if (typeof value !== "string") return false;
      try { const url = new URL(value); return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password; }
      catch { return false; }
    });
  });
}

/** The observed Allow once request replays existing config/context and the exact pending steps. */
export function buildWebConfirmationRequest(scope: WebConfirmationScope, threadId: string, config: Json[], steps: Json[], traceId: string): Json {
  if (!steps.length || !steps.every(isPendingWebConfirmation)) throw new Error("Only pending built-in Web URL confirmations can be approved");
  if (!config.some(step => step.type === "config") || !config.some(step => step.type === "context")) throw new Error("Stored configuration/context is required for confirmation");
  return {
    traceId, spaceId: scope.spaceId, threadId,
    transcript: [...config, ...steps], confirmToolStepIds: steps.map(step => step.id),
    createThread: false, generateTitle: false, saveAllThreadOperations: true, setUnreadState: true,
    createdSource: "ai_module", threadType: "workflow", isPartialTranscript: true, asPatchResponse: false,
    supportsCustomAgentNudgeTranscriptStep: true,
    debugOverrides: { emitAgentSearchExtractedResults: true }
  };
}

interface Target { scope: WebConfirmationScope; threadId: string }
interface Attempt { spaceId: string; threadId: string; traceId: string; stepIds: string[] }
interface Evidence { thread: Json; config: Json[]; steps: Json[]; inferenceId: string; fingerprint: string }
const keyOf = (scope: WebConfirmationScope, threadId: string): string => `${scope.spaceId}:${threadId}`;

/** One supervisor per process, shared by every HTTP session; also used by inline chat recovery. */
export class WebConfirmationSupervisor {
  private readonly targets = new Map<string, Target>();
  private readonly flights = new Map<string, Promise<WebConfirmationReply | null>>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly cooldowns = new Map<string, number>();
  private readonly replies = new Map<string, { traces: Set<string>; reply: WebConfirmationReply }>();
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking: Promise<void> | undefined;
  private nextDiscovery = 0;
  private started = false;

  constructor(private readonly runtime: WebConfirmationRuntime, readonly options: WebConfirmationOptions,
    private readonly log: (event: string) => void = event => { process.stderr.write(`notion-ai-mcp web-confirmation: ${event}\n`); }) {
    if (!options.enabled || !options.stateFilePath) return;
    try {
      const data: unknown = JSON.parse(readFileSync(options.stateFilePath, "utf8"));
      const saved = object(data);
      if (saved.version !== 1 || !Array.isArray(saved.attempts)) throw new Error("Invalid web confirmation journal");
      for (const value of saved.attempts) {
        const entry = object(value);
        const stepIds = strings(entry.stepIds);
        if (!string(entry.spaceId) || !string(entry.threadId) || !string(entry.traceId) || !stepIds.length) throw new Error("Invalid web confirmation journal entry");
        const attempt = { spaceId: string(entry.spaceId), threadId: string(entry.threadId), traceId: string(entry.traceId), stepIds };
        this.attempts.set(`${attempt.spaceId}:${attempt.threadId}`, attempt);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read web confirmation journal; automatic confirmation was not started");
    }
  }

  start(): void {
    if (!this.options.enabled || this.started || this.controller.signal.aborted) return;
    this.started = true;
    this.log("enabled (built-in Web URL confirmations, all discoverable account threads)");
    this.timer = setInterval(() => { void this.tick(); }, this.options.pollMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller.abort();
  }

  /** Single-flight polling. Detached turn streams cannot block discovery or another thread. */
  tick(): Promise<void> {
    if (!this.options.enabled || this.controller.signal.aborted) return Promise.resolve();
    if (this.ticking) return this.ticking;
    const work = this.cycle().catch((error: unknown) => {
      if (this.controller.signal.aborted) return;
      this.log(this.options.debug ? `poll failed; will retry: ${detail(error)}` : "poll failed; will retry (details redacted)");
    });
    this.ticking = work;
    void work.finally(() => { if (this.ticking === work) this.ticking = undefined; });
    return work;
  }

  private async cycle(): Promise<void> {
    if (Date.now() >= this.nextDiscovery) {
      this.nextDiscovery = Date.now() + this.options.discoveryMs;
      await this.discover();
    }
    this.controller.signal.throwIfAborted();
    this.note(`poll: targets=${this.targets.size} flights=${this.flights.size} cooling=${[...this.cooldowns.values()].filter(deadline => deadline > Date.now()).length} attempts=${this.attempts.size}`);
    for (const [key, target] of [...this.targets]) {
      if (this.flights.size >= this.options.concurrency) break;
      if (this.flights.has(key) || (this.cooldowns.get(key) ?? 0) > Date.now()) continue;
      // Round-robin ordering: a busy/large account must not starve later threads.
      this.targets.delete(key); this.targets.set(key, target);
      void this.resume(target.scope, target.threadId).catch((error: unknown) => {
        if (this.controller.signal.aborted) return;
        this.log(this.options.debug
          ? `thread ${short(target.threadId)} confirmation paused: ${detail(error)}`
          : "thread confirmation paused; details redacted");
      });
    }
  }

  /** Diagnostics only: thread ids are truncated, and URLs, arguments and page text are never logged. */
  private note(event: string): void { if (this.options.debug) this.log(event); }
  private skip(threadId: string, reason: string): null {
    this.note(`thread ${short(threadId)} not eligible: ${reason}`);
    return null;
  }

  private async discover(): Promise<void> {
    const signal = this.controller.signal;
    const scopes = await this.runtime.scopes(signal);
    this.note(`discovery: accounts=${scopes.length}`);
    for (const scope of scopes) {
      signal.throwIfAborted();
      try {
        let cursor: string | undefined;
        const visited = new Set<string>();
        do {
          const page = await this.runtime.post(scope, "getInferenceTranscriptsForUser", {
            threadParentPointer: { table: "space", id: scope.spaceId, spaceId: scope.spaceId },
            includeWorkflowThreads: true, includeWriterChats: false, ...(cursor ? { cursor } : {})
          }, signal);
          signal.throwIfAborted();
          const records = object(object(page.recordMap).thread);
          for (const value of Array.isArray(page.transcripts) ? page.transcripts : []) {
            const id = string(object(value).id);
            if (!id) continue;
            const thread = unwrapRecord(records[id]);
            if (thread.alive === false || (thread.space_id && thread.space_id !== scope.spaceId)) continue;
            const outcome = object(object(thread.data).last_turn_outcome);
            const key = keyOf(scope, id);
            if (thread.current_inference_id || outcome.status === "requires_action") {
              if (!this.targets.has(key)) this.note(`discovery: thread ${short(id)} queued (status=${string(outcome.status) || "none"}, running=${Boolean(thread.current_inference_id)})`);
              this.targets.set(key, { scope, threadId: id });
            }
            else if (!this.flights.has(key)) this.targets.delete(key);
          }
          if (!page.hasMore) break;
          const next = string(page.nextCursor);
          if (!next || visited.has(next)) throw new Error("Invalid transcript pagination cursor");
          visited.add(next); cursor = next;
        } while (!signal.aborted);
      } catch (error) {
        if (signal.aborted) continue;
        this.log(this.options.debug
          ? `workspace discovery failed; other workspaces continue: ${detail(error)}`
          : "workspace discovery failed; other workspaces continue");
      }
    }
  }

  /** expectedInferenceId keeps a later user turn from reusing an earlier recovered answer. */
  async resume(scope: WebConfirmationScope, threadId: string, expectedInferenceId?: string): Promise<WebConfirmationReply | null> {
    if (!this.options.enabled || this.controller.signal.aborted) return null;
    const key = keyOf(scope, threadId);
    const cached = this.replies.get(key);
    if (expectedInferenceId && cached?.traces.has(expectedInferenceId)) return cached.reply;
    let work = this.flights.get(key);
    if (!work) {
      work = this.run(scope, threadId);
      this.flights.set(key, work);
      const current = work;
      void work.then(() => { if (this.flights.get(key) === current) this.flights.delete(key); }, () => {
        if (this.flights.get(key) === current) this.flights.delete(key);
      });
    }
    const result = await work;
    if (expectedInferenceId && result && !this.replies.get(key)?.traces.has(expectedInferenceId)) return null;
    return result;
  }

  private async messages(scope: WebConfirmationScope, ids: string[]): Promise<Map<string, Json>> {
    const result = new Map<string, Json>();
    if (!ids.length) return result;
    const payload = await this.runtime.post(scope, "syncRecordValuesMain", {
      requests: ids.map(id => ({ pointer: { table: "thread_message", id, spaceId: scope.spaceId }, version: -1 }))
    }, this.controller.signal);
    for (const id of ids) {
      const record = unwrapRecord(object(object(payload.recordMap).thread_message)[id]);
      if (!Object.keys(record).length) throw new Error("A confirmation record is unavailable");
      result.set(id, object(record.step ?? object(record.data).step ?? record.data));
    }
    return result;
  }

  private async evidence(scope: WebConfirmationScope, threadId: string): Promise<Evidence | null> {
    const payload = await this.runtime.post(scope, "syncRecordValuesMain", {
      requests: [{ pointer: { table: "thread", id: threadId, spaceId: scope.spaceId }, version: -1 }]
    }, this.controller.signal);
    const thread = unwrapRecord(object(object(payload.recordMap).thread)[threadId]);
    if (!Object.keys(thread).length) throw new Error("Thread record is unavailable");
    if (thread.alive === false || thread.space_id !== scope.spaceId || thread.type !== "workflow") {
      return this.skip(threadId, `thread_not_eligible(alive=${thread.alive !== false}, space=${thread.space_id === scope.spaceId}, type=${string(thread.type) || "none"})`);
    }
    const outcome = object(object(thread.data).last_turn_outcome);
    if (outcome.status !== "requires_action") return this.skip(threadId, `outcome_not_requires_action(${string(outcome.status) || "none"})`);
    // A new execution/user message must not approve a previous turn's stale permission.
    if (thread.current_inference_id && thread.current_inference_id !== outcome.inference_id) return this.skip(threadId, "inference_id_mismatch");
    const ids = strings(thread.messages), finalId = string(outcome.final_step_id), inferenceId = string(outcome.inference_id);
    if (!finalId || !inferenceId || ids.at(-1) !== finalId) {
      return this.skip(threadId, `final_step_not_last(finalStep=${Boolean(finalId)}, inference=${Boolean(inferenceId)}, isLast=${ids.at(-1) === finalId}, steps=${ids.length})`);
    }
    const final = (await this.messages(scope, [finalId])).get(finalId)!;
    if (final.type !== "agent-tool-result" || final.state !== "confirmation:requested") {
      return this.skip(threadId, `final_step_not_pending_confirmation(type=${string(final.type) || "none"}, state=${string(final.state) || "none"})`);
    }
    const agentStepId = string(final.agentStepId);
    if (!agentStepId) return this.skip(threadId, "final_step_missing_agent_step_id");
    const steps: Json[] = [];
    let boundary = false;
    for (let end = ids.length; end > 0 && !boundary; end -= 64) {
      const batch = ids.slice(Math.max(0, end - 64), end), records = await this.messages(scope, batch);
      for (const id of [...batch].reverse()) {
        const step = records.get(id)!;
        if (step.type === "agent-inference" || step.type === "user") { boundary = true; break; }
        if (step.agentStepId === agentStepId && step.traceId === inferenceId && isPendingWebConfirmation(step)) steps.push(step);
      }
    }
    if (!steps.length) return this.skip(threadId, "no_pending_web_url_confirmation_step");
    const config: Json[] = [];
    for (let start = 0; start < ids.length && config.length < 2; start += 32) {
      const records = await this.messages(scope, ids.slice(start, start + 32));
      for (const step of records.values()) {
        if ((step.type === "config" || step.type === "context") && !config.some(saved => saved.type === step.type)) config.push(step);
      }
    }
    if (config.length !== 2) {
      this.note(`thread ${short(threadId)} not eligible: stored_config_context_missing(found=${config.length})`);
      throw new Error("Stored config/context unavailable");
    }
    return { thread, config, steps: steps.reverse(), inferenceId,
      fingerprint: JSON.stringify([thread.version, outcome.inference_id, outcome.final_step_id, ids]) };
  }

  private save(): void {
    const path = this.options.stateFilePath;
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, attempts: [...this.attempts.values()] }), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  }

  private async run(scope: WebConfirmationScope, threadId: string): Promise<WebConfirmationReply | null> {
    const key = keyOf(scope, threadId), signal = this.controller.signal;
    if ((this.cooldowns.get(key) ?? 0) > Date.now()) return null;
    const traces = new Set<string>();
    let reply: WebConfirmationReply | null = null;
    let inputTokens = 0, outputTokens = 0;
    for (;;) {
      signal.throwIfAborted();
      const before = await this.evidence(scope, threadId);
      signal.throwIfAborted();
      if (!before) {
        const previous = this.attempts.get(key);
        if (previous) {
          const records = await this.messages(scope, previous.stepIds);
          if ([...records.values()].every(step => typeof step.state === "string" && step.state !== "confirmation:requested")) {
            this.attempts.delete(key); this.save();
          }
        }
        if (reply) {
          this.replies.set(key, { traces, reply });
          if (this.replies.size > 200) this.replies.delete(this.replies.keys().next().value!);
        }
        return reply;
      }
      const previous = this.attempts.get(key);
      if (previous?.stepIds.some(id => before.steps.some(step => step.id === id))) {
        // Uncertain HTTP/stream delivery, including after restart: observe, never duplicate.
        this.cooldowns.set(key, Date.now() + 30_000);
        return reply;
      }
      // Fresh evidence immediately before submission prevents stale discovery/history approval.
      const fresh = await this.evidence(scope, threadId);
      signal.throwIfAborted();
      if (!fresh || fresh.fingerprint !== before.fingerprint) return reply;
      const traceId = randomUUID();
      const body = buildWebConfirmationRequest(scope, threadId, fresh.config, fresh.steps, traceId);
      this.attempts.set(key, { spaceId: scope.spaceId, threadId, traceId, stepIds: fresh.steps.map(step => string(step.id)) });
      this.save(); // Write-ahead: failure to persist must not grant permission.
      signal.throwIfAborted();
      try {
        const resumed = await this.runtime.confirm(scope, body, signal);
        signal.throwIfAborted();
        traces.add(fresh.inferenceId);
        inputTokens += resumed.inputTokens; outputTokens += resumed.outputTokens;
        reply = { ...resumed, inputTokens, outputTokens };
        this.log("confirmation response received; checking persisted state");
      } catch (error) {
        if (error instanceof WebConfirmationHttpError && error.rejected) { this.attempts.delete(key); this.save(); }
        this.cooldowns.set(key, Date.now() + 30_000);
        throw error;
      }
      // A second URL is a different step, even on the same host. Re-read and handle it independently.
    }
  }
}

import { NotionClient } from "./client/notion-client";
import { isUnfinishedFinalStep } from "./client/keep-awake";
import type { ChatJobLookup } from "./client/types";
import { clientConfig, redact, type NotionCredentials, type NotionProfile } from "./profile";

export type DirectClient = Pick<NotionClient, "startChat" | "chatResult" | "threadSignals" | "finalStepShape" | "listChatJobs">;
export interface StartOptions { model?: string; reasoningEffort?: string; conversationId?: string; signal?: AbortSignal }

/** How often the thread's own completion flag is read while this process still streams the turn. */
const SETTLEMENT_POLL_MS = 750;
/** Absorbs rounding between Notion's Date header and the locally recorded start stamp. */
const CLOCK_TOLERANCE_MS = 2000;
/** A closed turn whose recorded final step still reads as unfinished is collected after this grace. */
const UNFINISHED_FINAL_GRACE_MS = 10_000;
/** Only this process's just-created thread may take a short time to appear in the record store. */
const THREAD_GRACE_MS = 30_000;

interface OwnedJob { conversationId: string; startedAt: number; controller: AbortController; detach: () => void; checkedAt: number; unfinishedSince: number | null }

/** An in-process client, not an MCP HTTP proxy. Never submits a synthetic tool-result user message. */
export class DirectNotionBackend {
  private readonly owned = new Map<string, OwnedJob>();
  private closed = false;
  constructor(readonly client: DirectClient, private readonly toolsEnabled: boolean, private readonly secrets: string[] = [], private readonly stop?: AbortController) {}
  redact(error: unknown): string { return redact(error, this.secrets); }
  async start(prompt: string, options: StartOptions = {}) {
    if (this.closed) throw new Error("Notion runtime is closed");
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await this.client.startChat({ prompt, model: options.model || undefined, reasoningEffort: options.reasoningEffort || undefined, conversationId: options.conversationId || undefined, readOnly: !this.toolsEnabled, webSearch: false, workspaceSearch: false, _signal: controller.signal });
      this.owned.set(result.jobId, { conversationId: result.conversationId, startedAt: result.startedAt, controller, detach: () => options.signal?.removeEventListener("abort", abort), checkedAt: 0, unfinishedSince: null });
      return { jobId: result.jobId, conversationId: result.conversationId };
    } catch (error) { options.signal?.removeEventListener("abort", abort); throw new Error(this.redact(error)); }
  }

  /**
   * Cookie-authenticated test for "Notion finished this turn", not "Notion has written some text".
   *
   * A turn is produced step by step and every step is persisted as it happens: thinking, interim
   * answer text, tool calls, then more inference. Stored assistant text is therefore not an answer.
   * The turn is over only once the thread holds no live inference lease and Notion has written
   * data.last_turn_outcome for a turn that closed after ours began; the recorded final step then
   * separates a real answer from a turn that stopped on an unfinished step.
   */
  private async settled(job: OwnedJob): Promise<boolean> {
    const now = Date.now();
    if (now - job.checkedAt < SETTLEMENT_POLL_MS) return false;
    job.checkedAt = now;
    const signals = await this.client.threadSignals(job.conversationId);
    // Compare on Notion's clock: serverNow is taken from the response Date header.
    const startedAtServer = job.startedAt + (signals.serverNow - now);
    const generating = Boolean(signals.currentInferenceId) && (signals.leaseExpiration === null || signals.leaseExpiration > signals.serverNow);
    const outcome = signals.lastTurnOutcome;
    const closedAfterStart = outcome?.completedTime != null && outcome.completedTime >= startedAtServer - CLOCK_TOLERANCE_MS;
    if (generating || !outcome || !closedAfterStart) { job.unfinishedSince = null; return false; }
    // A turn closed without an answer (failed, requires_action) is diagnosed by the caller, not waited out.
    if (outcome.status !== "completed" || !isUnfinishedFinalStep(await this.client.finalStepShape(outcome.finalStepId))) { job.unfinishedSince = null; return true; }
    job.unfinishedSince ??= now;
    return now - job.unfinishedSince >= UNFINISHED_FINAL_GRACE_MS;
  }

  async poll(jobId: string, { signal }: { signal?: AbortSignal } = {}): Promise<ChatJobLookup> {
    const owned = this.owned.get(jobId);
    if (!owned || this.closed) throw new Error("Unknown or closed Notion job capability");
    signal?.throwIfAborted();
    owned.controller.signal.throwIfAborted();
    const stillRunning: ChatJobLookup = { status: "running", source: "job", jobId, conversationId: owned.conversationId };
    const local = this.client.listChatJobs({ limit: 100 }).find((job) => job.jobId === jobId);
    // While this process still streams the turn, a result lookup would be answered from the interim
    // step text Notion has already stored, which closes the turn and its tool capability too early.
    if (local?.status === "running") {
      try { if (!(await this.settled(owned))) return stillRunning; }
      catch (error) {
        if (Date.now() - owned.startedAt < THREAD_GRACE_MS) return stillRunning;
        throw new Error(this.redact(error));
      }
    }
    let result: ChatJobLookup;
    try { result = await this.client.chatResult({ jobId, waitMs: 0 }); }
    catch (error) {
      if (/Conversation .+ was not found/.test(String(error)) && Date.now() - owned.startedAt < THREAD_GRACE_MS) return stillRunning;
      throw new Error(this.redact(error));
    }
    if (result.conversationId !== owned.conversationId) throw new Error("Notion job crossed its conversation boundary");
    if (result.status === "failed") {
      let error = this.redact(result.error || "Notion generation failed");
      try {
        const signals = await this.client.threadSignals(owned.conversationId);
        if (signals.lastTurnOutcome?.status === "requires_action") {
          const shape = await this.client.finalStepShape(signals.lastTurnOutcome.finalStepId);
          if (shape?.state === "confirmation:requested") error = "Notion requires tool confirmation. Approval is not bypassed. Confirm in Notion, or explicitly opt in with --allow-automatic-tools for this runtime-owned connector.";
        }
      } catch { /* Preserve the original failure when its stored final state is unavailable. */ }
      result = { ...result, error };
    }
    if (["completed", "failed", "orphaned"].includes(result.status)) { owned.detach(); this.owned.delete(jobId); }
    return result;
  }
  close(): void {
    this.closed = true;
    for (const job of this.owned.values()) { job.controller.abort(new Error("Notion runtime stopped")); job.detach(); }
    this.owned.clear(); this.stop?.abort(new Error("Notion runtime stopped"));
  }
}
export function createDirectBackend(profile: NotionProfile, credentials: NotionCredentials, home: string, toolsEnabled: boolean, fetchImpl: typeof fetch = fetch) {
  const stop = new AbortController();
  const transport = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetchImpl(input, { ...init, signal: AbortSignal.any([stop.signal, ...(init?.signal ? [init.signal] : [])]) })) as typeof fetch;
  const client = new NotionClient(clientConfig(profile, credentials, home), transport);
  const backend = new DirectNotionBackend(client, toolsEnabled, [credentials.token_v2, credentials.full_cookie || "", profile.apiKey, profile.callbackToken], stop);
  return { client, backend };
}

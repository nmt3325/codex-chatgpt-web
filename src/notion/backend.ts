import { NotionClient } from "./client/notion-client";
import type { ChatJobLookup } from "./client/types";
import { clientConfig, redact, type NotionCredentials, type NotionProfile } from "./profile";

export type DirectClient = Pick<NotionClient, "startChat" | "chatResult" | "threadSignals" | "finalStepShape">;
export interface StartOptions { model?: string; reasoningEffort?: string; conversationId?: string; signal?: AbortSignal }

/** An in-process client, not an MCP HTTP proxy. Never submits a synthetic tool-result user message. */
export class DirectNotionBackend {
  private readonly owned = new Map<string, { conversationId: string; startedAt: number; controller: AbortController; detach: () => void }>();
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
      this.owned.set(result.jobId, { conversationId: result.conversationId, startedAt: result.startedAt, controller, detach: () => options.signal?.removeEventListener("abort", abort) });
      return { jobId: result.jobId, conversationId: result.conversationId };
    } catch (error) { options.signal?.removeEventListener("abort", abort); throw new Error(this.redact(error)); }
  }
  async poll(jobId: string, { signal }: { signal?: AbortSignal } = {}): Promise<ChatJobLookup> {
    const owned = this.owned.get(jobId);
    if (!owned || this.closed) throw new Error("Unknown or closed Notion job capability");
    signal?.throwIfAborted();
    owned.controller.signal.throwIfAborted();
    let result: ChatJobLookup;
    try { result = await this.client.chatResult({ jobId, waitMs: 0 }); }
    catch (error) {
      // Only this process's just-created thread may take a short time to appear in the record store.
      if (/Conversation .+ was not found/.test(String(error)) && Date.now() - owned.startedAt < 30000) return { status: "running", source: "job", jobId, conversationId: owned.conversationId };
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

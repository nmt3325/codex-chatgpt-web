type JsonObject = Record<string, unknown>;

const object = (value: unknown): JsonObject => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

/** Native Continue observed in the web client: no new user/config step and no tool permission grant. */
export function buildNativeContinuationRequest(spaceId: string, threadId: string, traceId: string): JsonObject {
  return {
    traceId, spaceId, threadId, transcript: [], createThread: false,
    generateTitle: false, saveAllThreadOperations: true, setUnreadState: false,
    threadType: "workflow", asPatchResponse: false, isPartialTranscript: true,
    supportsCustomAgentNudgeTranscriptStep: true,
    debugOverrides: { emitAgentSearchExtractedResults: true },
    analyticsArgs: { suggestedPrompt: {
      promptKey: "max_iterations.continue",
      promptDescription: "Continue agent execution after max iterations reached"
    } }
  };
}

/**
 * The step-limit banner counts agent-inference iterations of the current turn, not
 * last_turn_outcome.step_count. Measured in the live client: a single turn held 127 iterations across
 * two executions (101 + 26), so resuming keeps the iterations already spent and only a new user
 * message starts the count over. `steps` must therefore be the steps after the latest user step.
 * null means the transcript lacks enough metadata for this stronger check.
 */
export function nativeIterationLimitReached(config: JsonObject, steps: readonly JsonObject[]): boolean | null {
  if (config.type !== "workflow") return null;
  const inferences = steps.filter(step => step.type === "agent-inference");
  const latest = inferences.at(-1);
  if (!latest) return false;
  // An answer without a tool call is a finished turn, however many iterations it took.
  if (!Array.isArray(latest.value)) return null;
  if (!latest.value.some(part => object(part).type === "tool_use")) return false;
  const limit = config.enableScriptAgent === true ? 100 : steps.some(step => step.type === "agent-trigger") ? 50 : 15;
  return inferences.length >= limit;
}

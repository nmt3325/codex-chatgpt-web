import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectNotionBackend, createDirectBackend, type DirectClient } from "../../src/notion/backend";
import { newProfile } from "../../src/notion/profile";
const workspace = "22222222-2222-4222-8222-222222222222", user = "11111111-1111-4111-8111-111111111111", conversation = "66666666-6666-4666-8666-666666666666";
function fakeClient(overrides: Partial<DirectClient> = {}): DirectClient {
  return {
    async startChat(options) { return { status: "running", jobId: "fixture-job", conversationId: conversation, model: "fixture", startedAt: Date.now(), hint: "" }; },
    async chatResult() { return { status: "completed", source: "job", conversationId: conversation, text: "answer" }; },
    async threadSignals() { return { threadId: conversation, updatedTime: null, serverNow: Date.now(), messageCount: 0, lastTurnOutcome: null, credits: null, currentInferenceId: "", leaseExpiration: null }; },
    async finalStepShape() { return null; }, ...overrides,
  };
}
test("in-process backend starts once and polling does not submit tool results as another user message", async () => {
  let calls = 0, last: any;
  const backend = new DirectNotionBackend(fakeClient({ async startChat(options) { calls++; last = options; return { status: "running", jobId: "j", conversationId: conversation, model: "m", startedAt: Date.now(), hint: "" }; } }), true);
  try { const started = await backend.start("prompt"); const result = await backend.poll(started.jobId); expect(result.text).toBe("answer"); expect(calls).toBe(1); expect(last.readOnly).toBe(false); expect(last.workspaceSearch).toBe(false); await expect(backend.poll("unowned")).rejects.toThrow(/Unknown/); }
  finally { backend.close(); }
});
test("text-only mode always enables Notion read-only mode", async () => {
  let readOnly: boolean | undefined;
  const client = fakeClient({ async startChat(options) { readOnly = options.readOnly; return { status: "running", jobId: "j", conversationId: conversation, model: "m", startedAt: Date.now(), hint: "" }; } });
  const backend = new DirectNotionBackend(client, false); try { await backend.start("text"); expect(readOnly).toBe(true); } finally { backend.close(); }
});
test("caller cancellation reaches the owned SDK inference signal", async () => {
  let signal: AbortSignal | undefined;
  const backend = new DirectNotionBackend(fakeClient({ async startChat(options) { signal = options._signal; return { status: "running", jobId: "j", conversationId: conversation, model: "m", startedAt: Date.now(), hint: "" }; } }), true);
  const caller = new AbortController(); try { await backend.start("hello", { signal: caller.signal }); caller.abort(); expect(signal?.aborted).toBe(true); await expect(backend.poll("j")).rejects.toThrow(); } finally { backend.close(); }
});
test("job polling rejects a different conversation", async () => {
  const backend = new DirectNotionBackend(fakeClient({ async chatResult() { return { status: "completed", source: "job", conversationId: "foreign", text: "do not return" }; } }), true);
  try { await backend.start("hello"); await expect(backend.poll("fixture-job")).rejects.toThrow(/conversation boundary/); } finally { backend.close(); }
});
test("newly created owned thread gets only a bounded lookup grace", async () => {
  const backend = new DirectNotionBackend(fakeClient({ async chatResult() { throw new Error("Conversation fixture was not found"); } }), false);
  try { await backend.start("hello"); expect((await backend.poll("fixture-job")).status).toBe("running"); } finally { backend.close(); }
});
test("persisted MCP confirmation is diagnosed, not silently approved or mislabeled as credits", async () => {
  const backend = new DirectNotionBackend(fakeClient({
    async chatResult() { return { status: "failed", source: "job", conversationId: conversation, error: "streamed no answer; maybe credits" }; },
    async threadSignals() { return { threadId: conversation, updatedTime: null, serverNow: Date.now(), messageCount: 1, credits: 10, currentInferenceId: "", leaseExpiration: null, lastTurnOutcome: { status: "requires_action", completedTime: Date.now(), stepCount: 1, inferenceId: "i", finalStepId: "s" } }; },
    async finalStepShape() { return { stepId: "s", type: "agent-tool-result", state: "confirmation:requested", hasAnswerText: false, finishedAt: Date.now() }; },
  }), true);
  try { await backend.start("hello"); const result = await backend.poll("fixture-job"); expect(result.error).toContain("Approval is not bypassed"); expect(result.error).not.toContain("maybe credits"); } finally { backend.close(); }
});
function authenticationMap(space = workspace) { return { recordMap: { notion_user: { [user]: { value: { id: user, name: "Fixture User", email: "fixture@example.test" } } }, user_root: { [user]: { value: { space_view_pointers: [{ id: "33333333-3333-4333-8333-333333333333", spaceId: space }] } } }, space: { [space]: { value: { id: space, name: "Fixture Workspace", plan_type: "enterprise" } } } } }; }
test("real embedded SDK refuses inaccessible pinned workspace before inference", async () => {
  const home = mkdtempSync(join(tmpdir(), "notion-pin-test-")); const endpoints: string[] = [];
  const fake = (async (input: any) => { endpoints.push(String(input).split("/").at(-1)!); return Response.json(authenticationMap("77777777-7777-4777-8777-777777777777")); }) as typeof fetch;
  const { client, backend } = createDirectBackend(newProfile(workspace), { token_v2: "fixture" }, home, false, fake);
  try { await expect(client.account()).rejects.toThrow(/pinned workspace/); expect(endpoints).toEqual(["loadUserContent"]); } finally { backend.close(); rmSync(home, { recursive: true, force: true }); }
});
test("real embedded SDK talks directly to Notion API and completes without any external MCP transport", async () => {
  const home = mkdtempSync(join(tmpdir(), "notion-direct-test-")); const endpoints: string[] = [];
  const fake = (async (input: any, init: any) => {
    const url = new URL(String(input)), endpoint = url.pathname.split("/").at(-1)!; endpoints.push(endpoint);
    expect(url.hostname).toBe("www.notion.so"); expect(init.method).toBe("POST");
    if (endpoint === "loadUserContent") return Response.json(authenticationMap());
    if (endpoint === "runInferenceTranscript") return new Response(JSON.stringify({ type: "agent-inference", value: [{ type: "text", content: "IN_PROCESS_OK" }], finishedAt: Date.now(), inputTokens: 2, outputTokens: 1 }) + "\n", { headers: { "content-type": "application/x-ndjson" } });
    if (endpoint === "getInferenceTranscriptsForUser") return Response.json({ recordMap: {}, transcripts: [], hasMore: false });
    throw new Error("Unexpected direct SDK endpoint: " + endpoint);
  }) as typeof fetch;
  const { backend } = createDirectBackend(newProfile(workspace), { token_v2: "fixture" }, home, false, fake);
  try {
    const started = await backend.start("Reply IN_PROCESS_OK"); let result;
    for (let i = 0; i < 20; i++) { await Bun.sleep(5); result = await backend.poll(started.jobId); if (result.status !== "running") break; }
    expect(result?.status).toBe("completed"); expect(result?.text).toBe("IN_PROCESS_OK"); expect(endpoints.filter(value => value === "runInferenceTranscript")).toHaveLength(1);
    expect(endpoints).not.toContain("tools/call");
  } finally { backend.close(); rmSync(home, { recursive: true, force: true }); }
});

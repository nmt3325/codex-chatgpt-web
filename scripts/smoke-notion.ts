import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createDirectBackend } from "../src/notion/backend";
import { startServers } from "../src/notion/core/runtime-server.mjs";
import { newProfile } from "../src/notion/profile";
import { codexArguments, writeModelCatalog } from "../src/notion/models";

// REAL embedded Notion client + REAL Codex CLI, with only the remote Notion API mocked.
// No notion-ai-mcp server, real Notion credentials, connector registration or auto-approval.
const workspace = "22222222-2222-4222-8222-222222222222", user = "11111111-1111-4111-8111-111111111111";
const root = resolve(import.meta.dir, ".."); await mkdir(join(root, ".artifacts"), { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(root, ".artifacts", "standalone-smoke-"));
const profile = newProfile(workspace); profile.port = 0; profile.callbackPort = 0; profile.timeoutMs = 25000;
const home = join(directory, "profile"); await mkdir(home, { mode: 0o700 });
const marker = "standalone-shell-" + randomBytes(6).toString("hex");
let callbackPort = 0, inferenceRequests = 0, nativeResults = 0, patchVerified = false, rpcId = 0, session: string | null = null;
const returned: string[] = [], endpoints: string[] = [], sessions = new Set<string>();
async function rpc(method: string, params: Record<string, unknown>) {
  const id = ++rpcId;
  const response = await fetch("http://127.0.0.1:" + callbackPort + "/mcp", { method: "POST", headers: { authorization: "Bearer " + profile.callbackToken, "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  assert.equal(response.status, 200); session = response.headers.get("mcp-session-id") || session;
  const result: any = await response.json(); if (result.error) throw new Error(JSON.stringify(result.error)); if (result.result?.isError) throw new Error(JSON.stringify(result.result)); return result.result;
}
async function executeNative(token: string) {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "embedded-notion-api-fixture", version: "1" } });
  const inventory = await rpc("tools/call", { name: "codex_tool_inventory", arguments: { turn_token: token, limit: 50 } });
  const tools: any[] = JSON.parse(inventory.content[0].text).tools;
  const shell = tools.find(tool => /(?:^|\.)(exec_command|shell_command)$/.test(tool.wire_name)); assert.ok(shell, "Real Codex must advertise a shell");
  for (const command of ["printf '%s\\n' '" + marker + "'", "pwd"]) {
    const args = /exec_command$/.test(shell.wire_name) ? { cmd: command, workdir: directory } : { command, workdir: directory };
    const result = await rpc("tools/call", { name: "codex_tool_call", arguments: { turn_token: token, wire_name: shell.wire_name, arguments: args } });
    const text = JSON.stringify(result); returned.push(text); nativeResults++; assert.ok(text.includes(command === "pwd" ? directory : marker), "The same pending MCP request must receive actual native output; actual result: " + text);
  }
  const patch = tools.find(tool => /(?:^|\.)apply_patch$/.test(tool.wire_name)); assert.ok(patch, "Real Codex must advertise apply_patch"); assert.equal(patch.kind, "custom");
  const result = await rpc("tools/call", { name: "codex_tool_call", arguments: { turn_token: token, wire_name: patch.wire_name, input: "*** Begin Patch\n*** Add File: standalone-result.txt\n+STANDALONE_PATCH_OK\n*** End Patch\n" } });
  returned.push(JSON.stringify(result)); nativeResults++;
  assert.equal((await readFile(join(directory, "standalone-result.txt"), "utf8")).trim(), "STANDALONE_PATCH_OK"); patchVerified = true;
}
const fakeApi = (async (input: any, init: any) => {
  const endpoint = new URL(String(input)).pathname.split("/").at(-1)!; endpoints.push(endpoint);
  if (endpoint === "loadUserContent") return Response.json({ recordMap: { notion_user: { [user]: { value: { id: user, name: "Fixture User", email: "fixture@example.test" } } }, user_root: { [user]: { value: { space_view_pointers: [{ id: "33333333-3333-4333-8333-333333333333", spaceId: workspace }] } } }, space: { [workspace]: { value: { id: workspace, name: "Fixture Workspace", plan_type: "enterprise" } } } } });
  if (endpoint === "getInferenceTranscriptsForUser") return Response.json({ recordMap: {}, transcripts: [], hasMore: false });
  if (endpoint !== "runInferenceTranscript") throw new Error("Unexpected direct API endpoint: " + endpoint);
  inferenceRequests++;
  const token = String(init.body).match(/TURN TOKEN: (turn_[a-f0-9]+)/)?.[1]; assert.ok(token, "Direct Notion transcript must carry its scoped native turn capability");
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    void executeNative(token).then(() => {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: "agent-inference", value: [{ type: "text", content: "STANDALONE_NATIVE_OK" }], finishedAt: Date.now(), inputTokens: 10, outputTokens: 2 }) + "\n")); controller.close();
    }).catch(error => controller.error(error));
  } });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
}) as typeof fetch;
const { backend } = createDirectBackend(profile, { token_v2: "fixture-no-real-auth" }, home, true, fakeApi);
const servers = startServers({ config: { apiHost: "127.0.0.1", apiPort: 0, mcpHost: "127.0.0.1", mcpPort: 0, apiKey: profile.apiKey, mcpToken: profile.callbackToken, notionModel: profile.model, connectorName: profile.connectorName, timeoutMs: 25000, toolsEnabled: true }, notion: backend });
const bridge: any = servers.bridge; const run = bridge.run.bind(bridge); bridge.run = (body: any, options: any) => { sessions.add(options.sessionId); return run(body, options); };
let child: ReturnType<typeof spawn> | undefined;
try {
  await servers.ready; callbackPort = (servers.mcp.address() as { port: number }).port;
  const port = (servers.codex.address() as { port: number }).port, codexHome = join(directory, "codex-home"), final = join(directory, "answer.txt"); await mkdir(codexHome);
  const sessionId = randomBytes(16).toString("hex");
  const args = codexArguments(writeModelCatalog(home), port, ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--sandbox", "workspace-write", "--color", "never", "--json", "-c", "features.shell_snapshot=false", "-C", directory, "-o", final, "Run only the deterministic backend-provided isolated smoke task."]);
  child = spawn(process.env.CODEX_BIN || "codex", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CODEX_HOME: codexHome, CODEX_NOTION_API_KEY: profile.apiKey, CODEX_NOTION_SESSION_ID: sessionId } });
  let stdout = "", stderr = ""; child.stdout!.on("data", data => { stdout += data; }); child.stderr!.on("data", data => { stderr += data; });
  const timer = setTimeout(() => child?.kill("SIGTERM"), 35000);
  const exit = await new Promise<number | null>((resolve, reject) => { child!.once("error", reject); child!.once("exit", resolve); }); clearTimeout(timer);
  const answer = await readFile(final, "utf8").catch(() => "");
  const report = { kind: "real-codex-real-embedded-client-mock-notion-api", external_notion_mcp: false, exit_code: exit, direct_inference_requests: inferenceRequests, native_results: nativeResults, same_pending_mcp_result: returned.length === 3, freeform_patch_verified: patchVerified, stable_session_header: sessions.size === 1 && sessions.has(sessionId), final: answer.trim(), endpoints: [...new Set(endpoints)] };
  console.log(JSON.stringify(report, null, 2));
  if (exit !== 0) {
    console.error("Mock fixture native output:", backend.redact(returned.join("\n").slice(-8000)));
    console.error("Codex fixture events:", backend.redact(stdout.slice(-8000)));
    console.error(backend.redact(stderr.slice(-5000)));
  }
  assert.equal(exit, 0); assert.equal(inferenceRequests, 1, "Native results must resume the same inference, not create a new Notion user message"); assert.equal(nativeResults, 3); assert.ok(patchVerified); assert.deepEqual([...sessions], [sessionId]); assert.equal(answer.trim(), "STANDALONE_NATIVE_OK");
} finally { if (child?.exitCode === null) child.kill("SIGTERM"); await servers.close(); backend.close(); await rm(directory, { recursive: true, force: true }); }

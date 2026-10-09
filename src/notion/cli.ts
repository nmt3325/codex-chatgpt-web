import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createDirectBackend } from "./backend";
import { codexArguments, codexConfig, writeModelCatalog } from "./models";
import { clientConfig, importCredentials, loadCredentials, loadProfile, newProfile, privateDirectory, profileHome, redact, validateProfile, writePrivate } from "./profile";
import { cleanupNotionProfile, startNotionRuntime } from "./runtime";

export const NOTION_HELP = `Standalone Notion AI backend (no separate notion-ai-mcp server)

  notion setup --cookie-file PATH --workspace UUID [--home PATH]
  notion setup --account-file PATH --workspace UUID [--home PATH]
  notion doctor [--home PATH]
  notion config [--home PATH]
  notion serve --tunnel [--cloudflared PATH] [--home PATH]
  notion serve --public-url https://your-callback.example/mcp [--home PATH]
  notion serve --no-tools [--home PATH]
  notion run --tunnel [--home PATH] -- exec --sandbox read-only "Your task"
  notion cleanup [--stale-lock] [--home PATH]

--allow-automatic-tools explicitly authorizes automatic native calls ONLY on the
connector created by this runtime. It is off by default. Codex still enforces
its own sandbox and approval policy. There is no workspace failover.

--port N, --callback-port N, --model NAME, --timeout-ms N apply to setup.
--codex-bin PATH applies to run. Arguments after -- belong only to Codex.
A cookie/account file is private: never paste its contents into chat or git.
`;
interface Parsed { command: string; values: Map<string, string>; flags: Set<string>; codex: string[] }
const valueOptions = new Set(["home", "workspace", "cookie-file", "account-file", "port", "callback-port", "model", "timeout-ms", "public-url", "cloudflared", "codex-bin"]);
const flagOptions = new Set(["no-tools", "tunnel", "allow-automatic-tools", "stale-lock", "help", "replace"]);
export function parseNotionArgs(input: string[]): Parsed {
  const args = [...input], command = args.shift() || "help", values = new Map<string, string>(), flags = new Set<string>();
  let codex: string[] = [];
  while (args.length) {
    const option = args.shift()!;
    if (option === "--") { codex = args.splice(0); break; }
    if (option === "-h") { flags.add("help"); continue; }
    if (!option.startsWith("--")) throw new Error("Unexpected Notion argument; put Codex arguments after --");
    const key = option.slice(2);
    if (flags.has(key) || values.has(key)) throw new Error("Duplicate option: --" + key);
    if (flagOptions.has(key)) flags.add(key);
    else if (valueOptions.has(key)) {
      const value = args.shift();
      if (!value || value.startsWith("--")) throw new Error("Missing value for --" + key);
      values.set(key, value);
    } else throw new Error("Unknown option: --" + key);
  }
  if (codex.length && command !== "run") throw new Error("Only notion run accepts Codex arguments after --");
  const commandValues: Record<string, string[]> = { setup: ["workspace", "cookie-file", "account-file", "port", "callback-port", "model", "timeout-ms"], run: ["public-url", "cloudflared", "codex-bin"], serve: ["public-url", "cloudflared"] };
  const commandFlags: Record<string, string[]> = { setup: ["replace"], run: ["no-tools", "tunnel", "allow-automatic-tools"], serve: ["no-tools", "tunnel", "allow-automatic-tools"], cleanup: ["stale-lock"] };
  for (const key of values.keys()) if (key !== "home" && !(commandValues[command] || []).includes(key)) throw new Error("--" + key + " does not apply to " + command);
  for (const key of flags) if (key !== "help" && !(commandFlags[command] || []).includes(key)) throw new Error("--" + key + " does not apply to " + command);
  return { command, values, flags, codex };
}
export async function runNotionCommand(args: string[]): Promise<void> {
  const { command, values, flags, codex } = parseNotionArgs(args);
  if (command === "help" || command === "--help" || command === "-h" || flags.has("help")) { process.stdout.write(NOTION_HELP); return; }
  const home = profileHome(values.get("home"));
  if (command === "setup") {
    const account = values.get("account-file"), cookie = values.get("cookie-file"), workspace = values.get("workspace");
    if (!workspace || !!account === !!cookie) throw new Error("Setup needs --workspace UUID and exactly one --cookie-file or --account-file");
    if (existsSync(join(home, "runtime.lock")) || existsSync(join(home, "owned-connection.json"))) throw new Error("Stop and clean up the existing runtime before changing authentication");
    if (existsSync(join(home, "config.json")) && !flags.has("replace")) throw new Error("Profile already exists; use --replace only after cleanup");
    const file = account || cookie!;
    if (statSync(file).size > 5000000) throw new Error("Cookie/account export exceeds the local import limit");
    let credentials;
    try { credentials = importCredentials(readFileSync(file, "utf8")); }
    catch { throw new Error("Invalid Notion cookie/account export; no secret contents were logged"); }
    const profile = newProfile(workspace);
    if (values.has("port")) profile.port = Number(values.get("port"));
    if (values.has("callback-port")) profile.callbackPort = Number(values.get("callback-port"));
    if (values.has("model")) profile.model = values.get("model")!;
    if (values.has("timeout-ms")) profile.timeoutMs = Number(values.get("timeout-ms"));
    validateProfile(profile); privateDirectory(home);
    writePrivate(join(home, "account.json"), credentials); writePrivate(join(home, "config.json"), profile); writeModelCatalog(home);
    process.stdout.write("Imported Notion authentication into the private isolated profile. Run notion doctor to verify the pinned workspace. No external Notion MCP service is needed.\n");
    return;
  }
  if (command === "cleanup") { await cleanupNotionProfile(home, flags.has("stale-lock")); process.stdout.write("Removed only this profile's owned connector; unrelated connections were not changed.\n"); return; }
  if (command === "config") { const profile = loadProfile(home); process.stdout.write(codexConfig(profile, writeModelCatalog(home))); process.stdout.write("\n# Supply CODEX_NOTION_API_KEY from your private profile via your local secret manager.\n# Use a fresh CODEX_NOTION_SESSION_ID for every Codex process. notion run handles both.\n"); return; }
  if (command === "doctor") {
    const profile = loadProfile(home), credentials = loadCredentials(home), { client, backend } = createDirectBackend(profile, credentials, home, false);
    try {
      const account = await client.account();
      if (account.spaceId !== profile.workspaceId) throw new Error("Pinned workspace mismatch");
      process.stdout.write("Notion authentication: valid\nPinned workspace: matched\nExternal notion-ai-mcp service: not required\nNative callback: use --tunnel or --public-url\nAutomatic native calls: disabled by default\n");
    } catch (error) { throw new Error(backend.redact(error)); } finally { backend.close(); }
    return;
  }
  if (!["serve", "run"].includes(command)) throw new Error("Unknown Notion command\n" + NOTION_HELP);
  if (command === "run" && !codex.length) throw new Error("notion run requires a Codex command after --, for example: -- exec --sandbox read-only \"Your task\"");
  if (flags.has("allow-automatic-tools")) process.stderr.write("Explicit opt-in: this runtime-owned connector may automatically request native Codex tools; Codex sandbox and approvals still apply.\n");
  const startup = new AbortController();
  let runtime: Awaited<ReturnType<typeof startNotionRuntime>> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  const shutdown = () => {
    startup.abort(); child?.kill("SIGTERM");
    const current = runtime;
    if (current) void current.stop().catch(error => { process.stderr.write(current.backend.redact(error) + "\n"); process.exitCode = 1; });
  };
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
  try {
    runtime = await startNotionRuntime({ home, noTools: flags.has("no-tools"), tunnel: flags.has("tunnel"), publicUrl: values.get("public-url"), cloudflared: values.get("cloudflared"), allowAutomaticTools: flags.has("allow-automatic-tools"), signal: startup.signal });
    process.stderr.write("Standalone Notion Responses endpoint: http://127.0.0.1:" + runtime.port + "/v1 (" + (runtime.tools ? "native callback" : "text only") + "); no separate notion-ai-mcp process\n");
    if (command === "serve") await runtime.stopped;
    else {
      const binary = values.get("codex-bin") || "codex";
      const catalog = writeModelCatalog(home);
      const childEnv = { ...process.env };
      for (const key of Object.keys(childEnv)) if (/^NOTION_/.test(key) || ["MCP_BRIDGE_TOKEN", "NOTION_MCP_HTTP_BEARER_TOKEN", "CODEX_BRIDGE_API_KEY", "CODEX_NOTION_API_KEY", "CODEX_NOTION_SESSION_ID"].includes(key)) delete childEnv[key];
      child = spawn(binary, codexArguments(catalog, runtime.port, codex), { stdio: "inherit", shell: false, windowsHide: true, env: { ...childEnv, CODEX_NOTION_API_KEY: runtime.profile.apiKey, CODEX_NOTION_SESSION_ID: randomBytes(16).toString("hex") } });
      const exit = await new Promise<number>((resolve, reject) => { child!.once("error", () => reject(new Error("Cannot start Codex CLI; install it or use --codex-bin PATH"))); child!.once("exit", (code, signal) => resolve(code ?? (signal ? 130 : 1))); });
      process.exitCode = exit;
    }
  } finally { process.off("SIGINT", shutdown); process.off("SIGTERM", shutdown); await runtime?.stop(); }
}

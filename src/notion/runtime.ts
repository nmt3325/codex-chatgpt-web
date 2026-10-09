import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createDirectBackend } from "./backend";
import { startServers, type RuntimeServers } from "./core/runtime-server.mjs";
import { cleanupOwnedConnection, registerOwnedConnection, validateCallbackUrl } from "./connector";
import { applyModelOverrides, modelRegistry } from "./models";
import { loadCredentials, loadProfile, privateDirectory, redact } from "./profile";
import { startQuickTunnel, type OwnedTunnel } from "./tunnel";

export interface RuntimeOptions { home: string; noTools?: boolean; tunnel?: boolean; publicUrl?: string; cloudflared?: string; allowAutomaticTools?: boolean; model?: string; reasoningEffort?: string; signal?: AbortSignal }
export async function startNotionRuntime(options: RuntimeOptions) {
  const checkStartup = () => { if (options.signal?.aborted) throw new Error("Standalone startup cancelled; owned resources will be cleaned up"); };
  checkStartup();
  const home = options.home; privateDirectory(home);
  // A model override applies to this runtime only; the stored profile file is never rewritten.
  const profile = applyModelOverrides(loadProfile(home), options.model, options.reasoningEffort), credentials = loadCredentials(home);
  const tools = !options.noTools;
  if (tools && !options.tunnel && !options.publicUrl) throw new Error("Native tools need --tunnel or --public-url; use --no-tools for text-only operation");
  if (options.tunnel && options.publicUrl) throw new Error("Choose --tunnel or --public-url, not both");
  if (!tools && options.allowAutomaticTools) throw new Error("--allow-automatic-tools has no effect in text-only mode");
  if (!tools && (options.tunnel || options.publicUrl)) throw new Error("Text-only mode does not need a callback tunnel");
  if (options.publicUrl) validateCallbackUrl(options.publicUrl);
  const lockPath = join(home, "runtime.lock");
  // A second instance must not adopt or destroy a running instance's owned connection.
  const lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600).catch(() => { throw new Error("This profile is locked; stop its runtime first. After a crash, run notion cleanup --stale-lock before restarting"); });
  let direct: ReturnType<typeof createDirectBackend>;
  try { await lock.writeFile(String(process.pid)); await lock.close(); direct = createDirectBackend(profile, credentials, home, tools); }
  catch (error) { await lock.close().catch(() => {}); await unlink(lockPath).catch(() => {}); throw new Error(redact(error, [credentials.token_v2, credentials.full_cookie || ""])); }
  const { client, backend } = direct;
  let servers: RuntimeServers | undefined, tunnel: OwnedTunnel | undefined, connection: Awaited<ReturnType<typeof registerOwnedConnection>> | undefined;
  let stopping: Promise<void> | undefined;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>(resolve => { resolveStopped = resolve; });
  const stop = (): Promise<void> => stopping ??= (async () => {
    const errors: unknown[] = [];
    try { servers?.beginShutdown(); } catch (error) { errors.push(error); }
    for (const release of [() => connection?.remove(), () => tunnel?.close(), () => servers?.close(), () => backend.close(), async () => { if (existsSync(lockPath)) await unlink(lockPath); }]) {
      try { await release(); } catch (error) { errors.push(error); }
    }
    resolveStopped();
    if (errors.length) throw new Error(errors.map(error => backend.redact(error)).join("; ") + "; retry notion cleanup if the owned record remains");
  })();
  try {
    checkStartup();
    const account = await client.account();
    checkStartup();
    if (account.spaceId !== profile.workspaceId) throw new Error("Notion authentication did not resolve the explicitly pinned workspace");
    servers = startServers({ config: { apiHost: "127.0.0.1", apiPort: profile.port, mcpHost: "127.0.0.1", mcpPort: profile.callbackPort, apiKey: profile.apiKey, mcpToken: profile.callbackToken, notionModel: profile.model, ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}), models: modelRegistry(profile), connectorName: profile.connectorName, timeoutMs: profile.timeoutMs, toolsEnabled: tools, startupFence: true }, notion: backend });
    await servers.ready; checkStartup();
    const port = (servers.codex.address() as { port: number }).port;
    const callbackPort = (servers.mcp.address() as { port: number }).port;
    let callbackUrl = options.publicUrl;
    if (options.tunnel) { tunnel = await startQuickTunnel(home, callbackPort, options.cloudflared); callbackUrl = tunnel.url; checkStartup(); }
    if (tools && callbackUrl) {
      // Read-only preflight retries tunnel propagation, never an ambiguous connection-creation write.
      let ready = false;
      for (let attempt = 0; attempt < 25; attempt++) {
        checkStartup();
        try {
          const response = await fetch(callbackUrl, { method: "POST", headers: { authorization: "Bearer " + profile.callbackToken, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "notion-owned-preflight", version: "1" } } }), signal: AbortSignal.timeout(3000) });
          if ([401, 403].includes(response.status)) throw new Error("Callback authentication rejected");
          if (response.ok) {
            const result = await response.json() as { result?: { serverInfo?: { name?: string } } };
            if (result.result?.serverInfo?.name !== "codex-notion-ai") throw new Error("Callback is not this runtime's native-tool server");
            ready = true; break;
          }
          await response.body?.cancel();
        } catch (error) { if (/authentication rejected|not this runtime/.test(String(error))) throw error; }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (!ready) throw new Error("The owned HTTPS callback did not become reachable");
      connection = await registerOwnedConnection(home, client.mcp(), profile, callbackUrl, options.allowAutomaticTools ?? false);
    }
    checkStartup();
    servers.markReady();
    tunnel?.onFailure(() => { void stop().catch(error => console.error(backend.redact(error))); });
    return { profile, port, callbackPort, tools, servers, client, backend, stop, stopped };
  } catch (error) { await stop().catch(() => {}); throw new Error(redact(error, [profile.apiKey, profile.callbackToken, credentials.token_v2, credentials.full_cookie || ""])); }
}

export async function cleanupNotionProfile(home: string, staleLock = false) {
  const profile = loadProfile(home), credentials = loadCredentials(home), lockPath = join(home, "runtime.lock");
  if (existsSync(lockPath)) {
    if (!staleLock) throw new Error("Profile is locked; do not clean up a running runtime");
    const pid = Number(await Bun.file(lockPath).text());
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Refusing to clear a lock with an invalid PID");
    let alive = true; try { process.kill(pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    if (alive || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("Refusing to clear a lock whose process may still be running");
  }
  const { client, backend } = createDirectBackend(profile, credentials, home, false);
  try {
    if ((await client.account()).spaceId !== profile.workspaceId) throw new Error("Pinned workspace mismatch");
    await cleanupOwnedConnection(home, client.mcp(), profile);
    if (staleLock && existsSync(lockPath)) await unlink(lockPath);
  } finally { backend.close(); }
}

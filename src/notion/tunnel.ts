import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { writePrivate } from "./profile";

export interface OwnedTunnel { url: string; close(): Promise<void>; onFailure(handler: () => void): void }

/** Own exactly one cloudflared child. Never read or modify the machine's named-tunnel configuration. */
export async function startQuickTunnel(home: string, port: number, binary = "cloudflared", timeoutMs = 45000): Promise<OwnedTunnel> {
  const emptyConfig = join(home, "cloudflared-empty.json"); writePrivate(emptyConfig, {});
  const child: ChildProcess = spawn(binary, ["tunnel", "--config", emptyConfig, "--url", "http://127.0.0.1:" + port, "--no-autoupdate", "--protocol", "http2"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
  let stopped = false, exited = false, url = "", failure: (() => void) | undefined;
  let resolveExit!: () => void;
  const exit = new Promise<void>(resolve => { resolveExit = resolve; });
  child.once("close", () => { exited = true; resolveExit(); if (!stopped && url) failure?.(); });
  const close = async () => {
    if (stopped) return exit;
    stopped = true;
    if (!exited) child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([exit, new Promise<void>(resolve => { timer = setTimeout(() => { if (!exited) child.kill("SIGKILL"); resolve(); }, 3000); })]);
    clearTimeout(timer);
  };
  try {
    url = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("Timed out waiting for the owned HTTPS tunnel")), timeoutMs);
      const cleanup = () => { clearTimeout(timer); child.stdout?.off("data", data); child.stderr?.off("data", data); child.off("error", error); child.off("exit", premature); };
      const data = (chunk: Buffer) => {
        buffer = (buffer + chunk.toString("utf8")).slice(-16000);
        const found = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i);
        if (found) { cleanup(); resolve(found[0] + "/mcp"); }
      };
      const error = () => { cleanup(); reject(new Error("Cannot start cloudflared; install it or pass --cloudflared PATH, or use --public-url instead")); };
      const premature = () => { cleanup(); reject(new Error("The owned tunnel exited before becoming ready")); };
      child.stdout?.on("data", data); child.stderr?.on("data", data); child.once("error", error); child.once("exit", premature);
    });
    // Consume logs without storing credentials or keeping an unread pipe alive.
    child.stdout?.resume(); child.stderr?.resume();
    return { url, close, onFailure(handler) { failure = handler; if (exited && !stopped) handler(); } };
  } catch (error) { await close(); throw error; }
}

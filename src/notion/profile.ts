import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { NotionConfig } from "./client/config";
import { REASONING_EFFORTS, type ReasoningEffort } from "./client/models";
import { DEFAULT_WEB_CONFIRMATION } from "./client/web-confirmation";

export interface NotionProfile {
  version: 1;
  workspaceId: string;
  port: number;
  callbackPort: number;
  connectorName: string;
  model: string;
  reasoningEffort?: string;
  timeoutMs: number;
  apiKey: string;
  callbackToken: string;
}
export interface NotionCredentials { token_v2: string; full_cookie?: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const profileHome = (home?: string): string => resolve(home || process.env.CODEX_NOTION_WEB_HOME || join(homedir(), ".codex-notion-web"));

export function privateDirectory(path: string): void {
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())) throw new Error("Private profile must be a real directory, not a symlink");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
}
export function writePrivate(path: string, value: unknown): void {
  privateDirectory(dirname(path));
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Refusing a symlink at a private profile file");
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
export function readPrivate<T>(path: string): T {
  if (!existsSync(path)) throw new Error("Notion profile is not configured; run notion setup first");
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Private profile file must not be a symlink");
  if (process.platform !== "win32" && (stat.mode & 0o077)) throw new Error("Private profile file permissions must be 600");
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch { throw new Error("Invalid private profile JSON; secret contents were not logged"); }
}
export function validateProfile(value: NotionProfile): NotionProfile {
  if (value.version !== 1 || !UUID.test(value.workspaceId)) throw new Error("Select one explicit Notion workspace UUID");
  for (const port of [value.port, value.callbackPort]) if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Ports must be integers between 0 and 65535");
  if (value.port !== 0 && value.port === value.callbackPort) throw new Error("Responses and callback ports must be different");
  if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 900000) throw new Error("Turn timeout must be between 1000 and 900000 milliseconds");
  if (typeof value.apiKey !== "string" || value.apiKey.length < 32 || typeof value.callbackToken !== "string" || value.callbackToken.length < 32 || value.apiKey === value.callbackToken) throw new Error("Independent strong Responses and callback keys are required");
  if (typeof value.connectorName !== "string" || !value.connectorName.trim() || value.connectorName.length > 100 || /[\r\n]/.test(value.connectorName)) throw new Error("Invalid connector name");
  if (typeof value.model !== "string" || !value.model.trim() || value.model.length > 100) throw new Error("Invalid Notion model");
  if (value.reasoningEffort !== undefined && !REASONING_EFFORTS.includes(value.reasoningEffort as ReasoningEffort)) throw new Error("Invalid Notion reasoning effort");
  return value;
}
export function newProfile(workspaceId: string): NotionProfile {
  return validateProfile({ version: 1, workspaceId, port: 17842, callbackPort: 17843, timeoutMs: 240000, model: "almond-croissant-low", connectorName: "Codex Notion Native " + randomBytes(4).toString("hex"), apiKey: randomBytes(32).toString("hex"), callbackToken: randomBytes(32).toString("hex") });
}
export function loadProfile(home: string): NotionProfile { return validateProfile(readPrivate<NotionProfile>(join(home, "config.json"))); }
export function loadCredentials(home: string): NotionCredentials {
  const credentials = readPrivate<NotionCredentials>(join(home, "account.json"));
  if (typeof credentials.token_v2 !== "string" || !credentials.token_v2.trim() || /[\r\n;]/.test(credentials.token_v2)) throw new Error("A valid Notion token_v2 session is required");
  if (credentials.full_cookie !== undefined && (typeof credentials.full_cookie !== "string" || /[\r\n]/.test(credentials.full_cookie))) throw new Error("Invalid cookie header");
  return credentials;
}

/** Accept only Notion cookies, never foreign cookies from a browser-wide export. */
export function importCredentials(content: string, now = Date.now()): NotionCredentials {
  const cookieMap = new Map<string, string>();
  const allowed = new Set(["notion.so", ".notion.so", "www.notion.so", "notion.com", ".notion.com", "app.notion.com", ".app.notion.com"]);
  const add = (domain: unknown, name: unknown, value: unknown, expires?: unknown) => {
    if (typeof domain !== "string" || !allowed.has(domain.toLowerCase()) || typeof name !== "string" || typeof value !== "string") return;
    if (typeof expires === "number" && expires > 0 && expires * 1000 <= now) return;
    if (!name || /[\s;=]/.test(name) || /[\r\n;]/.test(value)) return;
    cookieMap.set(name, value);
  };
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const value = JSON.parse(trimmed);
    if (value && !Array.isArray(value) && typeof value.token_v2 === "string") {
      const result: NotionCredentials = { token_v2: value.token_v2 };
      if (typeof value.full_cookie === "string") {
        if (/[\r\n]/.test(value.full_cookie)) throw new Error("Invalid cookie header");
        const pairs = value.full_cookie.split(";").map((entry: string) => entry.trim()).filter((entry: string) => entry.includes("="));
        for (const pair of pairs) { const separator = pair.indexOf("="); add("notion.so", pair.slice(0, separator), pair.slice(separator + 1)); }
        cookieMap.set("token_v2", value.token_v2);
        result.full_cookie = [...cookieMap].map(([name, val]) => name + "=" + val).join("; ");
      }
      if (!result.token_v2 || /[\r\n;]/.test(result.token_v2)) throw new Error("Invalid Notion token_v2");
      return result;
    }
    const cookies = Array.isArray(value) ? value : value?.cookies;
    if (!Array.isArray(cookies)) throw new Error("Expected an account JSON or browser cookie export");
    for (const cookie of cookies) add(cookie?.domain, cookie?.name, cookie?.value, cookie?.expires ?? cookie?.expirationDate);
  } else {
    for (const raw of content.split(/\r?\n/)) {
      const line = raw.startsWith("#HttpOnly_") ? raw.slice(10) : raw;
      if (!line.trim() || line.startsWith("#")) continue;
      const fields = line.split("\t");
      if (fields.length === 7) add(fields[0], fields[5], fields[6], Number(fields[4]));
    }
  }
  const token_v2 = cookieMap.get("token_v2");
  if (!token_v2) throw new Error("No unexpired Notion token_v2 cookie in the supplied export");
  return { token_v2, full_cookie: [...cookieMap].map(([name, value]) => name + "=" + value).join("; ") };
}
export function clientConfig(profile: NotionProfile, credentials: NotionCredentials, home?: string): NotionConfig {
  return {
    apiBase: ["https:", "", "www.notion.so", "api", "v3"].join("/"), defaultModel: profile.model, requestTimeoutMs: profile.timeoutMs,
    account: { tokenV2: credentials.token_v2, pinnedSpaceId: profile.workspaceId, ...(credentials.full_cookie ? { fullCookie: credentials.full_cookie } : {}) },
    maxWorkspaceRetries: 0, chatWaitMs: 1000, allowSessionRehydrate: false,
    defaultWebSearch: false, defaultWorkspaceSearch: false, defaultReadOnly: true,
    ...(home ? { stateFilePath: join(home, "jobs.json"), mcpRegistryPath: join(home, "mcp-registry.json") } : {}),
    keepAwake: { enabled: false, interrupt: false, autoContinue: false, maxContinues: 0, idleMs: 120000, pollMs: 30000, cooldownMs: 60000, maxNudges: 1, deadlineMs: 60000 },
    webConfirmation: { ...DEFAULT_WEB_CONFIRMATION, enabled: false },
  };
}
export function redact(message: unknown, secrets: string[] = []): string {
  let text = message instanceof Error ? message.message : String(message);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join("[secret]");
  return text.replace(/turn_[a-f0-9]+/g, "[turn]").replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "[identifier]").replace(/token_v2=[^\s;]+/g, "token_v2=[secret]");
}

import { test, expect } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientConfig, importCredentials, newProfile, readPrivate, redact, validateProfile, writePrivate } from "../../src/notion/profile";
import { parseNotionArgs } from "../../src/notion/cli";
import { buildPrompt, extractInputs } from "../../src/notion/core/response.mjs";
import { writeModelCatalog, codexConfig } from "../../src/notion/models";
const workspace = "22222222-2222-4222-8222-222222222222";

test("Netscape import supports app.notion.com HttpOnly cookies and excludes foreign/expired cookies", () => {
  const input = "# Netscape HTTP Cookie File\n#HttpOnly_.app.notion.com\tTRUE\t/\tTRUE\t0\ttoken_v2\towned-token\n.evil.example\tTRUE\t/\tTRUE\t0\tforeign\tDO_NOT_IMPORT\n.notion.so\tTRUE\t/\tTRUE\t1\texpired\told\n";
  expect(importCredentials(input)).toEqual({ token_v2: "owned-token", full_cookie: "token_v2=owned-token" });
});
test("browser cookie JSON import does not import another domain's token", () => {
  expect(importCredentials(JSON.stringify([{ domain: ".notion.com", name: "token_v2", value: "allowed", expires: -1 }, { domain: "unrelated.test", name: "token_v2", value: "foreign" }])).token_v2).toBe("allowed");
  expect(() => importCredentials(JSON.stringify([{ domain: "unrelated.test", name: "token_v2", value: "foreign" }]))).toThrow(/No unexpired/);
});
test("expired Notion token is rejected", () => { expect(() => importCredentials(".notion.so\tTRUE\t/\tTRUE\t1\ttoken_v2\texpired")).toThrow(/No unexpired/); });
test("account migration needs no server and synchronizes token in full cookie", () => {
  expect(importCredentials(JSON.stringify({ token_v2: "new", full_cookie: "device_id=fixture; token_v2=old" })).full_cookie).toBe("device_id=fixture; token_v2=new");
  expect(() => importCredentials(JSON.stringify({ token_v2: "bad\r\nheader" }))).toThrow();
});
test("private profile writes are atomic, private and do not follow a final-file symlink", () => {
  const home = mkdtempSync(join(tmpdir(), "notion-profile-test-"));
  try {
    const path = join(home, "config.json"); writePrivate(path, { safe: true });
    expect(readPrivate<{ safe: boolean }>(path)).toEqual({ safe: true });
    if (process.platform !== "win32") {
      expect(lstatSync(path).mode & 0o777).toBe(0o600); expect(lstatSync(home).mode & 0o777).toBe(0o700);
      chmodSync(path, 0o644); expect(() => readPrivate(path)).toThrow(/permissions/); chmodSync(path, 0o600);
      symlinkSync(path, join(home, "link.json")); expect(() => writePrivate(join(home, "link.json"), {})).toThrow(/symlink/);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test("private malformed JSON does not echo secret text", () => {
  const home = mkdtempSync(join(tmpdir(), "notion-json-test-"));
  try { const file = join(home, "bad.json"); writeFileSync(file, '{"secret":"NEVER_LOG_THIS', { mode: 0o600 }); expect(() => readPrivate(file)).toThrow("Invalid private profile JSON; secret contents were not logged"); }
  finally { rmSync(home, { recursive: true, force: true }); }
});
test("Notion config is pinned and disables implicit workspace switching and automatic confirmation", () => {
  const config = clientConfig(newProfile(workspace), { token_v2: "fixture" });
  expect(config.account.pinnedSpaceId).toBe(workspace); expect(config.maxWorkspaceRetries).toBe(0);
  expect(config.webConfirmation?.enabled).toBe(false); expect(config.keepAwake.enabled).toBe(false); expect(config.keepAwake.autoContinue).toBe(false);
  expect(config.defaultWebSearch).toBe(false); expect(config.defaultWorkspaceSearch).toBe(false); expect(config.defaultReadOnly).toBe(true);
  expect(config.apiBase).not.toContain("127.0.0.1"); expect(config.accountFilePath).toBeUndefined();
});
test("invalid ports, shared keys and missing explicit workspace fail validation", () => {
  const base = newProfile(workspace);
  for (const patch of [{ workspaceId: "" }, { port: -1 }, { port: base.callbackPort }, { callbackToken: base.apiKey }, { timeoutMs: 0 }]) expect(() => validateProfile({ ...base, ...patch })).toThrow();
});
test("CLI defaults do not grant automatic native tool approval", () => {
  expect(parseNotionArgs(["serve", "--tunnel"]).flags.has("allow-automatic-tools")).toBe(false);
  expect(parseNotionArgs(["serve", "--tunnel", "--allow-automatic-tools"]).flags.has("allow-automatic-tools")).toBe(true);
  expect(() => parseNotionArgs(["doctor", "--allow-automatic-tools"])).toThrow(/does not apply/);
});
test("Codex arguments remain separate from profile flags", () => {
  const args = parseNotionArgs(["run", "--home", "/tmp/profile", "--no-tools", "--", "exec", "--sandbox", "read-only", "hello"]);
  expect(args.codex).toEqual(["exec", "--sandbox", "read-only", "hello"]);
  expect(() => parseNotionArgs(["serve", "--cookie-file", "secret"])).toThrow(/does not apply/);
  expect(() => parseNotionArgs(["serve", "--tunnel", "--tunnel"])).toThrow(/Duplicate/);
});
test("redaction removes actual credentials, turn capabilities and private identifiers", () => {
  const secret = "SENSITIVE_AUTH_VALUE";
  const text = redact(new Error(secret + " token_v2=other-cookie turn_abcdef " + workspace), [secret]);
  expect(text).not.toContain(secret); expect(text).not.toContain("other-cookie"); expect(text).not.toContain(workspace); expect(text).not.toContain("turn_abcdef");
});
test("text-only prompt never advertises nonexistent callback tools", () => {
  const prompt = buildPrompt({ input: [{ role: "user", content: "hello" }], tools: [] }, "turn_private", []);
  expect(prompt).toContain("No tools are attached"); expect(prompt).not.toContain("turn_private"); expect(prompt).not.toContain("codex_tool_call");
});
test("conversation text is not silently truncated to the old 90k prompt slice", () => {
  const input = "START_MUST_SURVIVE" + "a".repeat(95000) + "END_MUST_SURVIVE";
  const prompt = buildPrompt({ input: [{ role: "user", content: input }] }, "unused", []);
  expect(prompt).toContain("START_MUST_SURVIVE"); expect(prompt).toContain("END_MUST_SURVIVE");
  expect(() => buildPrompt({ input: [{ role: "user", content: "a".repeat(500001) }] }, "unused", [])).toThrow(/compact it explicitly/);
});
test("Codex catalog advertises native freeform patch without pretending to support images", () => {
  const home = mkdtempSync(join(tmpdir(), "notion-catalog-test-"));
  try { const catalog = writeModelCatalog(home); const model = JSON.parse(readFileSync(catalog, "utf8")).models[0]; expect(model.apply_patch_tool_type).toBe("freeform"); expect(model.input_modalities).toEqual(["text"]); const toml = codexConfig(newProfile(workspace), catalog); expect(toml).toContain('env_key = "CODEX_NOTION_API_KEY"'); expect(toml).not.toContain("notion-ai-mcp"); }
  finally { rmSync(home, { recursive: true, force: true }); }
});

test("unsupported compaction and unknown input items fail instead of being dropped", () => {
  for (const item of [{ type: "compaction", encrypted_content: "opaque" }, { type: "unknown_advanced_input" }, { role: "unknown", content: "data" }]) expect(() => extractInputs({ input: [item] })).toThrow();
});

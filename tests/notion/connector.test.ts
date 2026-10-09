import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOwnedConnection, cleanupOwnedConnection, validateCallbackUrl, type ConnectionManager } from "../../src/notion/connector";
import { newProfile, readPrivate } from "../../src/notion/profile";
const workspace = "22222222-2222-4222-8222-222222222222";
const callback = "https://owned-callback.example/mcp";
function fixture(home: string, failure?: "ambiguous" | "removal") {
  const profile = newProfile(workspace), records: any[] = [], removed: string[] = [], added: any[] = [];
  const manager: ConnectionManager = {
    async list() { return [...records]; },
    async add(input) {
      added.push(input); const intent: any = readPrivate(join(home, "owned-connection.json")); expect(intent.id).toBe(input.ownedModuleId);
      const record = { id: input.ownedModuleId!, name: input.name, serverUrl: input.serverUrl, spaceId: workspace, runWriteToolsAutomatically: input.runWriteToolsAutomatically };
      records.push(record); if (failure === "ambiguous") throw new Error("lost create response"); return record;
    },
    async remove(id) { if (failure === "removal") throw new Error("offline"); removed.push(id); const index = records.findIndex(item => item.id === id); if (index >= 0) records.splice(index, 1); return { removed: true }; },
  }; return { profile, records, removed, added, manager };
}
test("callback URL rejects insecure, credential-bearing and loopback destinations", () => {
  for (const value of ["http://example.test/mcp", "https://u:p@example.test/mcp", "https://localhost/mcp", "https://example.test/mcp?token=secret", "https://example.test/wrong"]) expect(() => validateCallbackUrl(value)).toThrow();
  expect(validateCallbackUrl(callback)).toBe(callback);
});
test("owned connector is default confirmation-required and cleanup removes only its exact identifier", async () => {
  const home = mkdtempSync(join(tmpdir(), "notion-connection-test-")); const state = fixture(home);
  state.records.push({ id: "unrelated", name: "Other", serverUrl: "https://other.example/mcp", spaceId: workspace });
  try { const owned = await registerOwnedConnection(home, state.manager, state.profile, callback); expect(state.added[0].runWriteToolsAutomatically).toBe(false); expect(state.added[0].enabledToolNames).toEqual(["codex_tool_inventory", "codex_tool_call"]); await owned.remove(); expect(state.records.map(item => item.id)).toEqual(["unrelated"]); expect(state.removed).toHaveLength(1); expect(existsSync(join(home, "owned-connection.json"))).toBe(false); }
  finally { rmSync(home, { recursive: true, force: true }); }
});
test("automatic native calls require explicit opt-in on a newly created owned connector", async () => {
  const home = mkdtempSync(join(tmpdir(), "notion-approval-test-")); const state = fixture(home);
  try { const owned = await registerOwnedConnection(home, state.manager, state.profile, callback, true); expect(state.added[0].runWriteToolsAutomatically).toBe(true); await owned.remove(); } finally { rmSync(home, { recursive: true, force: true }); }
});
test("an existing same-name connector is not adopted or changed", async () => {
  const home = mkdtempSync(join(tmpdir(), "notion-unowned-test-")); const state = fixture(home); state.records.push({ id: "foreign", name: state.profile.connectorName, serverUrl: callback, spaceId: workspace });
  try { await expect(registerOwnedConnection(home, state.manager, state.profile, callback)).rejects.toThrow(/not be changed or adopted/); expect(state.added).toHaveLength(0); expect(state.removed).toHaveLength(0); } finally { rmSync(home, { recursive: true, force: true }); }
});
test("cleanup refuses an owned connector whose URL has changed", async () => {
  const home = mkdtempSync(join(tmpdir(), "notion-owner-change-test-")); const state = fixture(home);
  try { await registerOwnedConnection(home, state.manager, state.profile, callback); state.records[0].serverUrl = "https://someone-else.example/mcp"; await expect(cleanupOwnedConnection(home, state.manager, state.profile)).rejects.toThrow(/ownership changed/); expect(state.removed).toHaveLength(0); expect(existsSync(join(home, "owned-connection.json"))).toBe(true); } finally { rmSync(home, { recursive: true, force: true }); }
});
test("lost connection creation response is rolled back by pre-persisted exact ID without repeating creation", async () => {
  const home = mkdtempSync(join(tmpdir(), "notion-rollback-test-")); const state = fixture(home, "ambiguous");
  try { await expect(registerOwnedConnection(home, state.manager, state.profile, callback)).rejects.toThrow(/lost create response/); expect(state.added).toHaveLength(1); expect(state.records).toHaveLength(0); expect(state.removed.every(id => id === state.added[0].ownedModuleId)).toBe(true); } finally { rmSync(home, { recursive: true, force: true }); }
});
test("failed cleanup retains durable ownership for a later explicit cleanup", async () => {
  const home = mkdtempSync(join(tmpdir(), "notion-cleanup-failure-test-")); const state = fixture(home, "removal");
  try { const owned = await registerOwnedConnection(home, state.manager, state.profile, callback); await expect(owned.remove()).rejects.toThrow(/offline/); expect(existsSync(join(home, "owned-connection.json"))).toBe(true); } finally { rmSync(home, { recursive: true, force: true }); }
});

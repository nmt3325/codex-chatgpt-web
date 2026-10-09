import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AddConnectionInput, McpConnectionSummary } from "./client/mcp-connections";
import { readPrivate, writePrivate, type NotionProfile } from "./profile";

export interface ConnectionManager {
  list(): Promise<McpConnectionSummary[]>;
  add(input: AddConnectionInput): Promise<{ id: string; serverUrl: string; name: string }>;
  remove(id: string): Promise<{ removed: boolean }>;
}
interface OwnedConnection { id: string; serverUrl: string; name: string; workspaceId: string; created: true }

export function validateCallbackUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || url.pathname !== "/mcp") throw new Error("Callback must be a credential-free HTTPS URL ending in /mcp");
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) throw new Error("Notion requires a reachable HTTPS callback, not loopback");
  return url.toString();
}
export async function cleanupOwnedConnection(home: string, manager: ConnectionManager, profile: NotionProfile): Promise<boolean> {
  const file = join(home, "owned-connection.json");
  if (!existsSync(file)) return false;
  const owned = readPrivate<OwnedConnection>(file);
  if (!owned.created || owned.workspaceId !== profile.workspaceId || owned.name !== profile.connectorName || !owned.id) throw new Error("Owned connector record does not match this profile");
  const current = (await manager.list()).find(item => item.id === owned.id);
  if (current) {
    if (current.serverUrl !== owned.serverUrl || current.name !== owned.name || current.spaceId !== owned.workspaceId) throw new Error("Refusing to remove a connector whose ownership changed");
    const result = await manager.remove(owned.id);
    if (!result.removed || (await manager.list()).some(item => item.id === owned.id)) throw new Error("Could not verify owned connector removal");
  }
  if (!current) await manager.remove(owned.id);
  unlinkSync(file); return true;
}
export async function registerOwnedConnection(home: string, manager: ConnectionManager, profile: NotionProfile, callbackUrl: string, allowAutomaticTools = false) {
  const serverUrl = validateCallbackUrl(callbackUrl);
  await cleanupOwnedConnection(home, manager, profile);
  if ((await manager.list()).some(item => item.name === profile.connectorName)) throw new Error("Another connector already uses this profile's name; it will not be changed or adopted");
  const owned: OwnedConnection = { id: randomUUID(), serverUrl, name: profile.connectorName, workspaceId: profile.workspaceId, created: true };
  writePrivate(join(home, "owned-connection.json"), owned);
  try {
    const result = await manager.add({ ownedModuleId: owned.id, name: profile.connectorName, serverUrl, auth: { type: "bearer", token: profile.callbackToken }, enabledToolNames: ["codex_tool_inventory", "codex_tool_call"], runReadToolsAutomatically: true, runWriteToolsAutomatically: allowAutomaticTools });
    if (result.id !== owned.id) throw new Error("Created connector did not retain its owned identifier");
  } catch (error) {
    // The write may have succeeded despite a lost response. Never repeat creation.
    try { await manager.remove(owned.id); await cleanupOwnedConnection(home, manager, profile); } catch { /* Durable exact-ID record is retained for explicit cleanup. */ }
    throw error;
  }
  const current = (await manager.list()).find(item => item.id === owned.id);
  if (!current || current.serverUrl !== serverUrl || current.runWriteToolsAutomatically !== allowAutomaticTools) {
    await cleanupOwnedConnection(home, manager, profile); throw new Error("Owned connector policy verification failed");
  }
  return { remove: () => cleanupOwnedConnection(home, manager, profile) };
}

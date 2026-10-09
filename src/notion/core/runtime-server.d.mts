import type { Server } from "node:http";
import type { DirectNotionBackend } from "../backend";
export interface ServerConfig { apiHost: string; apiPort: number; mcpHost: string; mcpPort: number; apiKey: string; mcpToken: string; notionModel: string; reasoningEffort?: string; connectorName: string; timeoutMs: number; toolsEnabled: boolean; debug?: boolean; startupFence?: boolean }
export interface RuntimeServers { codex: Server; mcp: Server; ready: Promise<unknown>; close(): Promise<void>; beginShutdown(): void; markReady(): void; bridge: { broker: { close(): void } } }
export function startServers(options: { config: ServerConfig; notion: DirectNotionBackend }): RuntimeServers;

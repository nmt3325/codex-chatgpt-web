import type { Server } from "node:http";
import type { DirectNotionBackend } from "../backend";
export interface ModelRegistry { list(): Array<{ slug: string; displayName?: string }>; resolve(requested: unknown, requestedEffort?: unknown): { slug: string; modelId: string; reasoningEffort?: string } }
export interface ServerConfig { apiHost: string; apiPort: number; mcpHost: string; mcpPort: number; apiKey: string; mcpToken: string; notionModel: string; reasoningEffort?: string; models?: ModelRegistry; connectorName: string; timeoutMs: number; toolsEnabled: boolean; debug?: boolean; startupFence?: boolean }
export interface RuntimeServers { codex: Server; mcp: Server; ready: Promise<unknown>; close(): Promise<void>; beginShutdown(): void; markReady(): void; bridge: { broker: { close(): void } } }
export function startServers(options: { config: ServerConfig; notion: DirectNotionBackend }): RuntimeServers;

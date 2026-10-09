import type { IncomingMessage, ServerResponse } from "node:http";
export function makeMcpHandler(broker: unknown, token: string): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
export function readJson(request: IncomingMessage, maxBytes?: number): Promise<any>;
export function authenticate(request: IncomingMessage, token: string): boolean;

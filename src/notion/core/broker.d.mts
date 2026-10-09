export class TurnBroker { constructor(options?: Record<string, unknown>); turns: Map<string, any>; start(tools: unknown[]): any; inventory(token: string, query?: string, offset?: number, limit?: number): any; invoke(token: string, name: string, args?: unknown, input?: string, options?: Record<string, unknown>): Promise<any>; close(): void; }
export function decodeTools(tools: unknown[]): any[];

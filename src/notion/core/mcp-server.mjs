import { timingSafeEqual } from 'node:crypto';
import { requestError } from './errors.mjs';
const own = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const json = (res, status, object, extra = {}) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extra }); res.end(JSON.stringify(object));
};
export function authenticate(req, expected) {
  if (!expected) return false;
  const supplied = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1] || '';
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function readJson(req, maxBytes = 1_000_000) {
  let total = 0; const chunks = [];
  for await (const chunk of req) { total += chunk.length; if (total > maxBytes) throw requestError('Request body too large', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw requestError('Invalid JSON request body'); }
}
const inventorySchema = { type: 'object', properties: { turn_token: { type: 'string', minLength: 1 }, query: { type: 'string' },
  offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['turn_token'], additionalProperties: false };
const callSchema = { type: 'object', properties: { turn_token: { type: 'string', minLength: 1 }, wire_name: { type: 'string', minLength: 1 },
  arguments: { type: 'object', additionalProperties: true }, input: { type: 'string' } }, required: ['turn_token', 'wire_name'], additionalProperties: false };
const supportedProtocols = ['2025-06-18', '2025-03-26', '2024-11-05'];
export function makeMcpHandler(broker, bearerToken) {
  if (!bearerToken || bearerToken.length < 32) throw new Error('MCP_BRIDGE_TOKEN must contain 32+ characters');
  const tools = [
    { name: 'codex_tool_inventory', description: 'Discover native Codex tools, their exact wire names, descriptions, schemas and custom formats for this turn. Do not guess tools.', inputSchema: inventorySchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    { name: 'codex_tool_call', description: 'Execute an inventoried native Codex tool in the original Codex runtime. Codex approvals/sandbox still apply. For custom tools supply input; otherwise arguments.', inputSchema: callSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
  ];
  return async (req, res) => {
    if (!authenticate(req, bearerToken)) return json(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    if (req.method !== 'POST') return json(res, 405, { error: 'Stateless MCP endpoint: use POST' }, { Allow: 'POST' });
    let rpc;
    try { rpc = await readJson(req); }
    catch (error) { return json(res, error.statusCode || 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: error.message } }); }
    if (!own(rpc) || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string' ||
      (rpc.id !== undefined && rpc.id !== null && typeof rpc.id !== 'number' && typeof rpc.id !== 'string')) {
      return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC request' } });
    }
    req.mcpMethod = ['initialize', 'ping', 'tools/list', 'tools/call', 'notifications/initialized', 'resources/list', 'resources/templates/list'].includes(rpc.method) ? rpc.method : 'other';
    req.mcpTool = ['codex_tool_inventory', 'codex_tool_call'].includes(rpc.params?.name) ? rpc.params.name : undefined;
    if (rpc.id === undefined) { res.writeHead(202); res.end(); return; }
    const reply = (body, error = false) => { req.mcpToolError = error || body.isError === true; return json(res, 200, { jsonrpc: '2.0', id: rpc.id, [error ? 'error' : 'result']: body }); };
    try {
      if (rpc.params !== undefined && !own(rpc.params)) throw requestError('params must be an object');
      if (rpc.method === 'initialize') return reply({ protocolVersion: supportedProtocols.includes(rpc.params?.protocolVersion)
        ? rpc.params.protocolVersion : supportedProtocols[0], capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'codex-notion-ai', version: '0.2.0' } });
      if (rpc.method === 'ping') return reply({});
      if (rpc.method === 'tools/list') return reply({ tools });
      if (rpc.method !== 'tools/call') return reply({ code: -32601, message: `Method not found: ${rpc.method}` }, true);
      const { name, arguments: args = {} } = rpc.params || {};
      if (!own(args) || typeof args.turn_token !== 'string' || !args.turn_token) throw requestError('Tool arguments require turn_token');
      if (name === 'codex_tool_inventory') {
        const result = broker.list(args.turn_token, args);
        return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
      }
      if (name !== 'codex_tool_call') throw requestError(`Unknown MCP tool ${name}`);
      if (typeof args.wire_name !== 'string' || !args.wire_name) throw requestError('wire_name is required');
      const controller = new AbortController();
      const abort = () => { if (!res.writableEnded) controller.abort(new Error('MCP connection closed')); };
      res.once('close', abort);
      try {
        const result = await broker.invoke(args.turn_token, args.wire_name, args.arguments === undefined ? {} : args.arguments, args.input, { signal: controller.signal });
        // A native result is already MCP content: do not wrap it as JSON inside another content item.
        reply(result);
      } finally { res.removeListener('close', abort); }
    } catch (error) {
      if (rpc.method === 'tools/call') reply({ content: [{ type: 'text', text: error.message }], isError: true });
      else reply({ code: -32602, message: error.message }, true);
    }
  };
}

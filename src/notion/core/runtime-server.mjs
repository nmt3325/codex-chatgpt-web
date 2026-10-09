import http from 'node:http';
import { CodexNotionBridge } from './bridge.mjs';
import { makeMcpHandler, authenticate, readJson } from './mcp-server.mjs';
import { extractInputs, streamResponse } from './response.mjs';
import { requestError } from './errors.mjs';

function json(res, code, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data));
}
const fail = (res, status, message) => json(res, status, { error: { type: status < 500 ? 'invalid_request_error' : 'server_error', message } });
function listen(server, port, host) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(); }); });
}
export function startServers({ config, notion = null, bridge = null } = {}) {
  if (typeof config.apiKey !== 'string' || config.apiKey.length < 32) throw new Error('Responses key must be at least 32 characters');
  if (typeof config.mcpToken !== 'string' || config.mcpToken.length < 32) throw new Error('Callback key must be at least 32 characters');
  if (config.apiKey === config.mcpToken) throw new Error('Responses and callback credentials must be distinct');
  if (!notion && !bridge) throw new Error('An in-process Notion backend is required; external Notion MCP daemons are not supported');
  const backend = notion;
  const runtime = bridge || new CodexNotionBridge(backend, { model: config.notionModel, reasoningEffort: config.reasoningEffort,
    connectorName: config.connectorName, timeoutMs: config.timeoutMs });
  const mcpHandler = makeMcpHandler(runtime.broker, config.mcpToken);
  let shuttingDown = false;
  let acceptingRequests = config.startupFence !== true;
  const markReady = () => { if (!shuttingDown) acceptingRequests = true; };
  const beginShutdown = () => { shuttingDown = true; runtime.close?.(); };
  const advertisedModels = () => config.models?.list?.() || [{ slug: 'notion-ai' }];
  // Codex picks a model per request; only slugs this profile advertises may reach Notion.
  const selectModel = body => {
    if (!body || typeof body.model !== 'string' || !body.model.trim()) throw requestError('A model slug is required on this isolated endpoint');
    const requested = body.reasoning && typeof body.reasoning.effort === 'string' ? body.reasoning.effort : undefined;
    if (!config.models) {
      if (body.model !== 'notion-ai') throw requestError('Only the notion-ai model is served on this isolated endpoint');
      return { model: config.notionModel, ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}) };
    }
    let resolved;
    try { resolved = config.models.resolve(body.model, requested); }
    catch (error) { throw requestError(error.message); }
    return { model: resolved.modelId, ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}) };
  };
  const codex = http.createServer(async (req, res) => {
    try {
      if (shuttingDown) return fail(res, 503, 'Runtime is shutting down');
      const path = new URL(req.url || '/', 'http://localhost').pathname;
      if (path === '/healthz') return json(res, 200, { status: 'ok', backend: 'notion-direct', external_notion_mcp: false, native_tools: config.toolsEnabled !== false });
      if (!authenticate(req, config.apiKey)) return fail(res, 401, 'Unauthorized');
      if (req.method === 'GET' && ['/v1/models', '/models'].includes(path)) return json(res, 200,
        { object: 'list', data: advertisedModels().map(model => ({ id: model.slug, object: 'model', created: 0, owned_by: 'notion-bridge',
          ...(model.displayName ? { display_name: model.displayName } : {}) })) });
      if (req.method !== 'POST' || !['/v1/responses', '/responses'].includes(path)) return fail(res, 404, 'Not found');
      if (!acceptingRequests) return fail(res, 503, 'Runtime is still preparing its owned callback');
      const body = await readJson(req, 10_000_000);
      const selection = selectModel(body);
      if (config.toolsEnabled === false) { body.tools = []; body.tool_choice = 'none'; }
      extractInputs(body);
      const sessionId = req.headers.session_id || req.headers['x-codex-session-id'];
      if (config.debug) console.info('[bridge-responses]', JSON.stringify({ inputs: Array.isArray(body.input) ? body.input.map(item => ['message', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'tool_search_call', 'tool_search_output', 'reasoning', 'user', 'assistant', 'system', 'developer'].includes(item?.type || item?.role) ? item.type || item.role : 'other') : ['text'], has_session_id: typeof sessionId === 'string' }));
      const controller = new AbortController();
      const abort = () => { if (!res.writableEnded) controller.abort(new Error('Codex connection closed')); };
      res.once('close', abort);
      let heartbeat;
      try {
        if (body.stream === true) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write(': waiting for Notion AI\n\n');
          heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n'); }, 10_000);
          const response = await runtime.run(body, { signal: controller.signal, sessionId, ...selection });
          if (!res.destroyed) streamResponse(res, response);
        } else json(res, 200, await runtime.run(body, { signal: controller.signal, sessionId, ...selection }));
      } finally { clearInterval(heartbeat); res.removeListener('close', abort); }
    } catch (error) {
      const message = (backend?.redact?.(error) || String(error.message || 'Bridge error')).replace(/turn_[a-f0-9]+/g, '[turn]').replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '[conversation]');
      console.error('[codex-notion-web]', message);
      if (!res.headersSent) fail(res, error.statusCode || 502, message);
      else if (!res.destroyed && !res.writableEnded) {
        const response = { id: `resp_failed_${Date.now()}`, object: 'response', status: 'failed',
          error: { code: 'bridge_error', message }, output: [] };
        res.write(`event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', sequence_number: 0, response })}\n\n`);
        res.write('data: [DONE]\n\n'); res.end();
      }
    }
  });
  const mcp = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url || '/', 'http://localhost').pathname;
      if (path === '/healthz') return json(res, 200, { status: 'ok', backend: 'notion-direct', external_notion_mcp: false, native_tools: config.toolsEnabled !== false });
      if (path !== '/mcp') return json(res, 404, { error: 'Not found' });
      if (config.debug) res.once('finish', () => console.info('[bridge-mcp]', JSON.stringify({ method: req.method, rpc_method: req.mcpMethod, tool: req.mcpTool, tool_error: req.mcpToolError, status: res.statusCode })));
      await mcpHandler(req, res);
    } catch (error) { if (!res.headersSent) json(res, error.statusCode || 500, { error: error.message }); else res.end(); }
  });
  const close = async () => {
    runtime.close?.();
    await Promise.all([codex, mcp].map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
    await backend?.close?.();
  };
  const ready = Promise.all([listen(codex, config.apiPort, config.apiHost), listen(mcp, config.mcpPort, config.mcpHost)]);
  ready.catch(() => { runtime.close?.(); codex.close(); mcp.close(); });
  return { codex, mcp, bridge: runtime, ready, close, beginShutdown, markReady };
}

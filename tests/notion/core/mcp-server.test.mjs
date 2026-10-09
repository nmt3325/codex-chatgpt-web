import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { TurnBroker } from '../../../src/notion/core/broker.mjs';
import { makeMcpHandler } from '../../../src/notion/core/mcp-server.mjs';
import { responseObject, responseOutput, responseEvents, extractInputs } from '../../../src/notion/core/response.mjs';

const SECRET = 'a'.repeat(64);
const start = async broker => {
  const server = http.createServer(makeMcpHandler(broker, SECRET));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
};
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

test('MCP handshake, discovery, authorization, tool dispatch, and completion', async t => {
  const broker = new TurnBroker(); const turn = broker.start([{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }]);
  const { server, url } = await start(broker); t.after(() => server.close());
  const post = async (body, token = SECRET) => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post(rpc(1, 'initialize', {}), 'not-the-secret')).status, 401);
  const info = await (await post(rpc(1, 'initialize', {}))).json();
  assert.equal(info.result.protocolVersion, '2025-06-18');
  const list = await (await post(rpc(2, 'tools/list', {}))).json();
  assert.deepEqual(list.result.tools.map(v => v.name), ['codex_tool_inventory', 'codex_tool_call']);
  const catalog = await (await post(rpc(3, 'tools/call', { name: 'codex_tool_inventory', arguments: { turn_token: turn.token } }))).json();
  assert.equal(catalog.result.structuredContent.tools[0].wire_name, 'exec_command');
  const inFlight = post(rpc(4, 'tools/call', { name: 'codex_tool_call', arguments: { turn_token: turn.token, wire_name: 'exec_command', arguments: { cmd: 'pwd' } } }));
  await broker.wait(turn.token, 200);
  const calls = broker.take(turn.token); assert.equal(calls.length, 1);
  broker.complete(turn.token, calls[0].call_id, { content: [{ type: 'text', text: 'ok' }] });
  const result = await (await inFlight).json();
  assert.deepEqual(result.result.content, [{ type: 'text', text: 'ok' }]);
  assert.equal(result.result.structuredContent, undefined, 'Native MCP content is not double-wrapped');
});

test('Responses output shapes and SSE event completion', () => {
  const output = responseOutput('', [{ call_id: 'call_foo', tool: { kind: 'function', name: 'exec_command' }, arguments: { cmd: 'pwd' } }]);
  const response = responseObject({ model: 'notion-ai', output });
  const events = [...responseEvents(response)];
  assert.equal(events[0].type, 'response.created');
  assert.equal(events.at(-1).type, 'response.completed');
  assert.equal(events.find(x => x.type === 'response.function_call_arguments.done').arguments, '{"cmd":"pwd"}');
  assert.equal(extractInputs({ input: [{ type: 'function_call_output', call_id: 'id', output: 'ok' }] }).results.length, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnBroker, decodeTools } from '../../../src/notion/core/broker.mjs';
import { CodexNotionBridge } from '../../../src/notion/core/bridge.mjs';

const tools = [{ type: 'function', name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }];
const user = { role: 'user', content: 'Run the fixture' };
const resultFor = (call, output = 'ok') => ({ type: call.type === 'custom_tool_call' ? 'custom_tool_call_output' : 'function_call_output', call_id: call.call_id, output });
function fixture(t, commands = 2, options = {}) {
  const broker = new TurnBroker(options.brokerOptions);
  const starts = [], outputs = [], states = new Map();
  const notion = {
    async start(prompt, options) {
      const token = prompt.match(/TURN TOKEN: (turn_[a-f0-9]+)/)[1];
      const jobId = 'job-' + starts.length, state = { status: 'running' };
      starts.push({ token, options }); states.set(jobId, state);
      if (commands) (async () => {
        for (let i = 0; i < commands; i++) outputs.push(await broker.invoke(token, 'exec_command', { cmd: 'echo ' + i }));
        Object.assign(state, { status: 'completed', text: 'done' });
      })().catch(error => Object.assign(state, { status: 'failed', error: error.message }));
      else Object.assign(state, { status: 'completed', text: 'done' });
      return { jobId, conversationId: '00000000-0000-4000-8000-000000000010' };
    },
    async poll(jobId) { return states.get(jobId); },
  };
  const bridge = new CodexNotionBridge(notion, { broker, pollIntervalMs: 1, timeoutMs: 1000, ...options });
  t.after(() => bridge.close());
  return { bridge, broker, starts, outputs, notion, states };
}

test('real Codex full-history requests accept consumed results while completing new ones', async t => {
  const { bridge, starts, outputs } = fixture(t);
  const first = await bridge.run({ model: 'notion-ai', tools, input: [user] });
  const history = [user, first.output[0], resultFor(first.output[0], 'first')];
  const second = await bridge.run({ model: 'notion-ai', tools, input: history });
  history.push(second.output[0], resultFor(second.output[0], 'second'));
  const final = await bridge.run({ model: 'notion-ai', tools, input: history });
  assert.equal(final.output[0].content[0].text, 'done');
  assert.equal(starts.length, 1); assert.equal(outputs.length, 2);
});

test('retrying the same continuation returns the same cached native call without rerunning it', async t => {
  const { bridge, outputs } = fixture(t);
  const first = await bridge.run({ model: 'notion-ai', tools, input: [user] });
  const body = { model: 'notion-ai', previous_response_id: first.id, input: [resultFor(first.output[0])] };
  const second = await bridge.run(body), retry = await bridge.run({ ...body, stream: true });
  assert.equal(retry.id, second.id); assert.equal(retry.output[0].call_id, second.output[0].call_id);
  assert.equal(outputs.length, 1);
});

test('duplicate, foreign and mismatched outputs are rejected before any result is committed', async t => {
  const { bridge, broker, starts } = fixture(t);
  const first = await bridge.run({ model: 'notion-ai', tools, input: [user] });
  const good = resultFor(first.output[0]);
  for (const input of [[good, good], [good, { ...good, call_id: 'foreign' }], [{ ...good, type: 'custom_tool_call_output' }]]) {
    await assert.rejects(bridge.run({ model: 'notion-ai', previous_response_id: first.id, input }), /Duplicate|Foreign|match/);
    assert.equal(broker.get(starts[0].token).pending.size, 1);
    assert.equal(broker.get(starts[0].token).usedCallIds.size, 0);
  }
});

test('historical tool output cannot be changed while a new live result is returned', async t => {
  const { bridge, broker, starts } = fixture(t);
  const first = await bridge.run({ model: 'notion-ai', tools, input: [user] });
  const history = [user, first.output[0], resultFor(first.output[0], 'original')];
  const second = await bridge.run({ model: 'notion-ai', tools, input: history });
  await assert.rejects(bridge.run({ model: 'notion-ai', tools, input: [user, first.output[0], resultFor(first.output[0], 'altered'), second.output[0], resultFor(second.output[0])] }), /Historical tool output changed/);
  assert.equal(broker.get(starts[0].token).pending.size, 1);
});

test('new user after stateless tool history starts a new capability in the same Notion conversation', async t => {
  const { bridge, starts } = fixture(t, 1);
  const first = await bridge.run({ model: 'notion-ai', tools, input: [user] });
  const history = [user, first.output[0], resultFor(first.output[0])];
  const final = await bridge.run({ model: 'notion-ai', tools, input: history });
  history.push(final.output[0], { role: 'user', content: 'Next request' });
  const next = await bridge.run({ model: 'notion-ai', tools, input: history });
  assert.equal(next.output[0].type, 'function_call');
  assert.equal(starts.length, 2); assert.notEqual(starts[0].token, starts[1].token);
  assert.equal(starts[1].options.conversationId, '00000000-0000-4000-8000-000000000010');
});

test('completed capabilities reject inventory and late MCP calls', async t => {
  const { bridge, broker, starts } = fixture(t, 0);
  await bridge.run({ model: 'notion-ai', tools, input: [user] });
  const token = starts[0].token;
  assert.throws(() => broker.list(token), /completed/);
  assert.throws(() => broker.invoke(token, 'exec_command', {}), /completed/);
});

test('expiry removes response, call, item and cache indexes and rejects pending invocations', async t => {
  const { bridge, broker, starts } = fixture(t);
  await bridge.run({ model: 'notion-ai', tools, input: [user] });
  broker.get(starts[0].token).touchedAt = Date.now() - broker.ttlMs - 1;
  broker.sweep();
  for (const map of [bridge.responseTurns, bridge.callTurns, bridge.itemTurns, bridge.cache, bridge.resultHashes, broker.turns]) assert.equal(map.size, 0);
});

test('inventory ranges are validated and native custom formats/namespaces are preserved', () => {
  const broker = new TurnBroker();
  const format = { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' };
  const turn = broker.start([{ type: 'namespace', name: 'editor', tools: [{ type: 'custom', name: 'patch', format }] }]);
  const entry = broker.list(turn.token).tools[0];
  assert.equal(entry.wire_name, 'editor.patch'); assert.deepEqual(entry.format, format);
  for (const options of [{ offset: -1 }, { offset: 1.1 }, { limit: 0 }, { limit: -2 }, { query: {} }]) assert.throws(() => broker.list(turn.token, options), /must be/);
  assert.equal(decodeTools([{ type: 'web_search' }]).length, 0);
  broker.close();
});

test('slow upstream polling cannot block delivery of an incoming MCP native call', async t => {
  const broker = new TurnBroker(); let token;
  const notion = {
    async start(prompt) { token = prompt.match(/TURN TOKEN: (turn_[a-f0-9]+)/)[1]; setTimeout(() => broker.invoke(token, 'exec_command', { cmd: 'pwd' }).catch(() => {}), 10); return { jobId: 'slow-job' }; },
    async poll(_job, { signal }) { return new Promise((resolve, reject) => { const timer = setTimeout(() => resolve({ status: 'running' }), 1000); signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); }); },
  };
  const bridge = new CodexNotionBridge(notion, { broker, timeoutMs: 500, pollIntervalMs: 1 }); t.after(() => bridge.close());
  const started = Date.now(), response = await bridge.run({ model: 'notion-ai', tools, input: [user] });
  assert.equal(response.output[0].type, 'function_call'); assert.ok(Date.now() - started < 400);
});

test('deadline cancels the capability instead of leaking an unreachable running turn', async t => {
  const broker = new TurnBroker();
  const notion = { async start() { return { jobId: 'never' }; }, async poll() { return { status: 'running' }; } };
  const bridge = new CodexNotionBridge(notion, { broker, timeoutMs: 20, pollIntervalMs: 1 }); t.after(() => bridge.close());
  await assert.rejects(bridge.run({ model: 'notion-ai', tools, input: [user] }), error => error.statusCode === 504);
  assert.equal(broker.turns.size, 0); assert.equal(bridge.active.size, 0);
});

test('aborting an MCP caller revokes its undelivered native invocation', async () => {
  const broker = new TurnBroker(), turn = broker.start(tools), controller = new AbortController();
  const pending = broker.invoke(turn.token, 'exec_command', {}, undefined, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /disconnected/); assert.equal(broker.turns.size, 0);
});

test('unknown explicit response IDs are never silently converted to a fresh Notion chat', async t => {
  const { bridge, starts } = fixture(t, 0);
  await assert.rejects(bridge.run({ model: 'notion-ai', previous_response_id: 'missing', input: [user] }), /expired previous_response_id/);
  assert.equal(starts.length, 0);
});


test('initial retries are scoped to a Codex session and do not merge independent identical prompts', async t => {
  const {bridge,starts}=fixture(t,0),body={model:'notion-ai',tools,input:[user]};
  const first=await bridge.run(body,{sessionId:'session-a'});
  const retry=await bridge.run({...body,stream:true},{sessionId:'session-a'});
  const other=await bridge.run(body,{sessionId:'session-b'});
  assert.equal(first.id,retry.id);assert.notEqual(first.id,other.id);assert.equal(starts.length,2);
});

test('identical in-flight continuation requests share one result and conflicting requests are rejected', async t => {
  const {bridge,notion,outputs}=fixture(t,1);
  let finishPoll;
  notion.poll=async()=>new Promise(resolve=>{finishPoll=resolve;});
  const first=await bridge.run({model:'notion-ai',tools,input:[user]});
  const body={model:'notion-ai',previous_response_id:first.id,input:[resultFor(first.output[0])]};
  const one=bridge.run(body),same=bridge.run({...body,stream:true});
  await assert.rejects(bridge.run({...body,instructions:'different request'}),error=>error.statusCode===409);
  await new Promise(resolve=>setTimeout(resolve,1));
  finishPoll({status:'completed',text:'done'});
  const [a,b]=await Promise.all([one,same]);assert.equal(a.id,b.id);assert.equal(outputs.length,1);
});


test('unsupported image/file input is rejected before starting a Notion job instead of silently dropped', async t => {
  const {bridge,starts}=fixture(t,0);
  for (const content of [
    [{type:'input_image',image_url:'data:image/png;base64,aGVsbG8='}],
    [{type:'input_file',file_url:'https://example.invalid/private.pdf'}],
  ]) await assert.rejects(bridge.run({model:'notion-ai',tools,input:[{role:'user',content}]}),error=>error.statusCode===400);
  assert.equal(starts.length,0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnBroker, decodeTools } from '../../../src/notion/core/broker.mjs';
import { CodexNotionBridge } from '../../../src/notion/core/bridge.mjs';
import { responseEvents } from '../../../src/notion/core/response.mjs';

const nativeTools = [{ type: 'namespace', name: 'functions', tools: [
  { type: 'function', name: 'exec_command', description: 'Execute command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
  { type: 'custom', name: 'apply_patch', description: 'Patch', format: { type: 'text' } },
] }];

class FakeNotion {
  constructor(broker, { requestedTools = ['exec_command'] } = {}) {
    this.broker = broker; this.requests = requestedTools;
    this.done = false; this.prompt = ''; this.invokePromises = [];
  }
  async start(prompt) {
    this.prompt = prompt;
    const token = prompt.match(/TURN TOKEN: (turn_[a-f0-9]+)/)?.[1];
    assert.ok(token, 'Turn token in prompt');
    this.token = token;
    for (const name of this.requests) {
      const args = name === 'apply_patch' ? [token, name, {}, '*** Begin Patch\n*** End Patch'] : [token, name, { cmd: 'echo hi' }];
      const p = this.broker.invoke(...args).then(() => { this.done = true; });
      this.invokePromises.push(p);
    }
    return { jobId: 'job-test', conversationId: '00000000-0000-4000-8000-000000000000' };
  }
  async poll() { return this.done ? { status: 'completed', text: 'Tool execution finished.' } : { status: 'running' }; }
}

test('inventory mirrors native Codex tool schema and namespace', () => {
  const broker = new TurnBroker();
  const turn = broker.start([...nativeTools, { type: 'function', name: 'search', description: 'search', parameters: { type: 'object' } }]);
  const list = broker.list(turn.token);
  assert.deepEqual(list.tools.map(t => t.wire_name), ['exec_command', 'apply_patch', 'search']);
  assert.equal(list.tools[1].kind, 'custom');
  assert.equal(list.tools[0].parameters.properties.cmd.type, 'string');
  assert.equal(broker.list(turn.token, { query: 'Patch' }).total, 1);
  assert.throws(() => broker.invoke(turn.token, 'unknown'), /not declared/);
});

test('Codex function tool call travels through broker and resumes Notion job', async () => {
  const broker = new TurnBroker();
  const fake = new FakeNotion(broker);
  const bridge = new CodexNotionBridge(fake, { broker, pollIntervalMs: 1, timeoutMs: 3000 });
  const first = await bridge.run({ model: 'notion-ai', input: 'Show status', tools: nativeTools });
  assert.equal(first.output[0].type, 'function_call');
  assert.equal(first.output[0].name, 'exec_command');
  assert.equal(JSON.parse(first.output[0].arguments).cmd, 'echo hi');
  assert.match(fake.prompt, /Codex Native/);
  const second = await bridge.run({ model: 'notion-ai', previous_response_id: first.id,
    input: [{ type: 'function_call_output', call_id: first.output[0].call_id, output: 'hi\n' }] });
  assert.equal(second.output[0].type, 'message');
  assert.equal(second.output[0].content[0].text, 'Tool execution finished.');
  assert.deepEqual([...responseEvents(first)].at(-1).type, 'response.completed');
});

test('custom tool call stays custom (not function) and uses freeform input', async () => {
  const broker = new TurnBroker();
  const fake = new FakeNotion(broker, { requestedTools: ['apply_patch'] });
  const bridge = new CodexNotionBridge(fake, { broker, pollIntervalMs: 1, timeoutMs: 3000 });
  const first = await bridge.run({ model: 'notion-ai', input: 'Edit file', tools: nativeTools });
  assert.equal(first.output[0].type, 'custom_tool_call');
  assert.equal(first.output[0].input, '*** Begin Patch\n*** End Patch');
  const second = await bridge.run({ model: 'notion-ai', previous_response_id: first.id, input: [
    { type: 'custom_tool_call_output', call_id: first.output[0].call_id, output: 'OK' },
  ] });
  assert.equal(second.output[0].type, 'message');
});

test('parallel calls require the complete matching result batch', async () => {
  const broker = new TurnBroker();
  const fake = new FakeNotion(broker, { requestedTools: ['exec_command', 'apply_patch'] });
  const bridge = new CodexNotionBridge(fake, { broker, pollIntervalMs: 1, timeoutMs: 3000 });
  const first = await bridge.run({ model: 'notion-ai', input: 'Parallel', tools: nativeTools });
  assert.equal(first.output.length, 2);
  await assert.rejects(bridge.run({ model: 'notion-ai', previous_response_id: first.id,
    input: [{ type: 'function_call_output', call_id: first.output[0].call_id, output: 'ok' }] }), /Not all pending/);
  assert.equal(broker.get(fake.token).pending.size, 2, 'Rejected batch must be non-mutating');
  const second = await bridge.run({ model: 'notion-ai', previous_response_id: first.id, input: [
    { type: 'function_call_output', call_id: first.output[0].call_id, output: 'ok' },
    { type: 'custom_tool_call_output', call_id: first.output[1].call_id, output: 'done' },
  ] });
  assert.equal(second.output[0].type, 'message');
});

test('reject replayed results and invalid turn tokens', async () => {
  const broker = new TurnBroker(); const t = broker.start(nativeTools);
  assert.throws(() => broker.get('turn_not_real'), /Unknown/);
  const promise = broker.invoke(t.token, 'exec_command', { cmd: 'pwd' });
  const call = broker.take(t.token)[0];
  broker.complete(t.token, call.call_id, { content: [{ type: 'text', text: 'ok' }] });
  await promise;
  assert.throws(() => broker.complete(t.token, call.call_id, {}), /Unexpected/);
});

test('new user request after final starts a new capability in the same Notion thread', async () => {
  const broker = new TurnBroker();
  const previous = [];
  const fake = {
    async start(prompt, options) { previous.push({ prompt, options }); return { jobId: `job${previous.length}`, conversationId: '00000000-0000-4000-8000-000000000000' }; },
    async poll(jobId) { return { status: 'completed', text: `answer for ${jobId}` }; },
  };
  const bridge = new CodexNotionBridge(fake, { broker });
  const first = await bridge.run({ model: 'notion-ai', input: [{ role: 'user', content: 'First request' }] });
  const next = await bridge.run({ model: 'notion-ai', previous_response_id: first.id,
    input: [{ role: 'user', content: 'Second request' }] });
  assert.equal(next.output[0].content[0].text, 'answer for job2');
  assert.equal(previous[1].options.conversationId, '00000000-0000-4000-8000-000000000000');
  assert.ok(bridge.responseTurns.get(first.id));
  assert.notEqual(bridge.responseTurns.get(first.id), bridge.responseTurns.get(next.id));
});

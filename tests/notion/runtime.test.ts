import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServers } from '../../src/notion/core/runtime-server.mjs';
import { startNotionRuntime, cleanupNotionProfile } from '../../src/notion/runtime';
import { newProfile, writePrivate } from '../../src/notion/profile';
import type { DirectNotionBackend } from '../../src/notion/backend';
const workspace = '22222222-2222-4222-8222-222222222222';
test('production Responses wait for owned callback readiness; shutdown fences new requests', async () => {
  let starts = 0;
  const backend = { start: async () => { starts++; return { jobId: 'job', conversationId: '66666666-6666-4666-8666-666666666666', status: 'running' }; }, poll: async () => ({ status: 'completed', text: 'READY_OK' }), close: () => {}, redact: (error: Error) => error.message } as unknown as DirectNotionBackend;
  const servers = startServers({ config: { apiHost: '127.0.0.1', apiPort: 0, mcpHost: '127.0.0.1', mcpPort: 0, apiKey: 'a'.repeat(32), mcpToken: 'b'.repeat(32), notionModel: 'almond-croissant-low', connectorName: 'test', timeoutMs: 3000, toolsEnabled: false, startupFence: true }, notion: backend });
  try {
    await servers.ready;
    const port = (servers.codex.address() as { port: number }).port;
    const request = () => fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer '+ 'a'.repeat(32), 'content-type': 'application/json' }, body: JSON.stringify({ model: 'notion-ai', input: 'Say READY_OK' }) });
    const before = await request(); expect(before.status).toBe(503); await before.body?.cancel(); expect(starts).toBe(0);
    servers.markReady(); const ready = await request(); expect(ready.status).toBe(200); await ready.body?.cancel(); expect(starts).toBe(1);
    servers.beginShutdown(); const after = await request(); expect(after.status).toBe(503); await after.body?.cancel(); expect(starts).toBe(1);
  } finally { await servers.close(); }
});
test('pre-cancelled startup does not acquire a lock or call Notion', async () => {
  const home = mkdtempSync(join(tmpdir(), 'notion-cancel-'));
  try { await expect(startNotionRuntime({ home, noTools: true, signal: AbortSignal.abort() })).rejects.toThrow('cancelled'); expect(existsSync(join(home, 'runtime.lock'))).toBe(false); } finally { rmSync(home, { recursive: true, force: true }); }
});
test('stale-lock cleanup validates PID before probing any process', async () => {
  const home = mkdtempSync(join(tmpdir(), 'notion-pid-'));
  try {
    writePrivate(join(home, 'config.json'), newProfile(workspace)); writePrivate(join(home, 'account.json'), { token_v2: 'fixture-token' });
    for (const pid of ['0', '-1', 'not-a-pid']) { await Bun.write(join(home, 'runtime.lock'), pid); await expect(cleanupNotionProfile(home, true)).rejects.toThrow('invalid PID'); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

import { test, expect } from 'bun:test';
import { applyModelOverrides, codexModels, DEFAULT_MODEL_SLUG, modelCatalog, modelRegistry, resolveModel } from '../../src/notion/models';
import { newProfile } from '../../src/notion/profile';
import { startServers } from '../../src/notion/core/runtime-server.mjs';
import type { DirectNotionBackend } from '../../src/notion/backend';

const profile = newProfile('22222222-2222-4222-8222-222222222222');
const conversationId = '66666666-6666-4666-8666-666666666666';

test('the Codex catalog exposes the profile default plus every pickable Notion model under unique slugs', () => {
  const models = codexModels(profile);
  expect(models[0]).toMatchObject({ slug: DEFAULT_MODEL_SLUG, modelId: 'almond-croissant-low' });
  expect(new Set(models.map(model => model.slug)).size).toBe(models.length);
  expect(models.map(model => model.slug)).toEqual(expect.arrayContaining(['opus-4.7-high', 'gpt-5.4', 'opus-5', 'kimi-k3']));
  const catalog = modelCatalog(profile);
  expect(catalog.models.length).toBe(models.length);
  // Codex only renders these tiers, so richer Notion tiers never reach its catalog.
  for (const entry of catalog.models) {
    expect(typeof entry.base_instructions).toBe('string');
    const levels = entry.supported_reasoning_levels as Array<{ effort: string; description: string }>;
    for (const level of levels) {
      expect(['minimal', 'low', 'medium', 'high']).toContain(level.effort);
      expect(typeof level.description).toBe('string');
    }
    if (entry.default_reasoning_level !== null) expect(levels.map((level) => level.effort)).toContain(entry.default_reasoning_level as string);
  }
});

test('slugs, vendor names and internal model ids all resolve to one explicit Notion model', () => {
  expect(resolveModel(profile, DEFAULT_MODEL_SLUG).modelId).toBe(profile.model);
  expect(resolveModel(profile, 'opus-4.7-high').modelId).toBe('apricot-sorbet-high');
  expect(resolveModel(profile, 'GPT-5.4').modelId).toBe('oval-kumquat');
  expect(resolveModel(profile, 'agave-flan').modelId).toBe('agave-flan');
  expect(() => resolveModel(profile, 'gpt-9-turbo')).toThrow('Unknown model');
  expect(() => resolveModel(profile, '')).toThrow('model slug is required');
});

test('reasoning effort follows the Notion registry: clamped when unsupported, dropped when there is no picker', () => {
  expect(resolveModel(profile, 'gpt-5.2', 'high').reasoningEffort).toBe('high');
  // oatmeal-cookie only offers medium/high, so a minimal request lands on the nearest tier it has.
  expect(resolveModel(profile, 'gpt-5.2', 'minimal').reasoningEffort).toBe('medium');
  expect(resolveModel(profile, 'claude-opus-4.5', 'high').reasoningEffort).toBeUndefined();
  expect(() => resolveModel(profile, 'gpt-5.2', 'turbo')).toThrow('Unknown reasoningEffort');
  expect(applyModelOverrides(profile, 'opus-4.7-low')).toMatchObject({ model: 'apricot-sorbet-low' });
  expect(applyModelOverrides(profile, 'sonnet-4.6-low', 'max')).toMatchObject({ model: 'almond-croissant-low', reasoningEffort: 'max' });
  expect(() => applyModelOverrides(profile, 'not-a-model')).toThrow('Unknown Notion model');
  expect(() => applyModelOverrides(profile, 'claude-opus-4.5', 'high')).toThrow('no reasoning effort picker');
});

test('the local Responses endpoint serves every advertised slug and refuses anything else', async () => {
  const seen: Array<{ model?: string; reasoningEffort?: string }> = [];
  const backend = {
    start: async (_prompt: string, options: { model?: string; reasoningEffort?: string }) => { seen.push({ model: options.model, reasoningEffort: options.reasoningEffort }); return { jobId: 'job' + seen.length, conversationId }; },
    poll: async () => ({ status: 'completed', text: 'MODEL_OK', conversationId }),
    close: () => {}, redact: (error: Error) => error.message,
  } as unknown as DirectNotionBackend;
  const servers = startServers({ config: { apiHost: '127.0.0.1', apiPort: 0, mcpHost: '127.0.0.1', mcpPort: 0, apiKey: 'a'.repeat(32), mcpToken: 'b'.repeat(32), notionModel: profile.model, models: modelRegistry(profile), connectorName: 'test', timeoutMs: 3000, toolsEnabled: false }, notion: backend });
  try {
    await servers.ready;
    const port = (servers.codex.address() as { port: number }).port;
    const authorization = 'Bearer ' + 'a'.repeat(32);
    const call = (body: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const picked = await call({ model: 'gpt-5.2', input: 'one', reasoning: { effort: 'high' } });
    expect(picked.status).toBe(200); await picked.body?.cancel();
    expect(seen.at(-1)).toEqual({ model: 'oatmeal-cookie', reasoningEffort: 'high' });
    const fallback = await call({ model: DEFAULT_MODEL_SLUG, input: 'two' });
    expect(fallback.status).toBe(200); await fallback.body?.cancel();
    expect(seen.at(-1)).toEqual({ model: profile.model, reasoningEffort: undefined });
    const unknown = await call({ model: 'gpt-9-turbo', input: 'three' });
    expect(unknown.status).toBe(400); await unknown.body?.cancel();
    expect(seen.length).toBe(2);
    const listed = await (await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization } })).json() as { data: Array<{ id: string }> };
    expect(listed.data[0]!.id).toBe(DEFAULT_MODEL_SLUG);
    expect(listed.data.length).toBe(codexModels(profile).length);
  } finally { await servers.close(); }
});

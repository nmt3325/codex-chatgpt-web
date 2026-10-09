import catalog from "./catalog.json";
import { join } from "node:path";
import { writePrivate, type NotionProfile } from "./profile";
import { KNOWN_MODEL_IDS, MODEL_CATALOG, modelAliases, modelReasoningEfforts, normalizeKey, normalizeModelName, normalizeReasoningEffort, REASONING_EFFORTS, type ReasoningEffort } from "./client/models";

/** Reasoning tiers Codex itself understands; richer Notion tiers are clamped into these. */
const CODEX_EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high"];
const EFFORT_DESCRIPTIONS: Record<string, string> = {
  minimal: "Fastest responses with minimal reasoning",
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
};
const EFFORT_RANK = new Map<string, number>(REASONING_EFFORTS.map((effort, index) => [effort, index] as [string, number]));
const TEMPLATE = (catalog as { models: Array<Record<string, unknown>> }).models[0]!;

/** The slug that always means "the model this profile is configured to use". */
export const DEFAULT_MODEL_SLUG = "notion-ai";

export interface CodexModel { slug: string; modelId: string; displayName: string; supportedEfforts: ReasoningEffort[]; defaultEffort: ReasoningEffort | null }
export interface ModelSelection { slug: string; modelId: string; reasoningEffort?: ReasoningEffort }

function nearestEffort(supported: ReasoningEffort[], wanted: ReasoningEffort): ReasoningEffort | undefined {
  const rank = EFFORT_RANK.get(wanted) ?? 0;
  return [...supported].sort((a, b) => Math.abs((EFFORT_RANK.get(a) ?? 0) - rank) - Math.abs((EFFORT_RANK.get(b) ?? 0) - rank))[0];
}
function slugFor(displayName: string, modelId: string): string {
  const slug = normalizeKey(displayName.replace(/[()+@]/g, " "));
  return /^[a-z0-9][a-z0-9.-]*$/.test(slug) ? slug : modelId;
}
function effortsFor(modelId: string): Pick<CodexModel, "supportedEfforts" | "defaultEffort"> {
  const config = modelReasoningEfforts(modelId);
  if (!config) return { supportedEfforts: [], defaultEffort: null };
  const supportedEfforts = config.supported.filter((effort) => CODEX_EFFORTS.includes(effort));
  return { supportedEfforts, defaultEffort: supportedEfforts.includes(config.default) ? config.default : nearestEffort(supportedEfforts, config.default) ?? null };
}
function aliasModelId(value: string): string | null {
  const trimmed = value.trim();
  if (normalizeKey(trimmed) === DEFAULT_MODEL_SLUG) return null;
  return modelAliases()[normalizeKey(trimmed)] ?? (KNOWN_MODEL_IDS.includes(trimmed) ? trimmed : null);
}

/** Keeps an explicit effort inside what the Notion model registry actually accepts. */
function chooseEffort(modelId: string, requested: string | undefined): ReasoningEffort | undefined {
  if (!requested || !requested.trim()) return undefined;
  const config = modelReasoningEfforts(modelId);
  try { return normalizeReasoningEffort(modelId, requested) ?? undefined; }
  catch (error) {
    // Notion renders no effort picker for this model, so the thread config must stay untouched.
    if (!config) return undefined;
    const wanted = REASONING_EFFORTS.find((effort) => effort === normalizeKey(requested));
    const clamped = wanted ? nearestEffort(config.supported, wanted) : undefined;
    if (!clamped) throw error;
    return clamped;
  }
}

/** Every model this profile offers Codex: the configured default first, then the models Notion marks pickable. */
export function codexModels(profile: NotionProfile): CodexModel[] {
  const models: CodexModel[] = [];
  const taken = new Set<string>();
  const add = (slug: string, modelId: string, displayName: string) => {
    if (!slug || taken.has(slug)) return;
    taken.add(slug);
    models.push({ slug, modelId, displayName, ...effortsFor(modelId) });
  };
  const configured = normalizeModelName(profile.model, "almond-croissant-low");
  const known = MODEL_CATALOG.find((entry) => entry.modelId === configured);
  add(DEFAULT_MODEL_SLUG, configured, "Notion AI default: " + (known?.displayName ?? configured));
  for (const entry of MODEL_CATALOG) if (entry.pickable) add(slugFor(entry.displayName, entry.modelId), entry.modelId, entry.displayNameWithProvider);
  return models;
}

/** Resolves a Codex slug, a Notion vendor name, or an internal model ID into exactly one Notion model. */
export function resolveModel(profile: NotionProfile, requested: unknown, requestedEffort?: unknown): ModelSelection {
  if (typeof requested !== "string" || !requested.trim()) throw new Error("A model slug is required on this isolated endpoint");
  const models = codexModels(profile);
  const picked = models.find((model) => model.slug === normalizeKey(requested)) ?? models.find((model) => model.modelId === requested.trim());
  const modelId = picked?.modelId ?? aliasModelId(requested);
  if (!modelId) throw new Error('Unknown model "' + requested.trim() + '"; run notion models to list the slugs this profile serves');
  const effort = chooseEffort(modelId, typeof requestedEffort === "string" && requestedEffort.trim() ? requestedEffort : profile.reasoningEffort);
  return { slug: picked?.slug ?? modelId, modelId, ...(effort ? { reasoningEffort: effort } : {}) };
}

/** Request-time registry for the local Responses server; it never widens past this profile. */
export function modelRegistry(profile: NotionProfile) {
  return {
    list: () => codexModels(profile).map((model) => ({ slug: model.slug, displayName: model.displayName })),
    resolve: (requested: unknown, requestedEffort?: unknown) => resolveModel(profile, requested, requestedEffort),
  };
}

/** Applies CLI overrides to a loaded profile for this runtime only; the stored file is never rewritten. */
export function applyModelOverrides(profile: NotionProfile, model?: string, reasoningEffort?: string): NotionProfile {
  const next: NotionProfile = { ...profile };
  if (model && model.trim() && normalizeKey(model) !== DEFAULT_MODEL_SLUG) {
    const modelId = aliasModelId(model);
    if (!modelId) throw new Error('Unknown Notion model "' + model.trim() + '"; run notion models to list the slugs this profile serves');
    next.model = modelId;
  }
  if (reasoningEffort && reasoningEffort.trim()) {
    const effort = chooseEffort(next.model, reasoningEffort);
    if (!effort) throw new Error("Notion shows no reasoning effort picker for " + next.model + "; drop the effort or pick a model that has one");
    next.reasoningEffort = effort;
  }
  return next;
}

/** The Codex model catalog for this profile: one row per slug, with the effort tiers Codex can render. */
export function modelCatalog(profile: NotionProfile): { models: Array<Record<string, unknown>> } {
  return { models: codexModels(profile).map((model, index) => ({
    ...TEMPLATE, slug: model.slug, display_name: model.displayName, priority: index,
    description: model.slug === DEFAULT_MODEL_SLUG ? "In-process Notion AI backend; no separate Notion MCP server" : "Notion AI model " + model.modelId + " through the in-process backend",
    default_reasoning_level: model.defaultEffort ?? null,
    supported_reasoning_levels: model.supportedEfforts.map((effort) => ({ effort, description: EFFORT_DESCRIPTIONS[effort] ?? "Reasoning effort " + effort })),
  })) };
}

export function writeModelCatalog(home: string, profile: NotionProfile): string {
  const path = join(home, "models.json");
  writePrivate(path, modelCatalog(profile));
  return path;
}
export function codexConfig(profile: NotionProfile, catalog: string, port = profile.port): string {
  return `model = "notion-ai"
model_provider = "notion-web"
model_catalog_json = ${JSON.stringify(catalog)}

[model_providers.notion-web]
name = "Standalone Notion AI"
base_url = "http://127.0.0.1:${port}/v1"
env_key = "CODEX_NOTION_API_KEY"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
env_http_headers = { "x-codex-session-id" = "CODEX_NOTION_SESSION_ID" }
`;
}
export function codexArguments(catalog: string, port: number, args: string[]): string[] {
  const config = [
    'model="notion-ai"', 'model_provider="notion-web"', 'model_catalog_json=' + JSON.stringify(catalog),
    'model_providers.notion-web.name="Standalone Notion AI"', 'model_providers.notion-web.base_url="http://127.0.0.1:' + port + '/v1"',
    'model_providers.notion-web.env_key="CODEX_NOTION_API_KEY"', 'model_providers.notion-web.wire_api="responses"',
    'model_providers.notion-web.requires_openai_auth=false', 'model_providers.notion-web.request_max_retries=0',
    'model_providers.notion-web.stream_max_retries=0', 'model_providers.notion-web.env_http_headers={"x-codex-session-id"="CODEX_NOTION_SESSION_ID"}',
  ];
  return [...args, ...config.flatMap(value => ["-c", value])];
}

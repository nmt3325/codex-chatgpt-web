import catalog from "./catalog.json";
import { join } from "node:path";
import { writePrivate, type NotionProfile } from "./profile";
export function writeModelCatalog(home: string): string {
  const path = join(home, "models.json");
  writePrivate(path, catalog);
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

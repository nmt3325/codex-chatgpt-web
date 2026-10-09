# Standalone Notion AI fork

[日本語ガイド](notion-standalone.ja.md)

This fork keeps the upstream ChatGPT Web/Electron features and adds an isolated **in-process Notion backend**. You do **not** clone, build, launch, or maintain a separate `notion-ai-mcp` service. Its HTTP server, port, MCP proxy client, `.env` and sibling project are not runtime dependencies.

## Architecture

```text
Codex CLI <-> local Responses endpoint + turn broker <-> embedded Notion web-API client
                       ^                                      |
                       |                                      |
                owned MCP callback <----- HTTPS callback -----+
```

The Responses endpoint and native-tool callback live in one app process. Tool results resolve the **same pending MCP request and Notion inference**, rather than being injected as another user message. Only tools advertised by the real outer Codex request are available. Codex—not this app—enforces its native sandbox and approval rules.

**Independence does not remove Notion login, Internet access, a usable Notion AI subscription/credits, or a remotely reachable callback for native tools.** Text-only operation does not need a tunnel. `--tunnel` starts and stops this app's own `cloudflared` child; alternatively supply your own HTTPS route to the callback port. No system tunnel configuration is read or changed.

## Source quick start

Requirements: Bun **1.4.0**, Codex CLI (native transport tested with **0.161.0**), and, for managed native callbacks only, `cloudflared` on PATH. A public HTTPS reverse proxy can replace cloudflared. The unrelated Electron launcher dependencies are needed only for ChatGPT GUI development/full upstream tests, not for `bun run notion`.

```sh
git clone https://github.com/nmt3325/codex-chatgpt-web.git
cd codex-chatgpt-web
bun install --frozen-lockfile

# Export your own Notion cookies locally. Never paste cookies into chat or commit them.
bun run notion setup --cookie-file /private/path/notion-cookies.txt --workspace YOUR-WORKSPACE-UUID
bun run notion doctor

# One command owns the Responses API, native callback, tunnel, connection and Codex lifetime.
bun run notion run --tunnel -- exec --sandbox read-only "Inspect this repository"
```

Cookie imports accept Netscape exports (including HttpOnly `app.notion.com` cookies), browser-cookie JSON and Playwright storage state. Foreign domains and expired cookies are ignored. An existing local `notion-ai-mcp` account JSON can be migrated **once**, without running that server:

```sh
bun run notion setup --account-file /private/path/account.json --workspace YOUR-WORKSPACE-UUID
```

By default this creates `~/.codex-notion-web/` with directory mode 700 and secret files mode 600 on Unix. `--home PATH` selects an isolated profile; it does not touch the upstream ChatGPT home or your global Codex configuration. Windows uses the user-profile directory: Unix mode bits are not a Windows ACL guarantee, so protect its permissions yourself.

## Approval policy

Generic native calls include shell commands and file changes, so the gateway is **not** labeled read-only. Its connection has automatic write/native-tool approval **disabled by default**. Notion may stop on its confirmation UI; the app diagnoses that gate instead of treating it as a credit error or bypassing it.

For unattended native callbacks, explicitly opt in for this runtime's newly created connector:

```sh
bun run notion run --tunnel --allow-automatic-tools -- exec --sandbox read-only "Inspect this repository"
```

This permits Notion to request native tools without its separate confirmation; it does **not** remove Codex's sandbox or Codex approvals. Choosing `workspace-write` allows Codex file edits in that workspace. Do not select broader permissions than your task needs. Automatic approval is not inherited from other connectors, and no unrelated connector's settings are changed.

## Server and text-only mode

```sh
# Native callback is loopback port 17843; expose ONLY that authenticated callback.
bun run notion serve --tunnel
# Or own HTTPS proxy:
bun run notion serve --public-url https://your-callback.example/mcp

# Text-only: no tunnel, no connector creation, and Notion read-only mode.
bun run notion serve --no-tools
bun run notion run --no-tools -- exec --sandbox read-only "Explain this code without tools"

# Safe provider snippet (no secret values printed):
bun run notion config
```

Responses listen on `127.0.0.1:17842/v1`. Two independent private bearer values protect Responses and callback endpoints. `notion run` passes the Responses key and a fresh, stable per-Codex-process session header only via the child environment. Do not put keys on command lines or expose the Responses endpoint to the public tunnel.

`setup` supports `--port`, `--callback-port`, `--timeout-ms`, and `--replace` after cleanup. `--model SLUG` and `--reasoning-effort LEVEL` apply to `setup`, `serve` and `run`. `serve`/`run` support `--cloudflared PATH`; `run` supports `--codex-bin PATH`. Codex arguments belong after `--`.

## Model selection

The model is chosen per request by Codex. `notion models` lists the Codex slugs this profile serves, and `/model` inside the Codex TUI switches between them without restarting the runtime.

```sh
# List the slugs, their Notion model and the reasoning levels Codex may send.
bun run notion models
./dist/codex-notion-web models --home /path/to/profile

# Change the profile default at setup time.
bun run notion setup --cookie-file /private/path/notion-cookies.txt --workspace YOUR-WORKSPACE-UUID \
  --model gpt-5.4 --reasoning-effort high

# Override for one run only; the stored profile is not rewritten.
bun run notion run --tunnel --model opus-4.7-high -- exec --sandbox read-only "Your task"
```

- `notion-ai` always stays the first slug and means "this profile's default model". It is what Codex starts with.
- Every other slug maps to one selectable entry of the embedded Notion model registry, so the list follows the models your own account actually serves.
- `--model` and `/model` accept a slug, a Notion model id (`oatmeal-cookie`) or a built-in alias (`gpt-5.4`, `sonnet-4.6`, `thinking`, ...). `NOTION_MODEL_ALIASES` adds your own JSON alias map.
- Reasoning levels are advertised per model and restricted to the four Codex understands (`minimal`, `low`, `medium`, `high`). A level a model cannot serve is clamped to its nearest supported one; a model without a reasoning picker ignores the setting.
- An unknown slug is refused with HTTP 400 and a pointer to `notion models`, instead of silently answering with a different model.

## Build a self-contained app executable

```sh
bun run build:notion
./dist/codex-notion-web --help
./dist/codex-notion-web setup --cookie-file /private/path/notion-cookies.txt --workspace YOUR-WORKSPACE-UUID
./dist/codex-notion-web run --tunnel -- exec --sandbox read-only "Your task"
```

The compiled app embeds Bun and the Notion client: it needs neither a separately installed Bun/Node runtime nor a Notion MCP daemon. Codex and the optional cloudflared child remain external binaries. Build on each target OS; Linux verification is not a claim of a tested Windows/macOS build. The original Electron UI remains ChatGPT-specific; this new provider is exposed through the standalone command, **not** falsely advertised as a Notion option in upstream release installers.

## Lifecycle and safety

- Workspace UUID is explicit and pinned. A missing/inaccessible pin fails; no workspace rotation, creation or credit-limit failover occurs.
- Automatic web confirmation, keep-awake nudges and automatic Continue are disabled.
- Each runtime creates and owns only its native connector. The exact connection UUID is saved **before** creation, allowing cleanup even if a write response is lost. Startup does not repeat ambiguous creation writes.
- Shutdown revokes native capabilities before cleanup, removes the exact owned connection, stops its own tunnel child and closes its own listeners. It does not kill unrelated services.
- A profile lock prevents two runtimes adopting each other's connection. After a crash, use `bun run notion cleanup --stale-lock` only once the recorded process has exited. A live/reused PID is refused. Network failure retains the owned record for later cleanup.
- Native results are validated and atomically committed; full-history replay is idempotent. Expired/foreign capabilities, changed historical results and partial parallel result batches are refused.
- No hidden conversation truncation: an over-budget text request asks the caller to compact explicitly. The 64k local model budget is conservative configuration, not a verified Notion context-capacity claim.
- This is an unofficial, experimental Notion web-API integration; upstream API changes, expired cookies, credits and confirmation gates can stop it. No OpenAI API key is required for this provider.
- Text input only. Images, attachments, compaction-specific payloads and every upstream advanced/multi-agent modality are **not** asserted as supported. Unsupported input is rejected rather than silently discarded. Native tools advertised in function/namespace/custom/tool-search forms retain their wire shape; full feature-level subagent compatibility is not claimed.

## Verification

```sh
bun run typecheck
bun run test:notion
CODEX_BIN=/path/to/codex bun run smoke:notion
```

The deterministic smoke uses the **real embedded Notion client** and **real Codex CLI**, mocks only the remote Notion API, and holds real authenticated local MCP requests pending until Codex returns their results. It checks two native shell commands, actual freeform `apply_patch`, one unchanged Notion inference, and the stable session header. It does not use real Notion credentials or enable any real connector's automatic approval.

See `notion-validation.md` for the separately recorded live/compiled validation scope. The older `codex-notion-ai` bridge's live test is not presented as proof of this fork's new runtime.

Source provenance and separate license boundaries are retained in `src/notion/NOTICE.md`, `src/notion/client-sources.json` and `LICENSES/codex-notion-ai.txt`.

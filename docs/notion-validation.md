# Standalone Notion validation

Validated on Linux x64 (ct104), Bun 1.4.0, Node 22.23.3 and Codex CLI 0.161.0. These results are for this fork's Notion implementation, not the earlier external-daemon bridge.

## Automated checks

- Strict root TypeScript checking: passed, including the embedded client, CLI and smoke script.
- Focused standalone suite: **56 passed, 0 failed** across seven files. Covers isolated credentials, pinned-workspace failures, secret redaction, same-pending-call native continuation, stale/replayed turns, owned connector rollback, default approvals, startup readiness and shutdown fencing.
- Root `bun test ./tests`: **910 passed, 42 skipped, 0 failed** across 952 tests. That complete run preceded the final three additional lifecycle cases; those three are included in the separately verified 56-test suite.
- Launcher: **379 passed, 1 skipped, 0 failed**, using its documented `node --test` runner. Existing ChatGPT/Electron behavior is retained; this fork does not add a Notion GUI provider.
- `bun run build:notion` produced a Linux x64 executable; the binary help and root `notion` command dispatch work.

Use the documented runners (`bun test ./tests`, and `bun run launcher:test`). An unqualified `bun test tests` filter also discovers launcher Node tests and is not the project's supported combined runner. An initial broad run exposed README link parity, which was fixed in all four localized READMEs; no tests were disabled to obtain the documented results.

## Actual Codex plus actual embedded client; mocked remote Notion API

`bun run smoke:notion` runs the real Codex CLI, the real embedded `NotionClient`, and the authenticated local MCP callback. Only the remote Notion API is mocked; no `notion-ai-mcp` service is started.

Verified:

- Exactly one direct inference request.
- `printf`, `pwd`, and a real custom/freeform `apply_patch` call: three native results.
- Native results resolve the **same pending MCP callback**, not a synthetic user turn.
- Created `standalone-result.txt` with `STANDALONE_PATCH_OK` in the isolated mock fixture.
- Stable per-process Codex session header and final `STANDALONE_NATIVE_OK`.

This proves Codex/native protocol integration. It is **not** a claim that live Notion approved native writes.

## Live Notion: no external Notion MCP process

Using a separate private profile and an explicitly pinned workspace:

- Account authentication and exact workspace match succeeded.
- Text-only `/v1/responses` returned HTTP 200 and `LIVE_STANDALONE_OK`.
- The earlier external MCP port was absent throughout the test.
- Managed `cloudflared` quick-tunnel startup and direct Notion connector registration succeeded.
- The newly owned connector's automatic write/native-call policy remained **false**. No live native command was submitted.
- Normal shutdown removed its owned connector ledger, closed both listeners, stopped its owned tunnel, and removed its runtime lock.

Private authentication data, workspace/connection IDs, temporary callback URLs and raw browser/API logs are deliberately excluded from this repository.

## Compiled binary independent of the source tree

The freshly compiled executable was started from a temporary directory outside the repository, with `PATH=/nonexistent` (no Bun or Node in PATH):

- Private setup and real Notion authentication succeeded.
- Text-only serving returned HTTP 200 and `LIVE_COMPILED_STANDALONE_OK`.
- SIGTERM caused exit 0, removed the runtime lock and closed the owned listener.

The compiled app does not require Bun, Node, a sibling `notion-ai-mcp` checkout, or a separate Notion MCP daemon. Native work still needs the Codex CLI and a reachable HTTPS callback; managed quick tunnels additionally need `cloudflared`.

## Limits and safety

- Native tool auto-approval is **off by default**. `--allow-automatic-tools` is a per-runtime explicit opt-in for the newly owned connector only; Codex sandbox and approvals still apply.
- Real Notion native write/apply-patch execution was **not tested in this fork**. The previous project's one-test approval was not reused.
- Text inputs and dynamic native tools are supported. Images/files and unsupported compaction/advanced input items fail explicitly. Full opaque compaction/reasoning envelopes and desktop Notion UI integration are not claimed.
- The 64k model catalog window is a conservative local setting, not a verified Notion capacity guarantee.
- Live auth/model availability and AI credits are still required. This uses unofficial Notion web interfaces and may break when they change.
- If a process is killed or remote cleanup fails, retain the private owned record and use `notion cleanup --stale-lock`. Cleanup never adopts or changes another connector.
- Windows/macOS binaries and full upstream desktop packaging were not validated for the new Notion command.

## Hosted native CI environment

The first hosted Ubuntu-latest smoke failed with `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`, before the fixture command could execute. The dedicated workflow selects a compatible Ubuntu 22.04 hosted VM instead. It does **not** disable Codex sandbox/approvals, grant automatic Notion access, enable native network access, or modify kernel/AppArmor settings to bypass that restriction. The smoke still requires all three actual native results and the real patch file. Failure diagnostics contain only the mocked isolated fixture and are redacted.

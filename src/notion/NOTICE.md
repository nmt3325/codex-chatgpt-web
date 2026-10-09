# Integrated Notion implementation

This fork embeds the project author’s Notion client sources from `nmt3325/notion-ai-mcp` 0.8.0, rather than its MCP server. Only the twelve local client dependencies are included; no server entrypoint, external service URL, or sibling-repository dependency is included.

The native bridge core is adapted from `nmt3325/codex-notion-ai` commit `bc90166` (MIT). The original upstream `miuuyy/codex-chatgpt-web` license and notices remain unchanged.

Client source provenance is recorded in `client-sources.json`. The embedded client additionally forwards the owned turn abort signal to the inference HTTP request, refuses missing pinned workspaces, and accepts a pre-persisted caller-owned connector UUID for cleanup after ambiguous writes. Other standalone changes remain in the surrounding modules. The source project supplies no LICENSE file; this notice does not assert an MIT license for that subtree. The root MIT license and the separately retained bridge MIT license are not replaced.

---
"@bunvex/cli": patch
---

`bunvex env list --include-values` prints the values explicitly; it conflicts with `--names-only`. When an AI agent runs `bunvex env list` (detected from the variables agents set, or `BUNVEX_AGENT_MODE`), it lists names only, with a note on stderr, unless `--include-values` is passed. The MCP `envList` tool returns names only unless `includeValues` is true, and then each name and value.

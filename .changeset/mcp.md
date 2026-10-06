---
"@bunvex/cli": minor
"@bunvex/server": patch
---

`bunvex mcp start`: a Model Context Protocol server for AI tools, as Convex's `npx convex mcp start`, over stdio with the official MCP SDK. Tools: `status`, `data`, `tables`, `functionSpec`, `run`, `envList`, `envGet`, `envSet`, `envRemove`, `runOneoffQuery`, `logs`. A self-hosted deployment is production for its guards (`--cautiously-allow-production-pii`, `--dangerously-enable-production-deployments`). The server gains `_system/frontend/getSchemas` (STUDY-121).

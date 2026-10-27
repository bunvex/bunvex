---
"@bunvex/server": patch
---

Log line limits by kind, as Convex's: an action (V8, HTTP or `"use node"`) keeps 1024 lines and a query or mutation 256, the last of them the overflow notice ("Log overflow (maximum N). Remaining log lines omitted."). An action's streamed lines stop at its limit too. The limits are Convex's knobs: `MAX_LOG_LINES_V8_ACTIONS`, `MAX_LOG_LINES_NODE_ACTIONS` and `MAX_LOG_LINES_DATABASE_UDFS`.

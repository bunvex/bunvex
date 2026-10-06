---
"@bunvex/cli": patch
---

`typecheck`, `mcp` and `deployment` print argument errors as Convex's CLI does: `error: …` on stderr, commander's messages and "Did you mean …?" suggestions, and exit code 1 (it was 2).

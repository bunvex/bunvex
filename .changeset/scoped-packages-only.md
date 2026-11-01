---
"@bunvex/server": patch
"@bunvex/cli": patch
---

Only the scoped `@bunvex/*` packages exist (npm refuses the name `bunvex`): a pushed module's `@bunvex/server` and `@bunvex/values` are linked to the server's own, and `bunvex/server` or `bunvex/values` no longer are; `bunvex codegen` always writes `@bunvex/*` imports.

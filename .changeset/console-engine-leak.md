---
"@bunvex/core": patch
"@bunvex/persistence": patch
"@bunvex/server": patch
---

Security: `console.log(ctx.db)`, `console.log(ctx)`, a query object or `ctx.db.system` no longer prints the engine's state into the log lines sent to the caller, the function log and the log streams (the catalog, the store, other transactions' writes, ~32 KB a line). Engine objects now print as their name, `Tx {…}`, under object-inspect, `util.inspect` and `Bun.inspect`; app values print as before (DV-321).

---
"@bunvex/server": patch
"@bunvex/core": patch
"@bunvex/values": patch
---

`BUNVEX_FUNCTION_SANDBOX=process` (with `BUNVEX_FUNCTION_SANDBOX_ISOLATION=none`, no OS isolation yet) runs pushed queries and mutations in a separate process, each `ctx` operation on the server's transaction (STUDY-171 §8); actions, HTTP actions, components and rooms say they are not available there yet. Under the default `vm`: `process.env` no longer reads `Object.prototype` names (`process.env.constructor` is unset, as Convex's), a commit timestamp placeholder in a function's scheduled arguments is refused, as Convex refuses it, and a cached query result expires after 17 s only when the query read the time (app metrics no longer read the deterministic clock inside every query).

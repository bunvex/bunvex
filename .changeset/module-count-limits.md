---
"@bunvex/server": patch
---

A push with more than 4096 function files fails with Convex's message, "Too many function files (N > maximum 4096) in "bunvex/".". Files under `_deps/` still do not count, but a push may hold at most 8192 modules in all, as in Convex. A push that fails unexpectedly now answers 500 `InternalServerError`, as Convex's, and logs the cause.

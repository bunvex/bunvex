---
"@bunvex/server": patch
---

A push with `node.nodeVersion` "20" is refused, as on Convex now that Node 20 is end-of-life: a 400 `InvalidConfig` "Node 20 is no longer supported. Upgrade to a newer Node version." on `start_push`, `evaluate_push` and `evaluate_schema`, like "18". "22" and "24" are accepted. Code pushed with "20" before keeps running.

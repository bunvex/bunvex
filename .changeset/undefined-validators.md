---
"@bunvex/values": patch
---

The validator builders check their arguments as Convex's do, in its order and words. `v.object`, `v.array`, `v.record` and `v.union` given `undefined` (usually a circular import) throw "A validator is undefined … This is often caused by circular imports." when called. `v.literal` takes only a string, number, bigint or boolean, and `v.id` only a string table name. The non-validator messages are Convex's.

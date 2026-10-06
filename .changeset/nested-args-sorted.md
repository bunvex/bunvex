---
"@bunvex/server": patch
---

A nested call's arguments (`runQuery`, `runMutation` and `runAction` from a query, a mutation or an action) reach the callee as Convex's do: a copy with each object's fields sorted and no `undefined` field. The callee got the caller's own object, so changing it changed the caller's, and its fields kept their order.

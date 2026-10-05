---
"@bunvex/server": patch
"@bunvex/core": patch
---

`_system/` functions can be called only by an admin or the system acting as itself, as in Convex. Anyone else gets 403 `SystemIdentityRequired`, "Operation query|mutation|action not permitted", before the function is looked up. This includes an admin acting as a user, a user, a caller with no key, and function code an action runs for one of them.

The check covers the HTTP API and sync, an action's or HTTP action's `runQuery`/`runMutation`/`runAction`, and a query's or mutation's nested call. `/api/run/_system/…` and scheduling a system function get "Operation get_module not permitted". Before this, function code could call any `_system/` query or mutation.

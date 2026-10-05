---
"@bunvex/server": patch
"@bunvex/core": patch
---

`_system/` functions now behave as in Convex's local backend, checked entry point by entry point. Before this, function code could call any `_system/` query or mutation.

Only an admin or the system acting as itself reaches them. Everyone else, an admin acting as a user included, is refused before the function is looked up:

- `/api/query`, `/api/mutation` and sync: the function's error, "Operation query|mutation not permitted".
- `/api/action`: 403 `SystemIdentityRequired`.
- `/api/run/_system/…` and scheduling: "Operation get_module not permitted".
- A nested `ctx.runQuery` / `ctx.runMutation`: "Could not find public function".

For an admin:

- A missing system function gets Convex's module messages.
- `/api/run` and `/api/function` answer "Could not find function".
- `/api/action` answers 500.
- A nested call runs.

An action's `runQuery` / `runMutation` / `runAction` never resolves a system function, whoever runs the action: "Couldn't resolve api._system.…".

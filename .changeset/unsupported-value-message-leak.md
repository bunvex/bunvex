---
"@bunvex/values": patch
---

Security: an error about a value that is not a supported value type no longer serialises class instances. Returning, writing or passing a query object, `ctx.db`, `ctx` or any class instance used to put its JSON in the message — for the engine's objects, the transaction with the catalog, the store's state and recent writes — and that message reaches the client. A class instance, `Map`, `Set`, `Date` or function context now prints as `Name {…}` (no field read, no `toJSON` or getter run), a cycle as `"[Circular]"`, and the walk stops at the message's 16 KiB limit. Plain data prints exactly as before. Validator messages (`displayValue`) follow the same rule.

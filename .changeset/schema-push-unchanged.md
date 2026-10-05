---
"@bunvex/core": patch
---

A push of the schema already active returns the active schema's id instead of a new pending schema, and a push of the pending schema returns that one, as Convex's `submit_pending`. Schemas compare as Convex's `DatabaseSchema` does: tables, indexes and object fields by name, not declaration order.

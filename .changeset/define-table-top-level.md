---
"@bunvex/core": patch
"@bunvex/server": patch
---

`defineTable` no longer refuses a validator a table cannot have when it is called, as Convex's. A push refuses it: one that is not an object, a union of objects or `v.any()` gives `InvalidTopLevelTypeInSchemaError` with Convex's message, and one whose JSON is not an object gives `InvalidSchemaExport`.

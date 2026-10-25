---
"@bunvex/server": patch
---

A CSV import drops an empty cell in a field the active schema has optional at the top level (in any member of a union, `v.optional(v.string())` included), as Convex's. A required field, and a table outside the schema, keep `""`. Before, a CSV with a blank optional number failed schema validation.

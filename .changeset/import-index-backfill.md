---
"@bunvex/core": patch
"@bunvex/server": patch
---

An import's hidden table copies the enabled indexes of the table it replaces as Convex's `create_empty_table` does: each copy starts `Backfilling`, the table is backfilled and the copies enabled before the import writes into it. Staged indexes are not copied, and a table still backfilling an index cannot be replaced (Convex's `InvalidImport`).

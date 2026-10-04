---
"@bunvex/server": patch
"@bunvex/cli": patch
---

A push answers its index changes as Convex's: `start_push`'s `schemaChange.indexDiffs` (a dry run's too) and `finish_push`'s `indexDiff` list each added, removed, enabled and re-staged index with its definition, not just its name. `bunvex deploy` prints them as Convex's CLI does: "Added table indexes:", "Added staged table indexes:", "Deleted table indexes:", "These indexes are now enabled:", "These indexes are now staged:", or "Would …" on a dry run, each index as `table.index   fields`.

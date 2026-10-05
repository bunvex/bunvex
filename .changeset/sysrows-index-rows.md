---
"@bunvex/core": patch
---

`_index` rows of database indexes and `_index_backfills` rows as Convex's (STUDY-134): `config: {type: "database", fields, onDiskState, persistenceIndexId}` with Convex's states (`Backfilling`, `Backfilled2`, `Enabled`), `by_id`'s fields empty, int64 counts and nanosecond timestamps. A user index is backfilled even on a table the same schema change creates, and its `_index_backfills` row is kept, as Convex's; a search or vector index's backfill has one too.

---
"@bunvex/core": patch
---

`db.query(table).count()`, Convex's internal count (not in the public types, as Convex's): the table's documents at the transaction's snapshot with its own writes, on the query initializer only, and on `db.system.query` for `_storage` and `_scheduled_functions`. While the table summaries are built it fails with Convex's `TableSummariesUnavailable`, now a system error (uncatchable, HTTP 503, a sync query retried), for the `tableSize` system functions too.

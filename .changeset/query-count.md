---
"@bunvex/core": patch
---

`db.query(table).count()`, Convex's internal count (not in the public types, as Convex's): the table's documents at the transaction's snapshot with its own writes, on the query initializer only, for the transaction's whole life. `db.system.query` takes any system table, as Convex's: `_storage` and `_scheduled_functions` as before, and any other `_` name reads as empty while its `count()` counts its rows (0 for an unknown name). While the table summaries are built `count()` fails with Convex's `TableSummariesUnavailable`, now a system error (uncatchable, HTTP 503, a sync query retried), for the `tableSize` system functions too.

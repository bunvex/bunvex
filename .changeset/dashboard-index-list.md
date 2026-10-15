---
"@bunvex/core": patch
"@bunvex/server": patch
---

`_system/frontend/indexes` and `GET /api/get_indexes` report a search or vector index's real state (backfilling, backfilled when staged and built, done), as Convex's, instead of "backfilling" for good: bunvex keeps those indexes' `_index` rows backfilling (DV-415), so the state comes from the engine, and a finished build writes the index's `_index_backfills` row so a subscription to the list hears it. The dashboard's index list shows search, vector and staged indexes as Convex's.

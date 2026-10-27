---
"@bunvex/core": patch
---

An index backfill that resumes after a restart goes on after its cursor at a fresh snapshot, as Convex's does now: it keeps its count, and its `_index_backfills` row's `snapshotTs` names the new scan. Before, a backfill whose checkpoint's snapshot had passed retention walked the whole table again. A backfill with no cursor yet still starts from the beginning.

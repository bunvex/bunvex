---
"@bunvex/core": minor
"@bunvex/server": minor
---

Deleting a file removes its `_storage` row only, as Convex (STUDY-130): the blob stays in the store, so an export or a download that read the file at an earlier snapshot still finds it. bunvex's own `_storage_deletions` table, the post-commit blob removal and the hourly orphan sweep are gone (`STORAGE_DELETIONS_TABLE`, `FileStorage.sweepDeleted`, `sweepOrphans` and `startFileSweeps` removed). Disk use is no longer reclaimed (DV-150 reversed).

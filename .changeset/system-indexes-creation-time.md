---
"@bunvex/core": patch
---

System indexes are declared as Convex's: the ones in Convex's `SYSTEM_INDEXES_WITHOUT_CREATION_TIME` (`_file_storage.by_storage_id`, the scheduler's, crons', modules', environment variables', …) have no `_creationTime` suffix, and every other system index ends with it once (some had it twice). User indexes keep the implicit `_creationTime`.

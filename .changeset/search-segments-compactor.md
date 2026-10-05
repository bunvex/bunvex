---
"@bunvex/core": minor
"@bunvex/search": minor
---

Search and vector segments are compacted as Convex's (STUDY-111): three to ten small segments merged smallest first, large ones the same way, a large segment more than 20 % deleted rewritten, empty ones dropped (`MIN_COMPACTION_SEGMENTS`, `MAX_COMPACTION_SEGMENTS`, `MAX_SEGMENT_DELETED_PERCENTAGE`, `SEGMENT_MAX_SIZE_BYTES`). `TextSegment.merge` and `VectorSegment.merge` merge segments in place, pausing between chunks; deletes that land meanwhile are carried into the merged segment. `prepareCompaction` is now async.

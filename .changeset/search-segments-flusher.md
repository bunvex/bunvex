---
"@bunvex/core": minor
"@bunvex/search": patch
"@bunvex/server": patch
---

Search and vector indexes are persisted as segments in the `search` blob store (STUDY-111): a memory part over its soft limit (`SEARCH_INDEX_SIZE_SOFT_LIMIT`, 10 MiB; `VECTOR_INDEX_SIZE_SOFT_LIMIT`, 30 MiB) is flushed into a new segment, a new index is stored as a segment before it is ready, and a clean shutdown flushes every index. A start loads the segments and replays only the writes since, crash or not, instead of reading the tables; a state it cannot trust (another definition, outside retention, a missing blob) is not used. No search blob is ever deleted, as Convex's. The clean-shutdown snapshot (STUDY-96) is no longer written; one already written is still read for an index with no segments.

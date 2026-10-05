---
"@bunvex/core": minor
"@bunvex/server": patch
---

Writes are refused while a ready search or vector index has 100 MiB unflushed (`SEARCH_INDEX_SIZE_HARD_LIMIT`, `VECTOR_INDEX_SIZE_HARD_LIMIT`), as Convex's overloaded `TextIndexTooLarge` / `VectorIndexTooLarge`: HTTP 503 with the code, the sync session closed with 1013, a scheduled job retried, a plain `Error` in an action. The refusal wakes the flusher (STUDY-111, DV-228 resolved).

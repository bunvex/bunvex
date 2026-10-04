---
"@bunvex/core": minor
"@bunvex/server": minor
---

While search and vector indexes are rebuilt after a start, searches get Convex's bootstrapping answer instead of `IndexBackfillingError`: `SearchIndexesUnavailable` ("Search indexes bootstrapping and not yet available for use") or `VectorIndexesUnavailable`, a system error a query or mutation cannot catch (HTTP 503 with its code), a plain `Error` in an action. Over the sync protocol a query that hits it is skipped and run again after `SEARCH_INDEXES_UNAVAILABLE_RETRY_DELAY` (3 s); a mutation closes the session with 1013 and the code; a scheduled mutation runs later. An empty search string finds nothing in every index state. A new index a push adds still answers `IndexBackfillingError` (STUDY-79).

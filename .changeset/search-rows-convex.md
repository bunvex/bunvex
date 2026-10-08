---
"@bunvex/core": patch
---

Search and vector indexes' `_index` rows are written as the Convex binary reads them (STUDY-133 PR 9): always `backfilling`, every integer an Int64, so Convex opens a bunvex store and builds those indexes itself; bunvex keeps its segments in the `search_index_segments` global (DV-415). A store from before is migrated at its first start.

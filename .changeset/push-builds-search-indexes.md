---
"@bunvex/core": patch
---

A schema push builds its new search and vector indexes before it finishes, as Convex's does. Their `_index` rows are written, backfilling, in the push's first commit. The push stays in progress until the indexes are built, and its commit enables them as built. A search or vector search right after `deploy` now finds every document instead of failing with `IndexBackfillingError`.

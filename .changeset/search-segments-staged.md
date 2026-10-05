---
"@bunvex/core": minor
---

Staged search and vector indexes are built in the background and kept `Backfilled { staged }`, as Convex's: searches answer `IndexStagedError` meanwhile, and a push that un-stages one enables it at once, without rebuilding it (STUDY-111).

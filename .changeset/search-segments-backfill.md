---
"@bunvex/core": minor
"@bunvex/search": patch
---

A new search or vector index is built as Convex's paged backfill (STUDY-111): a segment per step of the table read at a fresh ts, the earlier pages' changes taken from the document log, the cursor stored so a restart resumes the build (answering `IndexBackfillingError` meanwhile, as Convex). The memory part stays small while the table is read.

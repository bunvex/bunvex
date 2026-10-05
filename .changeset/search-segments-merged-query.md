---
"@bunvex/search": minor
"@bunvex/core": patch
"@bunvex/server": patch
---

Text and vector indexes are segments plus a memory part (STUDY-111): `SegmentedTextIndex` and `SegmentedVectorIndex` search their segments and memory part together with the statistics of the whole index, so their answers are the single in-memory index's, scores bit for bit; they flush the memory part into a segment and compact segments. The engine keeps every index in its memory part until the flusher arrives. Vector results with NaN scores are now ordered by internal id among themselves, as Convex's, rather than by how the index was built.

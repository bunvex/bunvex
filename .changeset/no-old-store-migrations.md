---
"@bunvex/core": patch
---

A start no longer migrates search state from older bunvex stores: a store with no `search_index_segments` global
keeps no state from its `_index` rows (the indexes are built again from their tables), and an
`_index_worker_metadata` row keyed by the index's document id instead of its internal id is not read
(STUDY-139 P6).

---
"@bunvex/search": minor
---

The persisted segment formats of text and vector indexes (STUDY-111): `TextSegment` (documents sorted by id, terms and posting lists, a forward index) and `VectorSegment` (normalized f32 vectors), each read in place from its bytes, and their deletes (`TextSegmentDeletes`, keeping the deleted documents' statistics; `VectorSegmentDeletes`). Not used by the engine yet.

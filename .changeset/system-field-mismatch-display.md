---
"@bunvex/core": patch
---

A written `_id` or `_creationTime` that is not the document's is reported in Convex's display (STUDY-161 §4): `'_id' field 1.0`, and the creation time's message shows the value being written with its `_id` (`{_creationTime: 1.0, _id: "…", k: 1.0}`) rather than the written fields as JSON; an int64 `_creationTime` no longer fails to serialize.

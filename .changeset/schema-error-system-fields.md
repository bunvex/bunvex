---
"@bunvex/core": patch
---

A schema error's document and validator no longer show `_id` and `_creationTime` (`Object: {}`, `Validator: v.object({name: v.string()})`), as Convex's backend: the document is checked without its system fields against the schema's own validator (STUDY-161 §3).

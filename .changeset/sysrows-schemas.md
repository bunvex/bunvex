---
"@bunvex/core": patch
"@bunvex/server": patch
---

`_schemas` rows as Convex writes them (STUDY-134, DV-423): `state` is an object (`{ state: "active" }`, `{ state: "failed", error, table_name }`, …), and `schema` is the text of Convex's `DatabaseSchemaJson` — tables and indexes by name, `_creationTime` at the end of each index's fields, every index list present, `vectorIndexes`' legacy `dimension: null`, `stagedDocumentType: null` without one, object fields by name, a table's top-level system fields left out and float literals as serde_json writes them. The deployment audit log's `schemaDiff` and the push's `evaluate_schema` answer carry the same JSON.

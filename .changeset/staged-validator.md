---
"@bunvex/core": patch
"@bunvex/server": patch
---

`defineTable(...).staged(validator)`, as Convex's: the table's next document validator (an object of fields or a validator), serialized as `stagedDocumentType` and stored with the schema, so a change to it alone is a new schema version. A second call throws; a staged validator that is not an object, a union of objects or `v.any()` fails the push with `InvalidTopLevelTypeInSchemaError`. As on Convex, nothing checks documents against it, and the document type is unchanged. `TableDefinition`'s list of staged index names is now `stagedIndexes`.

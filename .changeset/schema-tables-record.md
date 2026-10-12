---
"@bunvex/core": patch
"@bunvex/server": patch
---

`schema.tables` is Convex's record of table definitions (`schema.tables.messages.validator`, `docValidator("messages", schema.tables.messages)`), the schema's own fields are Convex's (`tables`, `strictTableNameTypes`, `schemaValidation`), and a table definition has Convex's experimental `" indexes"()`. The engine reads `declaredTables(schema)`.

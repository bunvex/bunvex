---
"@bunvex/core": minor
"@bunvex/server": patch
---

A pending schema's validation is persisted as Convex's (STUDY-127): `_schema_validations` holds one attempt per walked table (`pending` → `valid`), and `_schema_validation_progress` its counters, flushed every 5 % of the table or 500 documents. A failed, overwritten or activated schema's attempts are deleted. A start deletes every attempt and walks a still-pending schema again (before, it stayed `pending`). The dashboard's `_system/frontend/getSchemas:schemaValidationProgress` reads them.

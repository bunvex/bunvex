---
"@bunvex/server": patch
---

A schema file whose default export is not a schema fails the push (and `evaluate_schema`) with Convex's `InvalidSchemaExport`, and one with no default export (or `null` / `undefined`) with Convex's `MissingSchemaExportError`, instead of `InvalidSchema`.

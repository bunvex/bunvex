---
"@bunvex/core": patch
"@bunvex/server": patch
---

`evaluate_schema` reports staged validators as Convex's: each table's staged validation state and progress (`staged`), whether the active schema's staged validation, once valid, would spare the push the table's walk (`canSkipAfterStagedValidation`), and the pending or valid staged validations the push would throw away (`discardedStagedValidators`, `replaced` when it stages another validator). The dashboard's `getSchemas:stagedSchemaValidationProgress` lists the active schema's staged validations (DV-438, STUDY-106 §7).

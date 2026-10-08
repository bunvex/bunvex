---
"@bunvex/core": patch
"@bunvex/server": patch
---

Staged validators get their `_schema_validations` rows, as Convex's: one per table with a `.staged()` validator, with its `validatorHash` (the sha256 of the validator's text, equal to Convex's), made by the push, carried over from the outgoing schemas when it can be reused, kept when the schema becomes active, and retried by a push of the same schema; at a start the active schema's staged rows start over as `pending`. A push that stages a validator on a table whose enforced validator change needs its documents walked is refused with Convex's 400 `StagedSchemaWithEnforcedValidatorChanges` (`start_push`, dry run too, and `evaluate_push`) (DV-438, STUDY-106 §7).

---
"@bunvex/core": patch
"@bunvex/server": patch
---

A staged validator its validation proved now stands in for the walk, as Convex's: pushing an enforced validator that accepts everything a `valid` staged validator of the active schema accepts needs no walk (`supersetOfStagedValidated` in `evaluate_schema`), and passes the `StagedSchemaWithEnforcedValidatorChanges` check. Deleting or replacing a table a staged validator points to with `v.id` fails that staged validation ("Table … is referenced by the staged validator for … but was deleted or replaced; redeploy to revalidate …") (DV-438, STUDY-106 §7.4).

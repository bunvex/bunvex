---
"@bunvex/core": patch
---

Writes are checked against staged validators, as Convex's: every insert or replace into a table with a `.staged()` validator, in the active schema or a push still in flight, is checked against it (whatever `schemaValidation` says); a write it refuses still succeeds and fails the table's staged validation in the same transaction, with Convex's `New document in table "<t>" does not match the schema: …`. Validation rows are no longer reset at a start (DV-438, STUDY-106 §7.2).

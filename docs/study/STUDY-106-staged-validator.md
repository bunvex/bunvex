# STUDY-106 — `TableDefinition.staged(validator)`

- **Status:** implemented at 4577b9031; **revisited 2026-10-08 (§7)**: Convex now validates staged validators (DV-438, to be built). §1–§3 describe 4577b9031; where §7 disagrees, §7 is current.
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-05; origin/main 7236c10, 2026-10-08 (§7)
- **Related:** [STUDY-14](STUDY-14-schemas.md) (schemas), [STUDY-35](STUDY-35-push-and-deploy.md) (the push's schema
  change), [STUDY-29](STUDY-29-index-backfill.md) (staged indexes, a different feature)

## 1. How Convex does it

**The method.** `npm-packages/convex/src/server/schema.ts:563–601` defines `TableDefinition.staged(documentSchema)`,
marked `@internal`.

- It takes a validator (`Validator<Record<string, any>, "required", any>`) or an object of field validators. The
  object is wrapped in `v.object` (`isValidator(documentSchema) ? documentSchema : v.object(documentSchema)`).
- A second call throws "Table cannot have more than one staged validator.".
- It returns `this` (through `self()`) with the same type parameters, so the table's document type and indexes do
  not change.
- The docs comment says that Convex validates the staged validator against the existing documents in the
  background, and that the `defineTable` validator stays enforced.

**The export.** `TableDefinition.export()` (:627–645) adds `stagedDocumentType`, the staged validator's JSON. When
that JSON is not an object (`typeof !== "object"`), it throws "Invalid staged validator: please make sure that the
parameter of `.staged()` is valid (see https://docs.convex.dev/database/schemas)". Without `.staged()` it is
`undefined`, so `SchemaDefinition.export()`'s `JSON.stringify` (:928–955) leaves it out.

At a push, the backend calls `export()` when it evaluates the schema (crates/isolate/src/environment/schema.rs:270–
289). An exception there is replaced by `invalid_schema_export_error()`: `InvalidSchemaExport`, "Default export from
schema file isn't a Convex schema. …". So the "Invalid staged validator" text never reaches a push.

**The backend.**

- `crates/common/src/schemas/json.rs:125` declares `staged_document_type: Option<ValidatorJson>` in
  `TableDefinitionJson`.
- :178 parses it with `DocumentSchema::try_from`, as `document_type`. An object, a union of objects or `any`
  passes; anything else is `invalid_top_level_type_in_schema` (schemas/mod.rs:744): 400
  `InvalidTopLevelTypeInSchemaError`, "The document validator in a schema must be an object, a union of objects,
  or `v.any()`. Found <validator>. To learn more, see the schema documentation at …". For a union, `<validator>`
  is the first member that is not an object. `application::evaluate_schema` prefixes "Hit an error while
  evaluating your schema:\n".
- :346 serializes it back, so it is persisted in `_schemas` with the rest.
- `schemas/mod.rs:505–509` holds it in `TableDefinition` ("the proposed next validator … validated in the
  background").
- `DatabaseSchema` derives `PartialEq` (:144). `SchemaModel::submit_pending`
  (crates/database/src/bootstrap_model/schema/mod.rs:207–258) reuses the active, pending or validated schema
  only when it is equal. So a push that changes only `.staged()` records a new pending schema.

**Nothing reads it.** A grep for `staged_document_type` and `stagedDocumentType` over `crates/` and
`npm-packages/` finds only:

- the declarations;
- the JSON parse and serialization;
- `None` literals in `fivetran_destination` and `schemas/mod.rs`'s macros.

No schema worker, write check or index check uses it. Contrary to the docs comment, nothing validates documents
against it today: it is accepted, parsed, checked for its top-level type, and stored.

## 2. What an app can observe

- `defineTable(...).staged(v)` returns the table. The document type, the indexes and the enforced validator are
  unchanged. A second `.staged()` throws.
- A push that adds, changes or removes only the staged validator is a schema change: a new schema version, and a
  `schemaDiff` in the push's audit event.
- A staged validator that is not an object, a union of objects or `v.any()` fails the push with
  `InvalidTopLevelTypeInSchemaError`.
- Documents are never checked against it, at the push or on writes.

## 3. How bunvex does it

In `@bunvex/core`:

- **`schema.ts`.**
  - `TableDefinition.staged(document)` wraps an object of fields in `v.object`, refuses a second call with
    Convex's message, stores the validator in `stagedDocument`, and returns `this`. The types keep the table's
    type parameters, so `DataModelFromSchemaDefinition` is unchanged.
  - The old `staged: string[]` field (the staged index names) is renamed `stagedIndexes`, since `staged` is now
    the method. The `DeclaredTable` the engine reads keeps its `staged` names.
  - `defineSchema` copies the staged validator into the `DeclaredTable`'s `stagedDocument`. It never throws for
    it, as Convex's does not.
  - `stagedDocumentJson` is Convex's `export()` check: a staged validator whose JSON is not an object throws
    Convex's message without the docs link (DV-356). `schemaToJson`, bunvex's `export()`, runs it.
  - `stagedDocumentError(schema)` is Convex's top-level-type check, with Convex's message without the link
    (DV-356).
- **`schema-json.ts`.** `schemaToJson` writes `stagedDocumentType` only when there is one, as Convex's export
  does. So the stored JSON of every schema without `.staged()` is unchanged. `schemaFromJson` reads it back
  (`validatorFromJson`), so a restart keeps it.

In `@bunvex/server`, `push.ts` runs Convex's steps after the schema evaluates, in Convex's order:

1. The export (`schemaToJson`). An error there is answered as Convex answers any `export()` error (S2, owner
   2026-10-05): 400 `InvalidSchemaExport`, "Default export from schema file isn't a bunvex schema.". The export's
   own message is dropped, and Convex's "Convex" and docs link are not used (DV-356).
2. The parse: `stagedDocumentError`, a 400 `InvalidTopLevelTypeInSchemaError`.
3. `checkIndexReferences`.

Each error is prefixed as every schema error is.

The schema JSON is what bunvex compares to tell a schema change: the push's `schemaDiff` and the stored
`_schemas` rows. So a staged-only change is a new schema with a diff, and an unchanged schema stores the same
string.

Nothing else reads the staged validator: no background check, no enforcement, the same as Convex.

This is not a hot path: it runs once per push and per schema load.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| S1 | "Invalid staged validator: please make sure that the parameter of `.staged()` is valid" and "The document validator in a schema must be …" have no docs link | DV-04's rule (rule 5): messages never link to Convex's docs | DV-356 (owner, 2026-10-05) |
| S2 | None now: a staged validator whose JSON is not an object fails the push with Convex's `InvalidSchemaExport` and its message ("… isn't a bunvex schema.", under DV-356) | — | match Convex (owner, 2026-10-05) |

Two observations outside this study's scope are each fixed in their own PR (owner, 2026-10-05):

- `defineTable`'s top-level check;
- a pushed schema equal to the active one (Convex's `submit_pending`).

## 4b. Additions (beyond Convex)

None.

## 5. Tests

- `packages/core/test/staged-validator.test.ts`:
  - `.staged()` wraps an object of fields, keeps a validator, returns the table, and leaves the enforced
    validator alone;
  - the duplicate error, and the first staged validator stays;
  - the export check: `defineSchema` accepts the schema, `schemaToJson` throws Convex's message without the link;
  - `stagedDocumentError` for an object, `any`, a union of objects, a string, and a union with a non-object
    member (named);
  - the schema JSON: `stagedDocumentType` for fields, a validator and `any`; absent without one; a round trip
    through `schemaFromJson`;
  - a push of the same schema stores the same JSON, and a staged-only change stores a different one, which
    becomes active;
  - documents that the staged validator refuses still pass the push, and writes are checked against
    `defineTable`'s validator only;
  - a restart reads the staged validator back.
- `packages/core/test/types/data-model.test.ts`: the document type and the indexes are unchanged by `.staged()`,
  for fields and for a validator, and `.staged(v.string())` is a type error, as in Convex.
- `packages/server/test/push.test.ts`, over HTTP:
  - a staged-only change gives a `schemaDiff` whose next schema carries `stagedDocumentType`, and writes are not
    checked against it;
  - `.staged(v.string())` is a 400 `InvalidTopLevelTypeInSchemaError` with the full message;
  - two `.staged()` calls fail the schema's evaluation;
  - a staged validator whose JSON is not an object is a 400 `InvalidSchemaExport`, nothing pushed.
- `packages/sync-e2e/test/staged-validator-oracle.test.ts`, the oracle:
  - the official package's `defineSchema(...).export()` and bunvex's `schemaToJson` give the same
    `stagedDocumentType` for four tables (fields, a union, `any`, none), present in the same tables;
  - the duplicate error is the same text.

Sabotage checks, each caught:

| Sabotage | Caught by |
|---|---|
| No duplicate check | definition test, push over HTTP, oracle |
| An object of fields not wrapped | definition, JSON, push tests |
| The export check off | export-check test |
| The enforced validator serialized as the staged one | JSON, push, HTTP and oracle tests |
| The staged validator not read back from JSON | round trip, restart |
| The top-level check only for unions | `stagedDocumentError` test, push over HTTP |
| The push error's code changed | push over HTTP |
| `defineSchema` drops the staged validator | definition, JSON, push, HTTP and oracle tests |
| The staged validator enforced in place of `defineTable`'s | JSON, push (documents not checked), push over HTTP |
| S2: the push answers the export error as `InvalidSchema` | push over HTTP |
| S2: the export check off | export-check test, push over HTTP |

## 6. Open questions

None at 4577b9031; see §7.5 for the DV-438 build.

## 7. Revisit at 7236c10 (2026-10-08): staged validators are validated (DV-438)

Four Convex commits turned the staged validator from a stored value into a validated one:

| Commit | What | First release with it |
|---|---|---|
| 2ada334 | `_schema_validations` rows for staged validators; the 400 `StagedSchemaWithEnforcedValidatorChanges`; a startup reset | `precompiled-2026-10-07-d8bdde0` (bunvex's reference, the current oracle) |
| 900fe2c | every write checked against staged validators; the startup reset removed | `precompiled-2026-10-08-a4ad353` |
| e049178 | the schema worker walks staged validators in the background | `precompiled-2026-10-08-02fe59b` |
| 7236c10 | a validated staged validator replaces the walk at promotion; widening keeps it valid; table deletion invalidates references; `supersetOfStagedValidated` | none yet |

So §1 "nothing validates documents against it", §2 "documents are never checked against it" and §3 "nothing else reads
the staged validator" are no longer true of Convex. (§3's "only when there is one" is also stale: since STUDY-134,
`schemaToJson` writes `stagedDocumentType: null` when there is none.)

### 7.1 The rows (`_schema_validations`, STUDY-127 §7)

A staged row is `{schemaId, tableName, validatorHash, state}`. `validatorHash` is the lowercase hex sha256 of the
staged validator's canonical JSON (`DocumentSchema::content_hash`, `common/src/schemas/json.rs:595`), the text bunvex
already writes for `stagedDocumentType` (`schema-json.ts`). Enforced walk rows have no `validatorHash` field at all.
One row per `(schemaId, tableName)`.

- **Push** (`SchemaModel::submit_pending`, `schema/mod.rs:276`): a new pending schema gets one staged row per table
  with a staged validator, carried over from the active schema or an overwritten in-progress one when it can be
  reused (`can_reuse_for`: a `pending` row only for the same validator; a `valid` row when the new validator accepts
  everything the old one did, `is_subset`; never a `failed` one), else `pending` with no progress. A push identical
  to the active (or in-progress) schema restarts only its `failed` rows whose hash is current.
- **Activation** (`mark_active`): only the enforced rows are deleted; staged rows stay with the schema. The old
  active schema's rows go with it (`mark_overwritten`).
- **Restart**: nothing (900fe2c removed `reset_for_compatibility`): "a `Valid` staged validation stays trustworthy
  because every write since is checked".

### 7.2 Writes (900fe2c)

On each insert or replace into a user table (`SchemaModel::enforce_with_table_mapping`, `check_write_against_staged`):
the active schema's enforced check (refuses), then its staged check; then the pending/validated schema's enforced check
(fails that schema) and its staged check. The staged check ignores `schemaValidation`. A document that conforms reads
nothing. One that does not marks the table's row `failed` in the write's own transaction, with `New document in table
"<t>" does not match the schema: <error>`, unless the row is missing or already failed. **The write succeeds.**

### 7.3 The background walk (e049178)

After pending (enforced) schemas, the schema worker takes the active, then validated, then pending schema's staged rows
that are `pending` with the current hash, tables in name order. Per table: no table, or a staged validator that accepts
the table's shape (an empty table) or, with `schemaValidation`, the schema's own enforced validator → `valid` without a
walk. Otherwise `StartWalk` (progress 0, the table's count), a walk by `by_id` pages of 1000 with progress every
`min(500, ceil(5%))` documents, then `valid`; a violation → `failed` with `Document with ID "<id>" in table "<t>" does
not match the schema: <error>`. A row that stopped being `pending` (a write failed it, a push replaced it) cancels the
walk. Tables fail independently; the schema's state is never touched; staged walks never block a push.

### 7.4 Push (2ada334, 7236c10)

- `start_push` (dry run too), `evaluate_push` and `prepare_schema` refuse a schema that stages validators on tables
  whose enforced validator change needs a walk: 400 `StagedSchemaWithEnforcedValidatorChanges`, "Cannot stage
  validators on tables whose enforced validator change needs their documents walked: {tables}. Put the whole change in
  the staged validator instead, so the table is walked once, in the background." (tables sorted, `, `-joined). The
  check treats a table that does not exist as empty and uses no real shapes; a new table with an index already exists
  when it runs on a real push (index preparation creates it), so it is refused there but not in a dry run.
  `evaluate_schema` does not predict it.
- The table outcome, in order: `notValidated` (no `schemaValidation`), `supersetOfEnforced` (the new validator accepts
  everything the active one did, by `Validator::is_subset`, `validator.rs:324`), **`supersetOfStagedValidated`** (it
  accepts everything a `valid` staged validator of the active schema accepts), `supersetOfShape`, `mustWalk`.
  `evaluate_schema` reports the new outcome; the enforced walk skips those tables, so promoting a proven staged
  validator to `defineTable` needs no scan.
- Deleting or replacing an active table fails every staged row, in the active, validated and pending schemas, whose
  validator references it with `v.id`: "Table {t} is referenced by the staged validator for {r} but was deleted or
  replaced; redeploy to revalidate {r}."

`Validator::is_subset` (false negatives allowed, no false positives): arrays element-wise; objects when every left
key is on the right and every right field is either on the left (optional only if the right one is, validator ⊆) or
optional; structural equality; `_ ⊆ any`; literal ⊆ its type; `id ⊆ string`; `int64 ⊆ commitTs` and back; a union on
the left when every member is ⊆; a union on the right when one member is (and `boolean` when both literals are).

### 7.5 bunvex today, and the build

bunvex stores the staged validator and nothing more: no staged rows, no `validatorHash`, no write checks, no staged
walk, no 400, no `is_subset` (its `supersetOfEnforced` is JSON equality, so it walks — and predicts `mustWalk` for —
widenings Convex skips), no `supersetOfStagedValidated`, and it deletes every validation row at start. DV-438 (owner,
2026-10-08: match the whole feature; keep bunvex's startup reset until writes are checked) is built in this order:

1. `is_subset` for the table outcome and the walk skip (independent; changes walk counts).
2. Staged rows, `validatorHash`, carry-over, retry, activation keeping staged rows, the 400 (dry run and
   `evaluate_push` too).
3. Write checks in the write's transaction, and the startup reset removed.
4. The staged background walk.
5. `supersetOfStagedValidated` (outcome, promotion skip) and table-deletion invalidation.

Found on the way, separate from DV-438: a write that fails a pending schema stores `Failed to insert or update …`
where Convex stores `New document in table "<t>" does not match the schema: …`; and a push deletes the old active
`_schemas` row where Convex marks it `overwritten`.

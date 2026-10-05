# STUDY-106 — `TableDefinition.staged(validator)`

- **Status:** implemented
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-05
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
  - `defineSchema` copies the staged validator into the `DeclaredTable`'s `stagedDocument`. Before that it runs
    Convex's export check: a staged validator whose JSON is not an object throws Convex's message without the
    docs link (DV-356). bunvex has no `export()`, and `defineSchema` is where the table is read.
  - `stagedDocumentError(schema)` is Convex's top-level-type check, with Convex's message without the link
    (DV-356).
- **`schema-json.ts`.** `schemaToJson` writes `stagedDocumentType` only when there is one, as Convex's export
  does. So the stored JSON of every schema without `.staged()` is unchanged. `schemaFromJson` reads it back
  (`validatorFromJson`), so a restart keeps it.

In `@bunvex/server`, `push.ts` runs `stagedDocumentError` with the other post-evaluation checks, before
`checkIndexReferences` (as Convex's parse comes before `check_index_references`). It fails the push as a 400
`InvalidTopLevelTypeInSchemaError`, prefixed as every schema error is.

The schema JSON is what bunvex compares to tell a schema change: the push's `schemaDiff` and the stored
`_schemas` rows. So a staged-only change is a new schema with a diff, and an unchanged schema stores the same
string.

Nothing else reads the staged validator: no background check, no enforcement, the same as Convex.

This is not a hot path: it runs once per push and per schema load.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| S1 | "Invalid staged validator: please make sure that the parameter of `.staged()` is valid" and "The document validator in a schema must be …" have no docs link | DV-04's rule (rule 5): messages never link to Convex's docs | DV-356 (owner, 2026-10-05) |
| S2 | *gap, pending:* when the staged validator's JSON is not an object, Convex's push replaces its `export()` error with `InvalidSchemaExport` ("Default export from schema file isn't a … schema."). bunvex's `defineSchema` throws it while the schema module evaluates, so the push reports `InvalidSchema` with that message | bunvex has no `export()` step at push. Only a hand-made validator object reaches it | question for the owner (in the PR) |

Observations outside this study's scope, for the owner (not divergences of this feature):

- bunvex's `defineTable` refuses a top-level validator that is not an object, a union of objects or `v.any()`
  when it is called, with its own message. Convex refuses it at push with `InvalidTopLevelTypeInSchemaError`, as
  above. `.staged()` follows Convex; `defineTable` does not.
- bunvex's `Engine.startSchemaPush` records a new pending schema even when the pushed schema equals the active
  one. Convex's `submit_pending` returns the active schema's id then. bunvex's push still reports `schemaDiff: null`,
  since it compares the JSON.

## 4b. Additions (beyond Convex)

None.

## 5. Tests

- `packages/core/test/staged-validator.test.ts`:
  - `.staged()` wraps an object of fields, keeps a validator, returns the table, and leaves the enforced
    validator alone;
  - the duplicate error, and the first staged validator stays;
  - the export check: Convex's message without the link;
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
  - two `.staged()` calls fail the schema's evaluation.
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

## 6. Open questions

- S2: should the push report a staged validator whose JSON is not an object as Convex does, with
  `InvalidSchemaExport` and the generic message?
- The two observations in §4: `defineTable`'s top-level check (when and with which code), and a pushed schema
  equal to the active one.

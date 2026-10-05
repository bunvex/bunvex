# STUDY-14 — Schemas: `defineSchema`, `defineTable`, document validation

- **Status:** implemented (#29 schemas, #33 implicit table creation)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:** [STUDY-13](STUDY-13-validators.md), [STUDY-04](STUDY-04-table-and-index-metadata.md)

## 1. How Convex does it

- **`defineTable(document)`** (`npm-packages/convex/src/server/schema.ts`):
  - takes an object of field validators, a `v.object`, a `v.union` of objects, or `v.any()`;
  - `.index(name, fields)` declares an index, and Convex appends `_creationTime` and `_id` to it
    (STUDY-05);
  - `.searchIndex`, `.vectorIndex` and `.staged` exist too.
- **`defineSchema(tables, { schemaValidation = true, strictTableNameTypes = true })`.**
  `strictTableNameTypes` only affects TypeScript types.
- **Enforcement** (`crates/common/src/schemas/mod.rs`, `DatabaseSchema::check_new_document`):
  - With `schemaValidation`, every document written to a table **in the schema** must match that table's
    validator. The system fields `_id: v.id(table)` and `_creationTime: v.number()` are added to it.
  - A mismatch fails the write with: `Failed to insert or update a document in table "t" because it does
    not match the schema: <validation error>`.
  - Tables that aren't in the schema are not checked.
- **Pushing a schema** also checks the existing documents against it (`SchemaValidationError::
  ExistingDocument`).

## 2. What an app can observe

1. **The API:** `defineSchema`, `defineTable` and `.index`, with the validator forms listed in §1.
2. **Writes are checked:** an insert, patch or replace that breaks the schema fails with the message in
   §1, and nothing of that mutation is written.
3. **`schemaValidation: false`** turns the checks off.

## 3. How bunvex does it

- **`@bunvex/core/schema.ts`** defines `defineTable`, `TableDefinition.index` and `defineSchema`. It
  replaces the old `new Schema().table(...)`, which is removed (owner decision). `@bunvex/server` re-exports
  them.
- **The engine** builds each declared table's document validator, with the system fields added
  (`documentValidator`).
- **`Tx.stage`** checks every document written by a mutation, using the catalog for `v.id`.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| D1 | Existing documents are not re-checked when the schema changes | That check belongs to the deploy/push flow (parity gap) | **closed** (STUDY-35): a pushed schema's existing documents are walked, and writes while it is pending are checked, as Convex's `SchemaWorker` |
| D2 | No `searchIndex`, `vectorIndex` or `staged` yet | Search features are phase 4 | gap |
| D3 | ~~Tables not in the schema can't be written yet~~ Fixed in #33: a write creates the table, as `TableModel::insert_table_metadata` does; reads of a missing table return nothing and depend on `_tables` | — | done |

## 5. Tests

`packages/core/test/schema.test.ts`:

- matching documents;
- a missing field, an extra field and a bad patch, each with the exact message and nothing written;
- `v.id` to the wrong table;
- a union of objects;
- `v.any()` tables and `schemaValidation: false`;
- the `defineTable` forms.

Sabotage: skipping the check fails 3 tests.

## 6. A document validator a table cannot have (2026-10-05)

### 6.1 How Convex does it

- **`defineTable`** (npm-packages/convex/src/server/schema.ts:708–718) checks nothing beyond wrapping an object of
  fields in `v.object`. `defineTable(v.string())` is a `TableDefinition` like any other. The `TableDefinition`
  constructor (:214–222) only stores it.
- **`TableDefinition.export()`** (:619–625) throws "Invalid validator: please make sure that the parameter of
  `defineTable` is valid (see https://docs.convex.dev/database/schemas)" when the validator's JSON is not an
  object. At a push, the backend calls `export()` while it evaluates the schema
  (crates/isolate/src/environment/schema.rs:270–289). It answers any exception there with
  `invalid_schema_export_error()`: 400 `InvalidSchemaExport`, "Default export from schema file isn't a Convex
  schema. To learn more, see the schema documentation at https://docs.convex.dev/database/schemas.".
- **The parse** (`DocumentSchema::try_from`, crates/common/src/schemas/json.rs:554–587) accepts an object, a union
  of objects, or `any`. Anything else is `invalid_top_level_type_in_schema` (schemas/mod.rs:744–752): 400
  `InvalidTopLevelTypeInSchemaError`, "The document validator in a schema must be an object, a union of objects,
  or `v.any()`. Found <validator>. To learn more, …". For a union, `<validator>` is its first member that is not
  an object.
- `application::evaluate_schema` prefixes both errors with "Hit an error while evaluating your schema:\n", and
  `start_push` prefixes "Hit an error while pushing:\n".

### 6.2 What bunvex did, and does now

Before this section, bunvex's `TableDefinition` constructor threw "A table's document validator must be
v.object(...), a v.union of objects, or v.any()." when `defineTable` was called. So the push failed while the
schema module evaluated (`InvalidSchema`, "Uncaught Error: …").

Now it follows Convex at both points (owner, 2026-10-05):

- `defineTable` only wraps an object of fields.
- `schemaToJson` (bunvex's `export()`) runs `documentJson`, Convex's export check, with its message.
- The push (`push.ts`, after the schema evaluates) runs Convex's steps in Convex's order:
  1. the export: an error there is a 400 `InvalidSchemaExport`, "Default export from schema file isn't a bunvex
     schema.";
  2. the parse: `documentTypeError`, a 400 `InvalidTopLevelTypeInSchemaError` with Convex's message;
  3. `check_index_references`, as before.

The messages leave out Convex's docs links and name bunvex where Convex names itself (DV-397).

### 6.3 Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| T1 | The three messages have no docs link, and "isn't a bunvex schema" names bunvex | DV-04's rule (rule 5) | DV-397 (owner, 2026-10-05) |

### 6.4 Tests

- `packages/core/test/schema.test.ts`:
  - `defineTable(v.string())` declares;
  - `documentTypeError` for an object, `any`, a union of objects, a string, and a union with a non-object
    member (named);
  - the export check's message.
- `packages/server/test/push.test.ts`: over HTTP, a union with a string member is a 400
  `InvalidTopLevelTypeInSchemaError`, and a validator whose JSON is not an object is a 400 `InvalidSchemaExport`,
  with the full messages. Nothing is pushed.
- `packages/sync-e2e/test/define-table-oracle.test.ts`: the oracle. Declaring such tables throws in neither
  package, and the export message is the official package's without its link.

Sabotage checks, each caught:

| Sabotage | Caught by |
|---|---|
| Unions not checked | core, HTTP |
| The top-level error's code changed | HTTP |
| The export check off | core, HTTP, oracle |
| The export error's code changed | HTTP |
| No top-level check at all | core, HTTP |

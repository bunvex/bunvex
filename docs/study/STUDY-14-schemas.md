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
| D1 | Existing documents are not re-checked when the schema changes | That check belongs to the deploy/push flow (parity gap) | gap |
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

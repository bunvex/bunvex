# STUDY-144 — `schema.tables` as Convex's record of `TableDefinition`s

- **Status:** implemented; no new divergence.
- **Convex source read:** `npm-packages/convex/src/server/schema.ts` and its build in the `convex` 1.46.0 package
  (`dist/esm/server/schema.js`), the version bunvex's oracle tests pin.
- **Related:** [STUDY-66 §6](STUDY-66-server-api-gaps.md) (where
  the gap was found), [STUDY-36](STUDY-36-codegen.md) (the data model's types), STUDY-14 and STUDY-106 (the
  push-time checks, staged validators).

## 1. How Convex does it

- `defineSchema(schema, options)` returns `new SchemaDefinition(schema, options)` (`schema.ts:1062`).
- `SchemaDefinition` (`:869-956`):
  - own fields, in this order: `tables` (the object given, kept as it is), `strictTableNameTypes` (declared
    with `!`, never set: the compiled class defines it as `undefined`), and `schemaValidation` (`true` unless
    the option is `false`);
  - methods: `doc(tableName)`, `id(tableName)` (STUDY-66 §6), and the internal `export()`. `export()` serializes
    `Object.entries(this.tables)` when the CLI pushes, so the table definitions are read then, not at
    `defineSchema`.
- `TableDefinition` (`:193-…`):
  - `validator`, the document validator, is public;
  - its index lists are private: `indexes`, `stagedDbIndexes`, the search and vector ones, and `stagedValidator`;
  - the experimental `" indexes"()` returns the database indexes that are not staged, in the order declared,
    as `{ indexDescriptor, fields }` with the fields as given. A name declared twice is listed twice; the push
    refuses it.
- The types: `SchemaDefinition<Schema, StrictTableTypes>` has `tables: Schema`, a record of
  `TableDefinition<Validator, Indexes, SearchIndexes, VectorIndexes>`. `DataModelFromSchemaDefinition` infers
  both type parameters from the class.

## 2. What an app can observe

- `schema.tables.messages`: the very definition passed to `defineSchema`, typed. Its `validator` is usable in
  `args`, `returns`, `v.object({ ...schema.tables.messages.validator.fields })`, or
  `docValidator("messages", schema.tables.messages)` (Convex's own docs example).
- `Object.keys(schema)`: `tables`, `strictTableNameTypes`, `schemaValidation`.
- An index added to a table after `defineSchema`, before the push, is part of the pushed schema.
- `schema.tables.x[" indexes"]()`.

## 3. How bunvex does it

`packages/core/src/schema.ts`:

- `SchemaDefinition` is `{ tables: Schema; schemaValidation; strictTableNameTypes? }`. `defineSchema` returns
  `{ tables, strictTableNameTypes: undefined, schemaValidation }` with `doc` and `id` as non-enumerable methods.
  `tables` is the object given.
- The engine reads the tables as it declares them (by name: indexes, staged ones, search and vector indexes,
  the document validator and the staged one, the old `Map`) through **`declaredTables(schema)`**:
  - the map is made from the `tables` record on first use and then kept, in a `WeakMap` keyed by the schema;
    the schema object holds no extra fields;
  - first use is the push or the engine's start, so an index added after `defineSchema` counts, as Convex
    reads `tables` when it exports at push;
  - `defineSchema` still runs Convex's push-time checks when it is called, as before (names, indexes, system
    fields), so the errors keep their timing.
- A schema the engine makes itself has `tables` built from table definitions holding the same declaration
  (`schemaOfDeclared`). Examples are a pushed schema read back from its JSON (`schemaFromJson`) and the
  push's empty schema. Its `declaredTables` is the map it was made from.
- `TableDefinition` gets Convex's `" indexes"()`. bunvex's own index fields (`indexes`, `stagedIndexes`,
  `searchIndexes`, …) stay as they were: in Convex they are private.
- **Readers refactored:** every `schema.tables` read in `engine.ts` (20 of them), `schema-json.ts`, `schema.ts`,
  and the server's `imports.ts` and `push-audit.ts` now call `declaredTables(…)`. The engine's private
  `declaredTables()` method (system tables, then the schema's) is renamed `allDeclaredTables()`.
  `push.ts` recognizes a schema export by a non-`Map` `tables` object and a boolean `schemaValidation`.
- **Types:** `DataModelFromSchemaDefinition` infers from `tables` and `strictTableNameTypes`, as Convex's.
  The `__tables` / `__strictTableNameTypes` phantom fields are gone.
- **Codegen:** `_generated/dataModel.d.ts` uses `DataModelFromSchemaDefinition<typeof schema>`. Its tests pass,
  and the `search`, `vector-search`, `relational-data-modeling`, `typescript`, `pagination` and
  `args-validation` examples typecheck against the workspace packages.
- **Dashboard:** it reads the schema as JSON from the server (arrays of tables), never `SchemaDefinition`, so
  nothing changes there.
- **Not built:** the internal `export()` methods of both classes. bunvex's push serializes with `schemaToJson`.

## 4. Divergences

None. bunvex's `TableDefinition` keeps its own public index records, where Convex's are private (a
TypeScript-only difference, unchanged here).

## 5. Tests

- `packages/sync-e2e/test/schema-tables-oracle.test.ts` (against the `convex` package): the same schema
  defined with each package's `defineSchema`, `defineTable` and `v`. It checks:
  - the schema's own keys, `schemaValidation` both ways, `strictTableNameTypes`;
  - `tables` being the record given, its keys, each definition's `validator`;
  - `" indexes"()`, with a staged index and a name declared twice;
  - `docValidator(name, schema.tables.x)`, `schema.doc`, `schema.id`, the table's fields reused in
    `v.object`;
  - an index added after `defineSchema` being in the exported schema;
  - the error for a missing table.
- `packages/core/test/schema-tables.test.ts`:
  - the declared tables made from the record and kept;
  - a schema read back from JSON, whose `tables` declare the same;
  - any `{ tables }` object being declared with `defineSchema`'s checks, and a `Map` being refused.
- `packages/core/test/types/data-model.test.ts`: `schema.tables.users.validator` typed, and a table that does
  not exist being a type error. The existing readers' tests now go through `declaredTables`.

### Sabotage

Each break made at least one test fail (restored; `git diff` clean):

| Break | Failing |
|---|---|
| S1 `tables` a `Map` again | 28 |
| S2 no `strictTableNameTypes` field | 2 |
| S3 definitions read back from JSON lose staged indexes | 1 |
| S4 `defineSchema` checks nothing | 2 |
| S5 `tables` a copy, not the record given | 2 |

### Measurements

No hot path changes. The engine reads `declaredTables(schema)` where it read `schema.tables`: one `WeakMap`
lookup, at a push, at start, and once per `vectorSearch` call. Nothing was measured.

## 6. Open questions

None.

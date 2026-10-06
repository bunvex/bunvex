# STUDY-134 — System-table row shapes, as Convex writes them

- **Status:** implemented in #473, #480, #477, #476, #478, #475, #474, #482 (owner, 2026-10-05: every system-table
  row shape matches Convex's latest version; no legacy data, no migration); DV-421–DV-427 and DV-430 resolved;
  DV-428 (identity fields) and DV-429 (the app definition module) wait on a dependency
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-05; the rows of
  `convex-local-backend` precompiled-2026-09-28-5c7cb5b (CLI `convex` 1.46.0)
- **Related:** [STUDY-04](STUDY-04-table-and-index-metadata.md) (`_tables` / `_index`),
  [STUDY-29](STUDY-29-index-backfill.md) (index backfill), [STUDY-35](STUDY-35-push-and-deploy.md) (`_schemas`,
  `_modules`, `_source_packages`, `_udf_config`), [STUDY-30](STUDY-30-scheduler-and-crons.md) (crons),
  [STUDY-33](STUDY-33-retention.md) and [STUDY-72](STUDY-72-table-summary-checkpoints.md) (globals),
  [STUDY-63](STUDY-63-pause-deployment.md) (`_backend_state`), [STUDY-111](STUDY-111-search-segments.md) (search
  `_index` rows, #453), [STUDY-62](STUDY-62-components.md) (components),
  STUDY-133 (the persistence layout: table and index identities, in progress), STUDY-125 / STUDY-126 /
  STUDY-127 / STUDY-128 (other system tables, #459 / #449 / #461 / #451)

## 0. How the rows were compared

The same app (one table with an index and a search index, a daily cron, two scheduled functions, a stored file,
an environment variable) was pushed to a fresh Convex SQLite deployment and to a fresh bunvex one; every
system row was decoded from the two databases and compared field by field. The Convex rows are kept as test
fixtures (`packages/core/test/convex-rows/*.json`), and each PR below tests a row bunvex writes against them
with `shapeDiff` (each field's value type, recursively: int64, float64, bytes, string, …; values are ignored).

Convex stores a system document through `codegen_convex_serialization!`: the serde struct becomes a
`ConvexValue`, so **every Rust integer field is an int64** (`{"$integer": …}` in the JSON column), a
`ByteBuf` / `serde_bytes` field is bytes (`{"$bytes": …}`), and an `Option` without
`skip_serializing_if` is `null` when absent. Timestamps are `Timestamp`s: int64 **nanoseconds**.

## 1. How Convex does it

### 1.1 `_tables` (group 1)

`SerializedTableMetadata` (crates/common/src/bootstrap_model/tables.rs:75-81): `{name, number: i64, state:
"active" | "hidden" | "deleting", namespace?}` (`namespace` only for a component's table). The table's id is
the row's own id (its internal id is the tablet id).

### 1.2 `_index` and `_index_backfills` (group 2)

- **The row.** `SerializedTabletIndexMetadata` (common/src/bootstrap_model/index/index_metadata.rs:271-287):
  `{table_id, descriptor, config}`. `config` is `SerializedIndexConfig` (index_config.rs:210-233), tagged
  `type`: for a database index `{type: "database", fields, onDiskState, persistenceIndexId?: i64}` (the spec
  flattened; `persistenceIndexId` omitted until assigned, which `assign_missing_persistence_index_ids` does in
  the committing transaction, database/src/transaction.rs:277-315).
- **The states.** `SerializedDatabaseIndexState` (database_index/index_state.rs:64-79), tagged `type`:
  `{type: "Backfilling", backfillState: {indexCreatedLowerBound: i64, retentionStarted: bool, staged: bool}}`
  (backfill_state.rs:21-29), `{type: "Backfilled2", staged}`, `{type: "Enabled"}`.
- **`by_id`** has `fields: []` (its key is the id alone); `by_creation_time` has `["_creationTime"]`; a user
  index has its fields with `_creationTime` appended (application/src/lib.rs:2068).
- **A new index.** A system table's indexes start `Enabled` (`IndexMetadata::new_enabled`,
  index_metadata.rs:213, from `initialize_application_system_table`, model/src/lib.rs:487-505). A user index
  starts `Backfilling` with `retentionStarted: false` (`_new_backfilling`, index_metadata.rs:103-121) — on a
  table the same push creates too. The Convex rows show the sequence for `things.by_s_n`: `Backfilling`
  (retention not started) → `Backfilling` (retention started) → `Backfilled2 {staged: false}` → `Enabled` at
  `finish_push`; `by_id` and `by_creation_time` of the new table are `Enabled` from the start.
- **An import's table.** `create_empty_table` (application/src/snapshot_import/mod.rs:1659-1701) creates the hidden
  table and, in the same transaction, `copy_indexes_to_table` (database/src/bootstrap_model/index.rs:1052-1131)
  gives it a `Backfilling` copy of each ENABLED index of the table it replaces (a table still backfilling one
  cannot be replaced: `InvalidImport`). Then `backfill_and_enable_indexes_on_table` (:1703-1745) waits until no
  index of the new table is backfilling and enables them in one commit — before any document is written; the
  import's last step only activates the table
  (`enable_backfilled_indexes`, application/src/snapshot_import/mod.rs:1739).
- **`_index_backfills`.** `SerializedIndexBackfillMetadata` (database/src/bootstrap_model/index_backfills/
  types.rs:44-80): `{indexId: <the _index row's id>, numDocsIndexed: i64, totalDocs: i64 | null, cursor:
  {snapshotTs: i64, cursor: string | null} | null}`. The database index worker initializes it when a backfill
  starts (`initialize_database_index_backfill`, database_index_workers/mod.rs:440-446: `totalDocs` from the
  table summary, `cursor {snapshotTs, cursor: null}`); the search flusher initializes one with `cursor: null`
  (search_index_workers/src/search_flusher.rs:483-486). Progress replaces it
  (`update_index_backfill_progress`, index_backfills/mod.rs:182-240). Nothing deletes it:
  `delete_index_backfill` (mod.rs:243) has no caller.

### 1.3 `_schemas` (group 3)

`SerializedSchemaMetadata {state, schema}` (common/src/bootstrap_model/schema_metadata.rs:35-39). `state` is
`SerializedSchemaState`, tagged `state` (schema_state.rs:48-59): `{state: "pending"}`, `"validated"`,
`"active"`, `"overwritten"`, or `{state: "failed", error, table_name}` (the variant renamed, not its fields).
`mark_failed` patches the state only, with `table_name` set (database/src/bootstrap_model/schema/mod.rs:352-392).
`schema` is the string of `DatabaseSchemaJson` (common/src/schemas/json.rs:60-125, 300-375): the tables in
name order, each with `tableName, indexes, stagedDbIndexes, searchIndexes, stagedSearchIndexes, vectorIndexes,
stagedVectorIndexes, documentType, stagedDocumentType` (every list present, `stagedDocumentType: null`
without one), indexes in descriptor order with `_creationTime` appended, text indexes' filter fields a sorted set (:495-545),
a vector index with `dimension: null` beside `dimensions` (:470-495), the document type re-serialized from the
parsed validator (object fields sorted, a table's own `_` system fields dropped, validator.rs:790; floats as
serde_json prints them, `1.0`), then `schemaValidation`. `v.any()` is `{type: "any"}`.

### 1.4 `_modules` and `_source_packages` (group 4)

- `_modules`: `SerializedModuleMetadata {path, sourcePackageId, environment, analyzeResult, sha256}`
  (model/src/modules/types.rs:74-112): `sha256` is the base64 string of sha256(source + source map)
  (`hash_module_source`, modules/mod.rs:468). `analyzeResult` is `SerializedAnalyzedModule`
  (modules/module_versions.rs:117-125): `functions`, `httpRoutes`, `cronSpecs`, `sourceMapped` (null), each
  position `{path, start_lineno: i64, start_col: i64}` (:234-238).
- Convex stores every app module the push carries: the functions (with `auth.config.js`, which the CLI puts
  among them, npm-packages/convex/src/cli/lib/components/definition/bundle.ts:727-731), `schema.js` and the app
  definition `convex.config.js` (`AppDefinitionConfig::all_modules`, model/src/components/types.rs:95-103).
- `_source_packages`: `SerializedSourcePackage {storageKey, sha256: bytes, externalPackageId: string | null,
  packageSize: {zippedSizeBytes: i64, unzippedSizeBytes: i64}, nodeVersion: string | null}`
  (source_packages/types.rs:184-270).

### 1.5 Crons and `_udf_config` (group 5)

- `_cron_jobs {name, cronSpec}`; `SerializedCronSpec {udfPath, udfArgs: bytes, cronSchedule}`
  (model/src/cron_jobs/types.rs:216-232): `udfArgs` is the JSON text of the arguments array, as bytes;
  `cronSchedule` tagged `type` with i64 `seconds`, `hourUTC`, `minuteUTC`, `dayOfWeek`, `day` (:534-570); a
  missing `minuteUTC` is null (`None`, value/src/serde/ser.rs:219; the npm `cronJobs` lets it be omitted,
  npm-packages/convex/src/server/cron.ts:241).
- `_cron_next_run {cronJobId, state, prevTs: i64 | null, nextTs: i64}` (:1088-1094), ns; `state` tagged `type`,
  `{type: "inProgress", request_id, execution_id}` (the variant renamed, not its fields, :480-490).
- `_cron_job_logs {name, ts: i64, udfPath, udfArgs: bytes, status, logLines, executionTime}` (:773-790); a
  successful run's result is `{type: "default", value: <its JSON text>}` (:869-889, 958-976).
- `_modules.analyzeResult.cronSpecs`: an array of `{identifier, spec}` (module_versions.rs:186-191), or null.
- `_udf_config {serverVersion, importPhaseRngSeed: bytes, importPhaseUnixTimestamp: i64}`
  (model/src/udf_config/types.rs:28-35); `serverVersion` is the `udfServerVersion` the CLI pushes (its npm
  package's semver, application/src/deploy_config.rs:418-422), the timestamp in ns; the seed and time are
  drawn again only when the server version changes (application/src/lib.rs:3905-3925, udf_config/mod.rs:58-105).

### 1.6 Persistence globals (group 6)

- Retention writes `min_snapshot_ts`, `document_min_snapshot_ts`, `confirmed_deleted_ts` and
  `document_confirmed_deleted_ts` as a `ConvexValue::Int64` of the ts (database/src/retention.rs:663-666,
  1462-1467): `{"$integer": …}`, ns.
- `table_summary_v2` (database/src/table_summary.rs:235-248, 380-395): `{tables: {<tablet id>: {totalSize:
  <JsonInteger>, inferredTypeWithOptionalFields: <shape>}}, ts: <JsonInteger>}` — a JsonInteger is the base64
  string of the little-endian i64 — and each shape as `CountedShape::to_json`
  (shape_inference/src/json.rs:193-286): `{numValues, variant: {kind, …}}` with `literal`, `tableNumber`,
  `elementType`, `fields: [{fieldName, type: {type, optional}}]`, `fieldType` / `valueType`, `types`.

### 1.7 `_backend_state` (group 7)

`initialize_application_system_tables` (model/src/lib.rs:409-437) inserts `{system: "none", usage_limit:
"none", user: "none"}` (`BackendStateModel::initialize`, backend_state/mod.rs:51-64) in the transaction that
creates the table: the row always exists.

## 2. What an app can observe

Nothing through its functions: apps cannot read these tables (`db.system` reads `_storage` and
`_scheduled_functions` only). The rows are seen by whoever reads the store (an operator, a tool, a future
move of a deployment's data between Convex and bunvex — STUDY-133), by the dashboard's system-table views,
and in a few derived places: the deployment audit log's `schemaDiff.next_schema` is the stored schema string,
`get_config_hashes` answers the modules' `sha256`, and the table summaries' shapes reach the dashboard.

## 3. How bunvex does it

Before this study, bunvex's rows had the same names but other shapes (the comparison of §0):

| Table | bunvex wrote | Convex writes |
|---|---|---|
| `_tables` | `number` a float | an int64 |
| `_index` | `{tablet, name, fields, indexId, state, staged}`; `by_id` `["_id"]`; a new table's indexes enabled at once | `{table_id, descriptor, config: {type: "database", fields, onDiskState, persistenceIndexId}}`; `by_id` `[]`; a user index backfills even on a new table |
| `_index_backfills` | numbers; deleted when the backfill ends | int64s; kept |
| `_schemas` | `state: "active"`; the schema as bunvex's JSON (no `_creationTime`, no vector lists, declaration order) | `state: {state: "active"}`; Convex's `DatabaseSchemaJson` |
| `_modules` | `sha256` hex; positions floats; no `sourceMapped`; `cronSpecs` an object; no `schema.js` / `auth.config.js` rows | base64; int64; `sourceMapped: null`; an array of `{identifier, spec}`; both stored |
| `_source_packages` | `sha256` hex; `packageSize` a number | bytes; `{zippedSizeBytes, unzippedSizeBytes}`; `externalPackageId`, `nodeVersion` |
| crons | floats, ms; `udfArgs` the array | int64, ns; bytes |
| `_udf_config` | `importPhaseUnixTimestamp` ms float; `serverVersion: "bunvex"` | ns int64; the CLI's package semver |
| globals | plain numbers; `{n, v}` shapes, μs | `$integer` / JsonInteger, Convex's shape JSON, ns |
| `_backend_state` | written only when the state first changes | written when the table is created |

The fix keeps bunvex's in-memory types and converts at the row boundary: each table's rows are encoded where
they are written and decoded where they are read (`tableRow` / `tableMeta`, the `_index` codec, the schema and
cron codecs, …), so the engine's logic does not change. Timestamps are written as Convex's ns: bunvex's commit
timestamps are microseconds (DV-30), multiplied by 1000 on the way in and divided on the way out; wall-clock
milliseconds by 10⁶.

What this study does not change, and why:
- **The identity fields** — `_tables.tablet`, `_index.tablet` / `name` (Convex's `table_id` / `descriptor`), the
  integer tablets that key `table_summary_v2`: they are the persistence layout's (STUDY-133, DV-53), and
  STUDY-111's search rows (#453) keep them the same way (DV-428).
- **Other system tables** are other PRs': `_scheduled_jobs` / `_scheduled_job_args` / `_file_storage` (#459,
  #469), `_db` (#449), `_next_persistence_index_id` (#451), `_schema_validations` (#461), `_auth` (#454),
  `_storage` deletions (#456), `_components` / `_component_definitions` (components, not built).
- **The app definition module** (`convex.config.js`): it comes with components, which bunvex does not have;
  its CLI pushes `definition: null` (DV-429).

How each group does it, and what else it changed to keep the same behaviour:

- **`_tables`** (#473): `tableRow` / `tableMeta` in `catalog.ts`.
- **`_index`, `_index_backfills`** (#480, stacked on #453): `indexRow` / `indexMeta` / `indexStatePatch` and
  `backfillRow` / `backfillMeta` in `catalog.ts`; #453's `databaseIndexRows` / `isSearchIndexRow` tell rows apart
  by `config.type`. A user index on a new table starts `Backfilling`; the index worker records
  `retentionStarted` in a commit of its own before `Backfilled2`, and `init()` / `startSchemaPush` run that pass
  for the tables they just created (`IndexWorker.backfillNow`), so a new table's indexes are still ready when
  `init()` returns. The worker's rate limit charges the entries a chunk writes (after the read, as Convex's),
  so an empty table costs nothing. `_index_backfills` rows are kept; a search or vector build writes one.
- **`_schemas`** (#477): `schemaStateOf` / `schemaFailureOf` and `schemaJsonText` in `schema-json.ts`; the push's
  `evaluate_schema` answer and the audit log's `next_schema` carry the same text.
- **`_modules`, `_source_packages`** (#476): converted in `server/src/code-store.ts`; `schema.js` and
  `auth.config.js` are stored as modules (and in the package), still not loaded as functions; the push's module
  diff and `get_config_hashes` list `schema.js`, as Convex's do.
- **Crons, `_udf_config`** (#478): `server/src/cron-rows.ts`; the `by_next_ts` bounds are nanoseconds; `bunvex
  deploy` sends its package version as `udfServerVersion`; the dashboard's cron functions return the rows as
  stored, as Convex's.
- **Globals** (#475): `core/src/persistence-globals.ts` (`jsonInteger`, `readTsGlobal`, …), the shapes' JSON in
  `shapes.ts`.
- **`_backend_state`** (#474): `initializeBackendState`, in the commit right after the one that creates the table
  (a transaction cannot write a table its own catalog commit creates).
- **An import's copied indexes** (#482, stacked on #480): `createHiddenTable` copies the enabled indexes as
  `Backfilling`, backfills the empty table (`IndexWorker.backfillNow`) and enables them in one commit before it
  returns, as Convex's `create_empty_table`; a table still backfilling an index is refused (`InvalidImport`).
  Convex copies search and vector indexes too; bunvex's hidden tables have none before activation (unchanged).

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| S1 | `_tables.number` was a float | Ainda não fizemos | match Convex (owner, 2026-10-05): resolved, DV-421 |
| S2 | `_index` database rows, their states and `by_id`'s fields; new-table indexes enabled at once; `_index_backfills` numbers, deleted | Ainda não fizemos | match Convex: resolved, DV-422 |
| S3 | `_schemas.state` a string; bunvex's schema JSON | Ainda não fizemos | match Convex: resolved, DV-423 |
| S4 | `_modules` / `_source_packages` encodings; `schema.js` / `auth.config.js` not stored as modules | Ainda não fizemos | match Convex: resolved, DV-424 |
| S5 | Cron rows and `_udf_config` in floats and ms; `udfArgs` an array; `serverVersion` "bunvex" | Ainda não fizemos | match Convex: resolved, DV-425 |
| S6 | Retention globals and `table_summary_v2` in bunvex's encoding | Ainda não fizemos | match Convex: resolved, DV-426 |
| S7 | No `_backend_state` row until a state changes | Ainda não fizemos | match Convex: resolved, DV-427 |
| S8 | Identity fields (`tablet`, `name`; integer tablet keys) | Ainda não fizemos: the persistence layout decides them (STUDY-133) | waiting on STUDY-133, DV-428 |
| S9 | No app definition module row (`convex.config.js`) | Ainda não fizemos: components (STUDY-62) | waiting on components, DV-429 |
| S10 | An import's copied indexes started `Enabled`; staged ones were copied; a backfilling table could be replaced | Ainda não fizemos | match Convex (owner, 2026-10-05): resolved, DV-430 (#482) |

## 4b. Additions (beyond Convex)

None.

## 5. Tests

Each PR adds a shape test per table: a row bunvex wrote, read back from the store, against the Convex rows of
the fixture, `shapeDiff` empty (identity fields left out, S8). Plus the behaviour each change touches.

The fixtures are the Convex rows of §0: `packages/core/test/convex-rows/` (and a copy for the server package's
tests in `packages/server/test/convex-rows/`, which `check:deps` keeps from importing another package's tests).

| Group | Shape tests | Sabotage (each break caught, then restored) |
|---|---|---|
| `_tables` (#473) | every kind of row bunvex writes (system, schema, a write's, an import's) against Convex's; numbers read back after a restart | float `number`; bigint left in the catalog; a write's table and an import's table stored raw (4/4) |
| `_index`, `_index_backfills` (#480) | the four revisions of a new table's index row, in order, against Convex's four; the system indexes; the backfill rows of a new table and of a push on 30 documents (database and search) | `by_id`'s field kept; float `persistenceIndexId`; new-table index enabled at once; no retention-started commit; float count; µs times; `Backfilled`; search rows mixed up; no search backfill row; lower bound from the snapshot (10/10) |
| `_schemas` (#477) | the stored `schema` text equal, byte for byte, to Convex's for the same app; the state through pending, overwritten, active, failed | `_creationTime` not appended; string state; `tableName`; float literal; unsorted tables; system fields kept (6/6) |
| `_modules`, `_source_packages` (#476) | every row of a push (a module with a source map, a `_deps` chunk, the auth config, the schema) | float positions; hex hash; float size; null analysis for schema / auth; no `sourceMapped`; hex package hash (6/6) |
| crons, `_udf_config` (#478) | `_cron_jobs`, `_cron_next_run`, `_modules.cronSpecs`, `_udf_config`; `udfArgs` byte-identical to Convex's | floats; ms ×1000; args as an array; minute omitted; camelCase ids; result not JSON text; ms seed time; ms `by_next_ts` bounds; push's version ignored (9/9) |
| globals (#475) | each retention global and `table_summary_v2` (top level and a table's summary) | µs; `table`; big-endian JsonInteger; plain-number retention; decimal `totalSize`; extra `n` (6/6) |
| `_backend_state` (#474) | the row written at the first start; a restart keeps a paused one | wrong value; int64 `user`; no row; a row per start (4/4) |
| an import's copied indexes (#482) | the copy's four revisions against Convex's; its backfill row; handed back enabled, filled, activated, queried; staged not copied; `InvalidImport` | copies `Enabled`; staged copied; no refusal; no enable commit; handed back pending (5/5) |

Measured: the start of a fresh store with 50 tables of 2 indexes each (#480) went from 7.1 ms to 23 ms (three
small commits per new table: its backfill row, retention started, `Backfilled2`, which Convex writes too).

## 6. Open questions

- The app definition module (S9) waits on components.
- The identity fields (S8) wait on STUDY-133.

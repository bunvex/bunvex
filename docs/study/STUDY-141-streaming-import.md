# STUDY-141 — Streaming import (`/api/streaming_import/*`) and the `clear_tables` audit event

- **Status:** decided (owner, 2026-10-11): Q1–Q5 as recommended (DV-447, DV-448, DV-449, DV-451 decided; DV-450
  matched to Convex). Scope: PR 1 only for now (§7); PRs 2–4 stay here as future work.
- **Convex source read:** `4577b9031` of get-convex/convex-backend (the local clone). The reference is `d8bdde0`
  (`docs/parity/upstream.md`); STUDY-137's classification of `4577b90..d8bdde0` touches none of the files below
  except the OCC writer descriptions ("A Fivetran sync", "An Airbyte sync"), which bunvex already has (DV-435).
  Also read: Airbyte's `destination-convex` 0.2.19 (airbytehq/airbyte,
  `airbyte-integrations/connectors/destination-convex`), the `slugify` 0.1.0 crate, and Convex's docs
  (`npm-packages/docs`).
- **Related:** [STUDY-42](STUDY-42-import-export.md) (snapshot import, hidden tables, `activateTables`),
  [STUDY-48](STUDY-48-audit-log.md) (the audit log), [STUDY-60](STUDY-60-streaming-export.md) and
  [STUDY-69](STUDY-69-data-sync.md) (streaming export, the connector precedent), [STUDY-108](STUDY-108-paginate-split-on-limits.md)
  (the transaction limits as `PaginationLimit`), [STUDY-137](STUDY-137-convex-reference-2026-10-07.md) R1
  (DV-435, the writer descriptions), DV-97 (`Bunvex <key>`), DV-312 (rule 5 without exceptions).

The owner asked (2026-10-11) for the `clear_tables` audit event. In Convex that event has one producer: streaming
import's `PUT /api/streaming_import/clear_tables` (and the Fivetran truncate that delegates to it). So this study
covers streaming import whole, and proposes building it in four PRs, the first of which delivers `clear_tables`.

## 1. How Convex does it

### 1.1 Routes, auth and wiring

`crates/local_backend/src/router.rs:390` nests `streaming_import_routes()` under `/api`; the routes are at
`router.rs:570–591` (a comment says the cloud proxy, Usher, mirrors them):

| Method and path (`/api/streaming_import/…`) | Handler (`crates/local_backend/src/streaming_import.rs`) | Body | Answer |
|---|---|---|---|
| `POST import_airbyte_records` | `import_airbyte_records` (58–91) | `{tables: {[name]: {primaryKey: string[][] \| null, jsonSchema: any}}, messages: [{tableName, data}]}` | 200, empty |
| `POST apply_fivetran_operations` | `apply_fivetran_operations` (93–110) | `[{table, operation: "Upsert" \| "Update" \| "HardDelete", row}]` | 200, empty |
| `GET get_schema` | `get_schema` (112–125) | none | the active schema as `DatabaseSchemaJson`, or `null` |
| `POST replace_tables` | `replace_tables` (247–267) | `{tableNames: {[string]: string}}` | always 400 `OverwriteNotSupported` |
| `PUT clear_tables` | `clear_tables` (141–182) | `{tableNames: string[]}` | 200, empty |
| `POST fivetran_truncate_table` | `fivetran_truncate_table` (184–245) | `{tableName, deleteBefore: RFC 3339 \| null, deleteType: "SoftDelete" \| "HardDelete"}` | 200, empty |
| `POST fivetran_create_table` | `fivetran_create_table` (127–139) | `{tableDefinition: TableDefinitionJson}` | 200, empty |
| `PUT add_primary_key_indexes` | `add_primary_key_indexes` (269–298) | `{indexes: {[table]: string[][]}}` | 200, empty |
| `GET primary_key_indexes_ready` | `primary_key_indexes_ready` (300–327) | `{tables: string[]}` **as a JSON body on a GET** | `{indexesReady: boolean}` |

- **Auth.** Every handler but `replace_tables` takes `ExtractIdentity` and calls
  `identity.require_operation(DeploymentOp::ImportBackups)` first: an admin key, or a deploy key with
  `deployment:backups:import` (Convex's docs, `production/integrations/streaming-import-export.mdx`). `replace_tables`
  checks nothing and fails for everyone.
- **No entitlement.** Unlike streaming export (`ensure_streaming_export_enabled`, `streaming_export.rs:184` and
  others), streaming import checks none; Convex's docs say it "is included with all Convex plans".
- **Body limits.** `import_airbyte_records` has its own: `AIRBYTE_STREAMING_IMPORT_REQUEST_SIZE_LIMIT`
  (`crates/common/src/knobs.rs:1806–1811`), `10 * (2 << 20)` = 20 971 520 bytes (20 MiB; the expression reads like
  "10 MiB" but `2 << 20` is 2 MiB). The other routes set none, so axum's default applies (to confirm on the oracle,
  §5).
- **Errors** are Convex's usual `{code, message}` JSON from `HttpResponseError`: a `bad_request` is 400, a
  `not_found` 404, an error without metadata 500 `InternalServerError`. The JSON extractor's own failures are 400s.
- **Usage.** Each handler builds a `FunctionUsageTracker` and drops it ("Not tracking streaming_import"); the
  application methods also call `usage.without_v1_database_ingress()`. Nothing is billed or shown in usage.
- **Client header.** The connectors send `Convex-Client: streaming-import-0.1.0` (Airbyte) and
  `fivetran-import-<version>` (Fivetran); `crates/common/src/version.rs:178–206` knows both names
  (`StreamingImport`, `FivetranImport`), with no version thresholds. The routes do not read it.

### 1.2 Names: `ValidIdentifier`

Table names in `import_airbyte_records`, `clear_tables`, `fivetran_truncate_table`, `add_primary_key_indexes` and
`primary_key_indexes_ready`, and field names in Airbyte records, go through `ValidIdentifier`
(`crates/application/src/valid_identifier.rs:6–33`):

- a name that parses (`TableName` / `FieldName`) and is not a system name (does not start with `_`) is kept;
- otherwise it is slugified with `slugify!(s, separator = "_")` and prefixed with `source_`; if that does not parse
  either, the error is a plain `anyhow!("Failed to create a valid identifier.")` (no metadata: a 500).

`slugify` 0.1.0 (mattgathu/slugify, `src/lib.rs:162–210`): `unidecode` (the `unidecode` 0.3.0 crate, a
transliteration table: "影師嗎" → "ying shi ma", "Æ" → "AE"), lower-case, trim whitespace, trim the separator
from both ends, spaces to the separator; then keep `a–z0–9`, turn every run of other characters into one `_` (none
at the start), and drop a trailing `_`. So `_storage` → `source_storage`, `My Table!` → `source_my_table`,
`$integer` → `source_integer`, `""` → `source_` (a valid identifier), and an over-long name (a table name is at most
64 characters) is the 500. `apply_fivetran_operations` does **not** use it: its `row.table` goes straight to
`TableName::from_str` (`crates/model/src/fivetran_import/mod.rs:72`).

### 1.3 `clear_tables` and the `ClearTables` audit event

`clear_tables` (`streaming_import.rs:147–182`) maps each name through `ValidIdentifier<TableName>` to the root
component and calls `Application::clear_tables` (`crates/application/src/lib.rs:2676–2694`) with
`ImportRequestor::StreamingImport`, which is `snapshot_import::clear_tables`
(`crates/application/src/snapshot_import/mod.rs:690–750`), "an import of empty tables in Replace mode":

1. Read the import's schemas (`schemas_for_import`) and the table mapping.
2. For each table, in order: `prepare_component_for_import` (root here), then `create_empty_table`
   (`mod.rs:1659–1701`), keeping the active table's **number** if it exists. `create_empty_table` is its own
   transaction (`snapshot_import_prepare_table`): `insert_table_for_import` makes a **Hidden** table,
   `copy_indexes_to_table` (`crates/database/src/bootstrap_model/index.rs:1052–1130`) copies every **enabled**
   index of the active table — database, text and vector, **reserved ones (`_…`) included** — as backfilling, and
   refuses with 400 `InvalidImport` ("<table> is still backfilling indexes, so it cannot be replaced. Wait for
   indexes to complete backfilling") if any index of the active table is backfilling. Then
   `backfill_and_enable_indexes_on_table` waits for the (empty) backfills and enables them.
3. `finalize_import` (`mod.rs:1025–1155`) with `ImportMode::Replace` and `AuditLogInfo::ClearTables`, in one
   transaction retried on overload (`snapshot_import_finalize`): the schema constraints of the import
   (`ImportSchemaConstraints`) are checked, `activate_tables` makes the hidden tables active, which deletes the
   active tables of the same names, and `DeploymentAuditLogModel::insert_with_member_override` writes **one**
   `clear_tables` event with the caller's member (no override) and request metadata (IP, user agent). The number of
   documents deleted is returned and the handler drops it.

Consequences an app sees:

- **Atomic switch.** Every listed table becomes empty in the same commit; a query subscribed to any of them is
  invalidated once. Writes to a table between its `create_empty_table` and the finalize go to the old table and
  are lost with it.
- **It creates.** "This will create components and tables if they don't exist" (`mod.rs:692`): clearing a missing
  table leaves an empty active table of that name.
- **Indexes survive**, including streaming import's hidden primary-key indexes, rebuilt empty.
- **Table numbers survive**, so `v.id("t")` values elsewhere keep their table.

The event (`crates/model/src/deployment_audit_log/types.rs:192–194, 490, 895`): action `clear_tables`, metadata
`{}` ("consider adding table names once this is logged for more places"). Convex's dashboard renders it as
"cleared tables" (`npm-packages/dashboard-common/src/elements/DeploymentEventContent.tsx:279`).

The other caller is `fivetran_truncate_table` with `deleteBefore: null` and `HardDelete` (§1.6). Nothing else
calls `clear_tables`; the dashboard's "Clear table" is `_system/frontend/clearTablePage`, a different path with no
such event.

### 1.4 Hidden primary-key indexes ("system indexes" on user tables)

An index descriptor is **reserved** when it is `by_id`, `by_creation_time` or starts with `_`
(`crates/common/src/types/index.rs:49–53`). `IndexName::new` refuses a reserved descriptor (`IndexNameReserved`);
`IndexName::new_reserved` requires one (`index.rs:233–250`). An index whose descriptor is reserved, or whose table
is a system table, is in the **System** category, everything else in **Application**
(`crates/database/src/bootstrap_model/index.rs:1168–1188`). What follows from that:

- **Push leaves them alone.** The index diff of a push reads only application indexes (`get_index_diff`,
  `index.rs:513–560`), so an index the schema does not declare is dropped only if it is an application index.
- **Hidden.** The dashboard's `/api/get_indexes` (`crates/local_backend/src/dashboard.rs:222–228`) and the schema
  state (`schema.rs:363–367`) list application indexes only. They do not count toward the 32 indexes a table may
  have (`IndexName::is_system_owned`).
- **Created** by `Application::_add_system_indexes` (`lib.rs:2985–3018`), one transaction (`add_system_indexes`):
  each requested index's fields go through `_validate_user_defined_index_fields` (`lib.rs:2048–2073`: `_creationTime`
  refused with 400 `IndexFieldsContainCreationTime`, a system field refused with `IndexFieldNameReserved`, then
  `_creationTime` appended); an existing index of that name (pending or enabled) with the same fields is kept,
  one with other fields is dropped; then a new **backfilling** index is added with `add_system_index`
  (`index.rs:135–146`, admin or system identity), which **creates the table** if it is missing
  (`_add_index`, `index.rs:148–167`). The index worker backfills it as any other.
- **Ready** is `IndexModel::indexes_ready(descriptor, tables)` (`index.rs:1136–1166`): for each table the pending or
  else enabled index of that descriptor, 400 `MissingIndex` ("Missing index: <table>.<descriptor>") if neither
  exists; ready when none is backfilling.
- **Enabled by its backfill.** When the index worker finishes a system index on a user table it goes straight to
  *enabled* (`crates/database/src/database_index_workers/mod.rs:651–668`), as an index on a system table does; an
  application index stops at *backfilled* until a push enables it.
- **Metered as the system's.** Its storage counts as `system_index_size` (`snapshot_manager.rs:513–517`) and its
  reads as system egress (`query/index_range.rs:231–242`).

Two descriptors use this:

- **Airbyte:** `_by_airbyte_primary_key` (`crates/model/src/airbyte_import/mod.rs:13–14`).
  `add_primary_key_indexes` parses each table with `ValidIdentifier` and each key with `PrimaryKey::try_from`
  (`crates/application/src/airbyte_import.rs:135–162`: every path segment an `IdentifierFieldName`, then
  `IndexedFields`, which refuses `_id`, duplicates and more than 16 fields); a failure is 400 `InvalidPrimaryKey`,
  "Invalid primary key: Identifiers must start with a letter and can only contain letters, digits, and
  underscores. [[…]]." (the `Debug` form of the key). Then `add_primary_key_indexes` (`lib.rs:3601–3622`) →
  `_add_system_indexes`. Note the key's fields are **not** renamed as record fields are (§1.5).
- **Fivetran:** `_fivetran_by_primary_key` and `_fivetran_by_synced`
  (`crates/fivetran_destination/src/constants.rs:76–80`), created by `fivetran_create_table` (§1.6). The schema
  parser makes one exception for them: an index name starting with `_fivetran` is parsed with `new_reserved`
  (`crates/common/src/schemas/json.rs:276–282`), so `schema.ts` may declare `.index("_fivetran_by_primary_key", …)`.
  Such a declared index is in the System category, so (reading `get_index_diff` and `add_application_index`,
  `index.rs:102–130`) a push accepts it when an identical one exists and fails ("Can't change system indexes")
  when it would have to create it. To confirm on the oracle (§5).

### 1.5 Airbyte: `import_airbyte_records`

Parsing (`airbyte_import.rs`):

- **Records** (`AirbyteRecordMessage`, 58–65, "do not modify without considering backwards compatibility"):
  `tableName` through `ValidIdentifier<TableName>`; `data` (any JSON) has **every object key at every depth**
  renamed through `ValidIdentifier<FieldName>` (`valid_json`, 67–100). A renamed key that collides with an existing
  key is prefixed `source_` again, at most `DUPLICATE_FIELD_LIMIT` = 3 times, then "Too many duplicate field names
  found for modified field <f>" (a 500). Then the JSON becomes a value by Convex's JSON decoding (numbers are
  float64; `$integer`/`$bytes` objects would decode, but their keys were already renamed, so in effect plain JSON).
- **CDC** (102–126): a record is *deleted* when its top-level `source_ab_cdc_deleted_at` (Airbyte's
  `_ab_cdc_deleted_at`, renamed) is present and not null. Every top-level field starting with `source_ab_cdc` is
  then removed.
- **Streams** (127–191): `primaryKey: null` → *append*; an empty array → 400 `EmptyPrimaryKey` ("Primary keys
  cannot be empty"); otherwise *dedup* on that key. `jsonSchema` is required in the JSON and ignored ("TODO:
  Validate schema").

Writing (`lib.rs:3656–3759`), as the caller's identity, through `UserFacingModel` (so the active schema is
enforced and a missing table is created, up to the table limit):

- One transaction for the whole request (write source `app_private_import_airbyte`). A record whose `tableName`
  has no stream is 400 `MissingStream` ("Missing stream for table <t>").
- **Append:** insert, even when the record is CDC-deleted.
- **Dedup:** read the `_by_airbyte_primary_key` index with an equality per key field; a key field missing from the
  record is 400 `MissingPrimaryKeyValue` ("Missing value for primary key field: <path:?>."). Found one: delete it
  if the record is deleted, else `replace` it with the record. Found none: insert (a deleted record too). More
  than one: "Received more than one value for query" (`crates/database/src/query/mod.rs:557–569`, a 500). If the
  index is missing the range read fails (not checked here; to confirm on the oracle).
- **Paging at a limit.** When a record's write fails with a `PaginationLimit` error (the transaction's read or
  write limits), the transaction so far commits (`airbyte_write_page`), a new one starts and the record is retried
  once. So a large request is **not atomic**: earlier pages stay committed if a later record fails.

The connector (Airbyte's `destination_convex`, `destination.py`, `writer.py`, `client.py`):

- `check` is `GET /version` with the key.
- Before records: `overwrite` streams → one `PUT clear_tables` with their table names; `append_dedup` streams with a
  primary key → `PUT add_primary_key_indexes`, then `GET primary_key_indexes_ready` (JSON body) every second until
  `indexesReady`.
- Records are buffered and sent 1000 at a time, and at each Airbyte state message, with `tables` built from the
  catalog (`primaryKey` only for `append_dedup`). Table name: `<namespace>_<stream>`.
- Headers: `Authorization: Convex <access_key>`, `Convex-Client: streaming-import-0.1.0`.
- It never calls `replace_tables` (the disabled route of an older overwrite flow).

### 1.6 Fivetran: the destination's routes

Called by Convex's Fivetran destination (`crates/fivetran_destination/src/convex_api.rs:167–222`), whose
`Destination` trait maps 1:1: `get_schema`, `create_table`, `truncate_table`, `batch_write`.

- **`get_schema`** (`lib.rs:3849–3860`): the active schema (`SchemaState::Active`) of the root component, as
  `DatabaseSchemaJson`, or JSON `null`.
- **`fivetran_create_table`** (`lib.rs:3862–3898`): parses `TableDefinitionJson` (so its `_fivetran*` index names
  pass, §1.4), ignores the document type, adds **only its database indexes** as system indexes (each
  `new_reserved`, so a non-reserved name is an error), then **holds the request** until
  `_fivetran_by_primary_key` on that table is not backfilling (a subscription loop). Observation: the destination
  sends `_fivetran_by_synced` as `["fivetran.synced", "_creationTime"]` (or with `fivetran.deleted` first,
  `constants.rs:57–74`), and `_validate_user_defined_index_fields` refuses an explicit `_creationTime`; read
  together, the schemaless create path answers 400 `IndexFieldsContainCreationTime` in this version. To confirm on
  the oracle; bunvex matches the server either way.
- **`apply_fivetran_operations`** (`lib.rs:3761–3794`, `crates/model/src/fivetran_import/mod.rs:71–118`): rows
  decoded by `common::value::json_object` (Convex's JSON value encoding, `$integer` and `$bytes` included). Per
  row: find the existing document through the table's `_fivetran_by_primary_key` system index
  (`primary_key_query`, 143–212: 400 `MissingFivetranPrimaryKeyIndex` with a message telling the developer to add
  `.index("_fivetran_by_primary_key", […])` to `schema.ts`; a `fivetran.deleted` field in the index is matched
  `= false`, `_creationTime` skipped, any other field taken from the row, 400
  `MissingValueForFivetranPrimaryKeyIndex` if absent). Then:
  - `Upsert`: replace the found document, else insert;
  - `Update`: 404 `FivetranMissingUpdatedRow` ("Fivetran is trying to update a row that doesn’t exist in the
    Convex destination.") if none, else `patch` with the row, merging the `fivetran` object field by field with the
    existing one (`fivetran_patch_value`, 312–347);
  - `HardDelete`: delete the found document; none is fine.

  One transaction (`app_fivetran_import`), paged at limits as Airbyte's (`fivetran_write_page`). The destination
  sends 500 rows a request (`application.rs:57`).
- **`fivetran_truncate_table`** (`streaming_import.rs:197–245`, `lib.rs:3796–3847`): `deleteBefore` null and
  `HardDelete` → `clear_tables` on that table (**the second producer of `clear_tables`**, which also creates the
  table if missing). Otherwise: a missing table is accepted as is; else the documents are read through
  `_fivetran_by_synced` (`synced_query`, 218–302: 400 `MissingFivetranSyncedIndex` or
  `WrongFieldsInFivetranSyncedIndex` if the index is absent or not one of the two expected field lists;
  `fivetran.deleted = false` when indexed; `fivetran.synced < deleteBefore` in epoch milliseconds when given) and
  hard-deleted or soft-deleted (`fivetran.deleted = true`, `mark_as_soft_deleted`, 349–365), one transaction per
  page (`app_fivetran_truncate`), until none is left.

Field naming in the destination (`api_types.rs:93–115`, `constants.rs`): a Fivetran column `_fivetran_synced` →
`fivetran.synced`, `_fivetran_deleted` → `fivetran.deleted`, `_fivetran_id` → `fivetran.id`, any other `_x` →
`fivetran.columns.x`; table `<schema>_<table>` (`connector.rs:399–401`).

### 1.7 Who calls these routes, and what is cloud-only

- **Airbyte** — `airbyte/destination-convex` 0.2.19, community support level, alpha, enabled on Airbyte Cloud and
  OSS. Uses `clear_tables`, `add_primary_key_indexes`, `primary_key_indexes_ready`, `import_airbyte_records`
  (§1.5). This is the integration Convex documents ("The Convex team maintains a Convex destination connector for
  streaming import").
- **Fivetran destination** — `crates/fivetran_destination`, a gRPC server (`main.rs`: port 50052, gzip) implementing
  Fivetran's partner SDK `DestinationConnector` (`fivetran_common/fivetran_sdk/…/destination_sdk.proto`): CSV batch
  files, optionally AES-256-CBC encrypted and compressed, read and sent as `apply_fivetran_operations` batches;
  `DescribeTable`/`CreateTable`/`AlterTable` checked against `get_schema` (a missing or wrong table fails with a
  suggested `schema.ts` to paste); `WriteHistoryBatch` unimplemented. Fivetran hosts it. Its listing docs are
  `hidden: true`, and Convex's docs say "Streaming import into Convex via Fivetran is not supported."
- **Fivetran source** (`crates/fivetran_source`) is streaming **export** (STUDY-60/69), not this.
- **Nothing else**: not the CLI, not the dashboard. Convex's http-api docs only say these routes need
  `Authorization: Convex <access_key>` (`docs/http-api/index.mdx:30–33`).
- **Cloud-only:** nothing in the routes. In the cloud they go through Usher (closed source), which mirrors them;
  self-hosted Convex serves them itself. Both connectors target any deployment URL with a key.

## 2. What an app can observe

- The nine routes, their methods, bodies, answers and errors (§1.1–§1.6), with `ImportBackups`.
- `clear_tables`: the tables empty in one commit, created if missing, indexes and numbers kept; one `clear_tables`
  event (`{}`), with the caller's member and request, in `_deployment_audit_log` and
  `GET /api/v1/list_audit_log_events`; an OCC conflict it causes says "A data import" (write source
  `snapshot_import_finalize`).
- The documents Airbyte and Fivetran write: renamed tables and fields, CDC fields gone, dedup by key, the
  `fivetran` object; the schema enforced; paging at the transaction limits (not atomic past one page).
- Hidden indexes: absent from the dashboard's index list and from the push's diff, not counted in the 32, kept by
  a push, copied by a clear or a Replace import.
- An OCC conflict caused by these writers: "An Airbyte sync" / "A Fivetran sync" (labels contain `airbyte` /
  `fivetran`).
- No usage recorded.

## 3. How bunvex does it

bunvex has most of the machinery: hidden tables and their one-commit activation (`Engine.createHiddenTable`,
`Engine.activateTables` with a body run in the activating transaction, `packages/core/src/engine.ts:2905–3056`,
STUDY-42), the audit log (`insertAuditLogEvents`, `auditEvents`), `ImportBackups`
(`packages/server/src/admin-keys.ts`), `PaginationLimit` errors (`isPaginationLimit`, `packages/core/src/tx.ts:242`),
the writer descriptions (`writerDescription`, `engine.ts:3696–3703`), the schema JSON (`schemaToJson`).

What is missing:

1. **System indexes on user tables.** bunvex's catalog plans indexes from the schema only: `planCatalog` deletes a
   stored pending index the schema does not declare and `finishCatalog` drops an enabled one
   (`packages/core/src/catalog.ts:711–800`). It needs Convex's split: an index with a reserved descriptor (`_…`) is
   the system's; a push neither plans nor drops it; the dashboard's index list and the schema state omit it; it does
   not count toward the 32. New engine methods: `addSystemIndexes(table → fields)` (Convex's
   `_add_system_indexes`, creating the table when missing, backfilled by the existing `IndexWorker`) and
   `indexesReady(descriptor, tables)`; the backfill enables such an index itself, as bunvex already does for a
   system table's (`engine.ts` `createHiddenTable`: "a system table's are enabled by the backfill itself"),
   and its bytes are metered as the system's (`isReservedIndex`, `packages/core/src/schema.ts:647–649`,
   already exempts `_…` names). `createHiddenTable` already copies every enabled non-`by_*` index, so clears
   and Replace imports carry them over once they exist.
2. **`_fivetran*` index names in `schema.ts`.** bunvex refuses every `_` name (`packages/core/src/schema.ts:357`);
   Convex lets `_fivetran…` through (§1.4).
3. **The routes**, in a new `packages/server/src/streaming-import.ts`, mounted in `server.ts` next to `/api/import`,
   each starting with `requireOperation(caller, "ImportBackups")`:
   - a `validIdentifier(name, kind)` with Convex's rules and the `slugify` steps (Q4 for the transliteration);
   - `clearTables(names, actor)` in `ImportService` (`imports.ts`): per table `createHiddenTable(name, {number,
     copyIndexesOf})`, then `activateTables(hidden, [], body)` whose body checks that the schema did not change and
     inserts `auditEvents.clearTables()` (`{action: "clear_tables", metadata: {}}`) with the caller's actor;
   - Airbyte records and streams parsing, append/dedup through `db.query(table).withIndex("_by_airbyte_primary_key",
     …)` as system code, CDC, paging on `isPaginationLimit` (a new transaction per page, the record retried once);
   - Fivetran operations, the `fivetran` metadata merge, truncate (soft, hard, `deleteBefore`), create-table that
     waits for its index;
   - write sources under `_system/` carrying Convex's labels (`_system/app_private_import_airbyte`,
     `_system/airbyte_write_page`, `_system/app_fivetran_import`, `_system/fivetran_write_page`,
     `_system/app_fivetran_truncate`), so `writerDescription` already names them.
4. The bunvex dashboard's History text for `clear_tables` reads `metadata.tables` / `metadata.count`
   (`packages/dashboard/src/history/describe.ts:61`), which Convex never sends: it becomes "Cleared tables", as
   Convex's "cleared tables".

Rule 5 (no "convex" in shipped strings) touches:

- `FivetranMissingUpdatedRow`'s message ("…in the Convex destination.") — Q3;
- the `docs.convex.dev` link in `IndexFieldsContainCreationTime` — bunvex's existing reworded message is used;
- the auth scheme the connectors send, `Convex <key>` — Q2;
- the client header `Convex-Client` — not read by these routes, so nothing to rename;
- the Fivetran destination's own names (`ConvexFivetranDestination`, `convex_destination`, the `Convex-Client`
  header it sends) — only if Q1 brings that program in.

The route paths, codes (`OverwriteNotSupported`, `MissingStream`, …), descriptors (`_by_airbyte_primary_key`,
`_fivetran_by_*`), the `fivetran` field, the `source_` prefix and the connector names `airbyte`/`fivetran` contain
no "convex" and stay as they are.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| Q1 (DV-447) | bunvex ships the HTTP routes only, no Fivetran destination program (Convex's `fivetran_destination` gRPC server). | **Not built yet, and recommended not to be.** The program runs on Fivetran's infrastructure as a partner connector; a bunvex port would be a separate app (gRPC, CSV, AES-CBC, zstd/gzip, its own schema suggestions) that Fivetran would have to host. Convex itself says streaming import through Fivetran "is not supported" and hides the listing. **App impact:** none on apps; the routes stay callable by anything that speaks them. **Recommendation:** HTTP routes only. | **decided** (owner, 2026-10-11): HTTP routes only |
| Q2 (DV-448) | The published connectors authenticate with `Authorization: Convex <key>`; bunvex answers that 400 `InvalidAdminKey`, as it does everywhere (DV-97). | **Rule 5.** Option A: keep DV-97 — Airbyte's `destination-convex` cannot reach bunvex unmodified; a user needs a fork that sends `Bunvex <key>` (the precedent of STUDY-69 for data sync, DV-312: a connector written for Convex must send bunvex's names). Option B: accept the `Convex ` scheme on `/api/streaming_import/*` only — a rule-5 exception, which DV-312 removed. **App impact:** with A, no off-the-shelf connector works; the routes serve custom clients and forks. **Recommendation:** A, for consistency with DV-97/DV-312, accepting that the Airbyte connector needs a one-line fork. | **decided** (owner, 2026-10-11): A, only `Bunvex <key>`; the published Airbyte connector needs a one-line fork (its `_get_auth_headers`) |
| Q3 (DV-449) | `FivetranMissingUpdatedRow` reads "…a row that doesn’t exist in the destination." (Convex: "…in the Convex destination."). Code, status (404) and the rest of the text kept. | **Rule 5.** **App impact:** only the message text. **Recommendation:** reword so. | **decided** (owner, 2026-10-11): reworded, as recommended (built with PR 4) |
| Q4 (DV-450, only if B) | Names that need slugifying and contain non-ASCII characters. Option A: transliterate exactly as `unidecode` 0.3.0 (a new dependency with the same table, or a generated data file), checked character by character against the oracle. Option B: no transliteration — a non-ASCII character is a separator (`"Café"` → `source_caf`, Convex `source_cafe`). | **Not built yet** (A) / a choice of cost (B). **App impact:** table and field names of imported data with non-ASCII names (B gives other names than Convex). **Recommendation:** A if an npm package matches the crate's table on the oracle, else a generated table in `@bunvex/server`. | **decided** (owner, 2026-10-11): A, match Convex's transliteration exactly, verified against Convex's binary (no divergence) |
| Q5 (DV-451) | `GET /api/streaming_import/primary_key_indexes_ready` carries its `{tables}` in a JSON body; Bun's server drops the body of a GET (measured: Bun 1.4.2, `Content-Length` body, handler reads `""`). Proposal: with no body, answer for **every** `_by_airbyte_primary_key` index (ready when none is backfilling); with a body (should Bun ever pass one), Convex's behaviour. | **Cannot be done** with `Bun.serve`. **App impact:** the connector polls until every primary-key index is ready instead of its tables' — the same answer unless other tables are backfilling one; no `MissingIndex` for a table without the index (it answers `true` once the others are ready). **Recommendation:** the proposal. | **decided** (owner, 2026-10-11): as recommended (built with PR 2) |

Recorded in [docs/parity/divergences.md](../parity/divergences.md): DV-447, DV-448, DV-449 and DV-451 as decided
divergences, DV-450 as resolved to match Convex.

Not divergences (matched as Convex, noted because they look odd): `replace_tables` always 400 and unauthenticated;
`clear_tables` creating missing tables; Append inserting CDC-deleted records; keys of `add_primary_key_indexes` not
renamed while record fields are; the non-atomic paging; the schemaless `fivetran_create_table` refusing the
destination's own sync index (§1.6, to confirm); usage not recorded.

## 4b. Additions (beyond Convex)

None proposed.

## 5. Tests

- **Oracle first.** `packages/differential` starts Convex's `precompiled-2026-10-07-d8bdde0` binary and bunvex
  side by side (`harness/backends.ts`). Each PR adds a differential test that sends the same requests to both
  (Convex with `Convex <key>`, bunvex with `Bunvex <key>`) and compares statuses, codes, messages (modulo DV-449)
  and the resulting documents, audit events and index lists:
  - PR 1: `clear_tables` on existing, missing, system-named and invalid names (slug cases, a 65-character name);
    the audit event's shape and actor; an index kept; a subscribed query invalidated once; a backfilling index
    refused; `get_schema` with and without a schema; `replace_tables`; no key / a key without `ImportBackups`;
    axum's default body limit on these routes.
  - PR 2: `add_primary_key_indexes` (new table created, same fields kept, other fields replaced, `_creationTime`
    and `_x` refused, `InvalidPrimaryKey` text), readiness, hidden from `/api/get_indexes`, kept across a push,
    copied by `clear_tables`; `schema.ts` declaring `_fivetran_by_primary_key` with and without an existing index;
    whether a function can `withIndex` a reserved index.
  - PR 3: append, dedup insert/replace/delete, CDC fields, renamed and colliding keys (3 rounds), `MissingStream`,
    `EmptyPrimaryKey`, `MissingPrimaryKeyValue`, a write over the transaction limit committed in pages, schema
    violations, the 20 MiB limit.
  - PR 4: each operation, the metadata merge, truncate soft/hard/`deleteBefore`, missing indexes, the full hard
    truncate's `clear_tables` event, `fivetran_create_table` (including the `_creationTime` observation).
- **Unit tests** for `validIdentifier`/slugify (the crate's documented examples), the record conversion, the patch
  merge.
- **Sabotage** per PR: drop the audit insert; activate tables one by one; skip the `_` filter in `planCatalog`;
  skip the CDC filter; skip the metadata merge — each must fail a test.
- No benchmark needed: these routes are off the function path.

## 6. Open questions

None: Q1–Q5 were decided by the owner (2026-10-11). Everything else is decided by "match Convex".

## 7. Plan

Sizes: S < 300 lines, M 300–900, L > 900 (code and tests).

| PR | Content | Size | Needs |
|---|---|---|---|
| 0 | This study (draft). | docs | — |
| 1 (**build now**) | `/api/streaming_import/*` mounted with `ImportBackups`; `validIdentifier`; `clear_tables` (hidden tables + one activation + the `clear_tables` event), `get_schema`, `replace_tables`; the dashboard's History text; parity rows. **Delivers the owner's ask.** | M (~500) | Q2, Q4 |
| 2 | System indexes on user tables in `@bunvex/core` (push leaves `_…` indexes alone, hidden from index lists, not counted; `addSystemIndexes`, `indexesReady`); `_fivetran*` names in `schema.ts`; `add_primary_key_indexes`, `primary_key_indexes_ready`. | L (~900–1100) | Q5 |
| 3 | `import_airbyte_records`: records, streams, CDC, append/dedup, paging at the limits, 20 MiB body limit, `_system/…airbyte…` write sources. | M (~600) | PR 2 |
| 4 | Fivetran routes: `apply_fivetran_operations`, `fivetran_truncate_table`, `fivetran_create_table`. | M–L (~800) | PR 2, Q3 |

The owner scoped the work to PR 1 (2026-10-11); PRs 2–4 are future work. PR 1 needs nothing from PRs 2–4: a table's existing indexes are copied by `createHiddenTable` already, and the
hidden primary-key indexes only exist after PR 2. Not planned: a Fivetran destination program (Q1), a fork of the
Airbyte connector (Q2 A leaves that to users).

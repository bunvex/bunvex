# STUDY-133 — A persisted layout identical to Convex's (cross-open)

- **Status:** accepted (owner, 2026-10-05): the goal, the design and Q1–Q11 decided (§8a); the PR series
  of §7 is being built.
- **Built so far:** PR 1 (ns `bigint` timestamps), PR 2 (identity), PR 3 (the interface, with PR 11).
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend; the binary
  `precompiled-2026-09-28-5c7cb5b/convex-local-backend` for the probes in §1.12.
- **bunvex code read:** `main` at `64f396f7`.
- **Related:**
  - [STUDY-09](STUDY-09-persistence-layout.md): the layout study this one replaces (D6–D8).
  - [STUDY-04](STUDY-04-table-and-index-metadata.md): `_tables` / `_index` (D1, D5).
  - [STUDY-06](STUDY-06-transactions-and-occ.md) D9: commit timestamps (DV-30).
  - [STUDY-25](STUDY-25-persistence-lifecycle.md): layout version, `read_only`, leases (L6, L7, L9).
  - [STUDY-33](STUDY-33-retention.md), [STUDY-72](STUDY-72-table-summary-checkpoints.md),
    [STUDY-111](STUDY-111-search-segments.md), [STUDY-42](STUDY-42-import-export.md),
    [STUDY-60](STUDY-60-streaming-export.md), [STUDY-29](STUDY-29-index-backfill.md).
  - [PERSIST-01](../specs/PERSIST-01-contract.md): C1, C10–C16 and K22 change.

## 0. The decision and what it means

The owner decided on 2026-10-05: **bunvex's persisted layout must be identical to Convex's**, so that a
store written by Convex (SQLite, Postgres or MySQL) opens in bunvex, and a store written by bunvex opens in
Convex. There is no legacy data (alpha, test data only), so nothing is migrated. This reverses DV-53, DV-67
and DV-68, reverses the internal microseconds of DV-30, and builds DV-66 (`prev_ts`).

"Identical layout" is necessary but not sufficient. A real cross-open also needs the same **contents**: the
bootstrap globals, the `_tables` / `_index` documents, the system tables and the exact shape of their
documents, the `_db` version, and code that both sides can run. §1 is Convex's layout and contents, §3 is
bunvex's, §4 lists every difference, §5 is the design, §6 is what a cross-open needs beyond the raw layout
and what cannot be done, and §7 is the PR series.

The evidence is a pair of stores written by the same app on both systems (`app/` with `schema.ts`,
`fns.ts`, `crons.ts`: one table with every value type, an index, a search index, a stored file, a cron, a
scheduled function and an environment variable), dumped and compared, plus probes of Convex opening
modified copies of its own store (§1.12).

## 1. How Convex does it

### 1.1 Ids

- **`InternalId`** is 16 bytes: 14 random bytes (ChaCha12, seeded per transaction) then the day number
  since the epoch as a big-endian `u16` (`crates/database/src/transaction_id_generator.rs:20-56`;
  `crates/value/src/document_id.rs:244-248`). Ordering is bytewise. Its string form is base64url without
  padding, 22 characters (`document_id.rs:350-354`).
- **`TabletId(InternalId)`** (`crates/value/src/table_name.rs:128-129`) is **the internal id of the
  table's `_tables` document** (`crates/database/src/database.rs:470`,
  `crates/database/src/bootstrap_model/table.rs:558-563`). A dropped table's rows stay under its tablet;
  a new table of the same name gets a new tablet.
- **`IndexId(InternalId)`** (`crates/common/src/types/index.rs:355`) is the internal id of the index's
  `_index` document.
- **`TableNumber(u32)`** (> 0) is what developer ids carry. `DeveloperDocumentId` is
  `VInt(table number) ‖ internal id ‖ footer`, the footer being `fletcher16(...)` mod 256, little-endian,
  XOR version 0, in lowercase Crockford base32 (`crates/value/src/id_v6.rs:1-158`, `base32.rs:24-51`).
- A document in persistence is `(TabletId, InternalId)`; its `_id` string is derived from the table
  number of the tablet. bunvex's id encoder already produces the same strings (verified on 37 `_tables`
  documents of the Convex store).

### 1.2 Timestamps

`Timestamp` is a `u64` of **nanoseconds**, stored as `i64`/`BIGINT` (SQLite binds it as an integer). On
Linux the clock has nanosecond resolution, so two commits may be closer than a microsecond; on macOS the
stored values end in `000` (the probe store). `prev_ts` is the ts of the previous version of the **same
document**, set by the committer from the old document it replaced
(`crates/database/src/committer.rs:995`, copied into `DocumentLogEntry` at `committer.rs:1063-1068`); the
drivers only store it.

### 1.3 The document JSON

`json_value` is `ConvexValue::json_serialize()` of the whole document, `_id` and `_creationTime` included
(`crates/value/src/json/mod.rs:97-148, 287-291`; `crates/common/src/document.rs:522-541`):

- `Int64` → `{"$integer": base64(i64 LE)}`; `Bytes` → `{"$bytes": …}`; `Float64` → a JSON number written by
  `serde_json` (`1.0`, `-2.0`), except NaN, ±∞ and −0 → `{"$float": …}`.
- On read a plain JSON number is a `Float64` (probe P7: a document rewritten with `"n":2` reads back as
  `2.0`), so `1` and `1.0` are the same value. An **integer-typed** field written as a plain number is not:
  `_tables.number` as `10001` fails the load ("Invalid type: received Float64, expected Int64", probe P5).

### 1.4 Index keys

`IndexKey::to_bytes()` (`crates/common/src/index.rs:105-145`, `crates/value/src/sorting.rs:111, 303`)
writes each indexed value's sort key, then `_id` **as a string value** (tag `0x10`, the developer id,
`0x00`). Postgres and MySQL split a key over 2 500 bytes (`MAX_INDEX_KEY_PREFIX_LEN`, `index.rs:28-76`)
into `key_prefix`, `key_suffix` and the SHA-256 of the full key. bunvex's keys are byte-identical
(`packages/values/src/sorting.ts`; the probe stores' `by_id` keys compare equal in form).

### 1.5 SQLite (`crates/sqlite/src/lib.rs`)

DDL, run with `CREATE … IF NOT EXISTS` on every open (`lib.rs:608-648`):

```sql
CREATE TABLE documents (id BLOB NOT NULL, ts INTEGER NOT NULL, table_id BLOB NOT NULL,
    json_value TEXT NULL, deleted INTEGER NOT NULL, prev_ts INTEGER,
    PRIMARY KEY (ts, table_id, id));
CREATE INDEX documents_by_table_and_id ON documents (table_id, id, ts);
CREATE TABLE indexes (index_id BLOB NOT NULL, ts INTEGER NOT NULL, key BLOB NOT NULL,
    deleted INTEGER NOT NULL, table_id BLOB NULL, document_id BLOB NULL,
    PRIMARY KEY (index_id, key, ts));
CREATE TABLE persistence_globals (key TEXT NOT NULL, json_value TEXT NOT NULL, PRIMARY KEY (key));
```

- `id`, `table_id`, `index_id`, `document_id` are the raw 16 bytes. A deleted document has
  `json_value NULL, deleted 1`; an index tombstone has `deleted 1` and NULL `table_id`/`document_id`
  (`lib.rs:305-353`). The key is stored whole (no split).
- **No pragmas** anywhere in the crate: the default rollback journal (`journal_mode` reads `delete` on the
  probe store), rusqlite 0.32 bundled, one connection behind a mutex (`lib.rs:81-106`).
- **No lock, no lease, no `read_only` table, no version check.** `is_fresh()` is "the file did not exist
  when opened" (`lib.rs:93-106, 281-283`).
- Index scan: the newest entry per key at or below the snapshot, joined to `documents` **at the entry's
  exact ts** (`LEFT JOIN documents C ON B.ts = C.ts AND B.table_id = C.table_id AND B.document_id = C.id`,
  `lib.rs:164-183`). Writes are `INSERT` (or `INSERT OR REPLACE` for `ConflictStrategy::Overwrite`,
  `lib.rs:714-720`). `load_documents` orders by `(ts, table_id, id)` (`lib.rs:676-698`).

### 1.6 Postgres (`crates/postgres/src/sql.rs`, `lib.rs`)

One layout (`postgres-v5`; `crates/clusters/src/db_driver_tag.rs:41-50`). `init_sql` (`sql.rs:49-255`),
each statement guarded by `to_regclass(…) IS NULL`:

```sql
CREATE TABLE documents (id BYTEA NOT NULL, ts BIGINT NOT NULL, table_id BYTEA NOT NULL,
    json_value BYTEA NOT NULL, deleted BOOLEAN DEFAULT false, prev_ts BIGINT);
ALTER TABLE documents ADD PRIMARY KEY (ts, table_id, id);
CREATE INDEX documents_by_table_and_id ON documents (table_id, id, ts);
CREATE INDEX documents_by_table_ts_and_id ON documents (table_id, ts, id);
CREATE TABLE indexes (index_id BYTEA NOT NULL, ts BIGINT NOT NULL, key_prefix BYTEA NOT NULL,
    key_suffix BYTEA NULL, key_sha256 BYTEA NOT NULL, deleted BOOLEAN,
    table_id BYTEA NULL, document_id BYTEA NULL);
ALTER TABLE indexes ADD PRIMARY KEY (index_id, key_sha256, ts);
CREATE INDEX indexes_by_index_id_key_prefix_key_sha256 ON indexes (index_id, key_prefix, key_sha256);
CREATE TABLE leases (id BIGINT NOT NULL, ts BIGINT NOT NULL, PRIMARY KEY (id));
CREATE TABLE read_only (id BIGINT NOT NULL, PRIMARY KEY (id));
CREATE TABLE persistence_globals (key TEXT NOT NULL, json_value BYTEA NOT NULL, PRIMARY KEY (key));
INSERT INTO leases (id, ts) VALUES (1, 0) ON CONFLICT DO NOTHING;
```

- `json_value` is the JSON text as bytes; **a deleted row stores the bytes `null`** with `deleted true`
  (the column is NOT NULL, `lib.rs:1897-1919, 1982`). Globals are JSON text bytes (`lib.rs:647-650`).
- Multitenant mode (an `instance_name` column on every table) exists but self-hosted never uses it
  (`crates/clusters/src/lib.rs:53-68`). The **database name is the instance name with `-` → `_`**, set as
  the URL path; a URL that already has a path is refused (`clusters/src/lib.rs:28-108`). The schema is
  `current_schema()`.
- Open (`lib.rs:282-355`): `target_session_attrs=read-write` required; `init_sql`; refuse if a `read_only`
  row exists unless `allow_read_only` ("persistence is read-only, data migration in progress"); fresh =
  no `documents` row; then the lease.
- **Lease** (`lib.rs:1757-1895`, `sql.rs:721-755`): `UPDATE leases SET ts=$now_ns WHERE id=1 AND ts<$now`
  must change one row; every write transaction checks `ts = mine … FOR SHARE` before commit. The newest
  process wins; the old one fails its next write (`lease_lost_error`).
- Writes: `UNNEST` inserts of ≤ 1 024 rows, `MAX_INSERT_SIZE = 56000` documents per write.
- There is **no shape or version check**; everything is `IF NOT EXISTS`.

### 1.7 MySQL (`crates/mysql`)

Two layouts. **v5** is the one self-hosted uses (`--db mysql-v5`, `self-hosted/docker-build/run_backend.sh:10`);
**v6** (`indexes_latest`, per-bucket `indexes_log_*`, integer `PersistenceIndexId`, `deployment_id`) is
multitenant-only and refuses a v5 database (`v6/persistence.rs:161-271, 1379-1389`).

v5 DDL (`v5/mod.rs:91-188`), run only when fewer than 5 tables exist in the schema
(`v5/persistence.rs:154-173`):

```sql
CREATE TABLE documents (id BINARY(16) NOT NULL, ts BIGINT NOT NULL, table_id BINARY(16) NOT NULL,
    json_value LONGBLOB NOT NULL, deleted BOOLEAN DEFAULT false, prev_ts BIGINT,
    PRIMARY KEY (ts, table_id, id), INDEX documents_by_table_and_id (table_id, id, ts)) ROW_FORMAT=DYNAMIC;
CREATE TABLE indexes (index_id BINARY(16) NOT NULL, ts BIGINT NOT NULL, key_prefix VARBINARY(2500) NOT NULL,
    key_suffix LONGBLOB NULL, key_sha256 BINARY(32) NOT NULL, deleted BOOLEAN,
    table_id BINARY(16) NULL, document_id BINARY(16) NULL,
    PRIMARY KEY (index_id, key_prefix, key_sha256, ts)) ROW_FORMAT=DYNAMIC;
CREATE TABLE leases (id BIGINT NOT NULL, ts BIGINT NOT NULL, PRIMARY KEY (id)) ROW_FORMAT=DYNAMIC;
CREATE TABLE read_only (id BIGINT NOT NULL, PRIMARY KEY (id)) ROW_FORMAT=DYNAMIC;
CREATE TABLE persistence_globals (`key` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
    json_value LONGBLOB NOT NULL, PRIMARY KEY (`key`)) ROW_FORMAT=DYNAMIC;
INSERT INTO leases (id, ts) VALUES (1, 0) ON DUPLICATE KEY UPDATE id = id;
```

- **Document encoding** (`crates/mysql/src/document_encoding.rs`), chosen by the knob
  `MYSQL_DOCUMENT_ENCODING`, **default 1** (`crates/common/src/knobs.rs:1241-1242`):
  - v0: the JSON text; a deleted row is `null`;
  - v1: byte `0x01`, the uncompressed length (u32 BE), then an **LZ4 block with a fixed dictionary** of the
    document's **sort-key encoding** (`write_sort_key(Object(doc))`), not JSON; a deleted row is empty.
  - Reads dispatch on the first byte (empty → deleted, `{`/`n` → v0, `0x01` → v1), so both are always
    readable.
- The crate never creates the database; the database name is the instance name with `-` → `_`
  (`convex_self_hosted` by default). The lease and `read_only` work as on Postgres (`v5/sql.rs:208-273`).
- Writes: chunks of ≤ 128 rows / 10 MiB, `MAX_INSERT_SIZE = 56000` (`chunks.rs:117-177`).

### 1.8 Persistence globals (`crates/common/src/persistence/mod.rs:210-268`)

| Key | Value | Written by |
|---|---|---|
| `tables_table_id`, `index_table_id` | JSON string: the tablet id of `_tables` / `_index` (base64url) | bootstrap, `database.rs:1507-1518` |
| `tables_by_id`, `index_by_id` | JSON string: the `IndexId` of `_tables.by_id` / `_index.by_id` | bootstrap, `database.rs:1647-1666` |
| `max_repeatable_ts` | **a plain JSON number** (i64 ns, above 2^53) | committer, `committer.rs:838-842`; `sync_types/src/timestamp.rs:154-169` |
| `min_snapshot_ts`, `confirmed_deleted_ts`, `document_min_snapshot_ts`, `document_confirmed_deleted_ts` | `{"$integer": …}` (i64 ns) | retention, `retention.rs:654-664, 1460-1468` |
| `table_summary_v2` | `{"tables": {<tablet base64url>: {"totalSize": <JsonInteger>, "inferredTypeWithOptionalFields": <shape>}}, "ts": <JsonInteger>}` | `table_summary.rs:235-280, 380-421` |

A JsonInteger here is standard base64 with padding of the i64 LE (12 characters). A shape is
`{numValues, variant: {kind, …}}` with Convex's kind names (`Id {tableNumber}`, `Object {fields:
[{fieldName, type: {type, optional}}]}`, …; `crates/shape_inference/src/json.rs:33-286`). The four
bootstrap globals are required: without them the load fails ("missing _tables.by_id global", probe P8).

### 1.9 Bootstrap and the catalog documents

`Database::initialize` (`database.rs:1461-1682`) runs only when the store is fresh. **Every bootstrap row
is written at ts 0** (`Timestamp::MIN`, `database.rs:1632`) with `prev_ts` NULL; `_creationTime`s come from
the clock. It creates the ten bootstrap tables of `bootstrap_system_tables()`
(`bootstrap_model/defaults.rs:60-92`): `_tables` 513, `_index` 514, `_schemas` 532,
`_index_worker_metadata` 542, `_component_definitions` 543, `_components` 544, `_index_backfills` 548,
`_schema_validation_progress` 549, `_next_persistence_index_id` 554, `_schema_validations` 555. Each gets:

- a **`_tables` document whose internal id is the table's tablet id**, `_tables` and `_index` included;
- a `by_id` `_index` document, and `by_creation_time` for every table except `_index`;
- `_index` documents for the table's declared system indexes (e.g. `_tables.by_name` on `["name"]`);
- a sequential `persistenceIndexId` per index from 1, and one `_next_persistence_index_id` document.

On load (`database.rs:715-889`) Convex reads the four globals, fetches the two bootstrap `_index`
documents, scans `_index` and `_tables` through their `by_id` indexes, **parses every one of them**
(`database.rs:425-442`), builds the table mapping and the index registry, checks the invariants (every
active or hidden tablet has an enabled `by_id`; every indexed tablet exists; exactly one `_index.by_id`,
`database.rs:936-962`, `crates/indexing/src/index_registry.rs:115-142`), then parses `_schemas` and
`_components`.

**`_tables` document** (`crates/common/src/bootstrap_model/tables.rs:75-147`): `name: string`,
`number: int64`, `state: "active" | "hidden" | "deleting"`, and `namespace` only for a component's table
(`{kind: "byComponent", id: <the _components document id>}`).

**`_index` document** (`bootstrap_model/index/index_metadata.rs:271-307`, `index_config.rs:210-281`):
snake_case top level `table_id` (the tablet id, base64url), `descriptor`, `config`:

- `{"type": "database", "fields": [...], "onDiskState": …, "persistenceIndexId"?: int64}`;
  `onDiskState` is `{"type": "Backfilling", "backfillState": {indexCreatedLowerBound?, retentionStarted?,
  staged?}}`, `{"type": "Backfilled2", "staged"?}` or `{"type": "Enabled"}`
  (`database_index/index_state.rs:64-123`). `by_id` has `fields: []`; user indexes carry the appended
  `_creationTime` (`["s", "n", "_creationTime"]` in the probe); a system index has exactly its declared
  fields (`_file_storage.by_storage_id` is `["storageId"]`).
- `{"type": "search", "searchField", "filterFields", "onDiskState": {"state": "backfilling" |
  "backfilling2" | "backfilled" | "backfilled2" | "snapshotted", …}}` — the text index's segment metadata
  lives **here** (`text_index/index_state.rs:52-66`, `index_snapshot.rs:92-251`): `{data: {data_type:
  "MultiSegment", segments: [{segment_key, id_tracker_key, deleted_terms_table_key, alive_bitset_key,
  num_indexed_documents, num_deleted_documents, size_bytes_total, id}]}, ts, version: 2}`. The segment
  files are Tantivy archives in object storage.
- `{"type": "vector", "dimensions", "vectorField", "filterFields", "onDiskState": …}` with Qdrant segments
  (`vector_index/index_state.rs:62-72`).

### 1.10 System tables, virtual tables and the `_db` version

After the bootstrap, `initialize_application_system_tables` (`crates/model/src/lib.rs:409-485`, called
from `crates/local_backend/src/lib.rs:168-190`) creates **every missing** system table of
`app_system_tables()` in the global namespace (`lib.rs:589-627`): `_db`, `_deployment_audit_log`,
`_environment_variables`, `_auth`, `_external_deps_packages`, `_session_requests`, `_backend_state`,
`_exports`, `_snapshot_imports`, `_function_handles`, `_canonical_urls`, `_log_sinks`,
`_audit_log_config`, `_aws_lambda_versions`, `_backend_info`, `_usage_limits`, `_data_sync_progress`, and
the component system tables `_file_storage`, `_scheduled_jobs`, `_scheduled_job_args`, `_cron_jobs`,
`_cron_job_logs`, `_cron_next_run`, `_modules`, `_udf_config`, `_source_packages`. Numbers are 512 + n
(`lib.rs:263-312`) on a best-effort basis (`transaction.rs:912-965`). On existing tables it adds missing
declared indexes as `Backfilling` and drops undeclared non-default ones (`lib.rs:507-584`). For each
non-root component it creates the component tables in that component's namespace (`lib.rs:447-468`).

- **Virtual tables:** `_storage` is a view of `_file_storage` and `_scheduled_functions` of
  `_scheduled_jobs` (`model/src/file_storage/mod.rs:82, 106-114`; `scheduled_jobs/mod.rs:84, 137-145`).
  They have no `_tables` rows; the stored tables carry the real names.
- **`_db`** holds `{version: int64, awsPrefixSecret, storageType: null | {tag: "local", dir} | {tag: "s3",
  s3Prefix}}` (`model/src/database_globals/types.rs:21-65`); it is inserted only when the `_db` table is
  created. `DATABASE_VERSION = 133` (`crates/migrations_model/src/lib.rs:38`). A background
  `MigrationWorker` (`model/src/migrations.rs:54-133`) migrates a lower version one step at a time,
  panics on ≤ 116 ("Transition too old!"), and only **warns** on a higher one. Startup does not wait for it.
  `initialize_storage_tag` checks `storageType` against the configuration (a different local directory is
  allowed; `database_globals/mod.rs:94-158`). A `_db` table without its document breaks it ("Database
  globals were not found??").
- **`_backend_state`** must have its document (`{system, usage_limit, user}`, all `"none"`;
  `backend_state/types.rs:15-21`), else "Backend must have a state." when read.

### 1.11 Tables and fields Convex does not know

From the load path (`table_registry.rs:49-58`, `database.rs:425-462, 936-962`; `deny_unknown_fields`
appears nowhere in the bootstrap models) and the probes:

- an **unknown system table** (e.g. bunvex's `_instance`) is loaded like any other table, provided it has
  enabled `by_id` (and `by_creation_time`) `_index` rows; without `by_id` the load fails
  ("Missing `by_id` index for _instance", probe P2);
- **unknown fields** in a known system document are ignored (`tablet` on a `_tables` row, an extra field
  on `_backend_state`: probes P3, P4); **a wrong type or enum** in `_tables`, `_index`, `_schemas` or
  `_components` **fails the load** (probes P5, P6); in other system tables it fails whatever reads it, later;
- unknown persistence globals and unknown SQL tables are ignored (probes P1, P9);
- table summaries: a **missing** `table_summary_v2` is recomputed; an **unparseable** one is an error retried
  every 10 s forever, so counts stay unavailable (`table_summary.rs:361-377, 564-647`;
  `application/src/table_summary_worker.rs:152-203`).

### 1.12 Probes (the Convex binary on modified copies of its own store)

Each probe copies the Convex store, changes one thing (with the matching `indexes` rows, since reads join
on the entry's exact ts), restarts the Convex backend on it, runs a query and a mutation, and reads the log.

| # | Change | Result |
|---|---|---|
| P1 | `journal_mode = wal`, an extra `read_only` table, an extra table, a `.lock` file next to it | opens, reads, writes; the file stays in WAL mode |
| P2 | a `_tables` row for `_instance` (number 9999) with a document, no `_index` rows | **load fails**: "Missing `by_id` index for _instance" |
| P2b | the same with `by_id` and `by_creation_time` `_index` rows | opens, reads, writes |
| P3 | an extra `tablet` field on a `_tables` row (as bunvex writes) | opens |
| P4 | an extra field on the `_backend_state` document | opens |
| P5 | `_tables.number` as a JSON number (as bunvex writes) | **load fails**: "Invalid type: received Float64, expected Int64" |
| P6 | `_tables.state` = `"bogus"` | **load fails**: "invalid table state bogus" |
| P7 | a user document rewritten with `1`/`-2` instead of `1.0`/`-2.0` | reads back as floats, unchanged |
| P8 | the four bootstrap globals removed | **load fails**: "missing _tables.by_id global" |
| P9 | extra globals `layout_version` and `search_segments` | opens |

And the reverse, from the original review: **Convex on bunvex's store** fails at once ("no such column:
prev_ts"); **bunvex on Convex's store** refuses it ("is not a bunvex store: it has no layout version …").

## 2. What an app can observe

Nothing new for a running app: the layout is internal. What the owner's goal makes observable is
operational — **a store moves between the two systems with its data intact**:

- every document of every user table, with the same `_id` and `_creationTime`, readable at once;
- indexes usable without a backfill (database indexes); search indexes after a rebuild (§6.3);
- file storage, environment variables, scheduled functions and crons preserved;
- the function code redeployed by the target system's CLI (§6.4).

One app-visible change rides along: commit timestamps become exact nanoseconds (DV-30's µs resolution
goes away), so sync-protocol `ts` values and `_creationTime`-independent cursors carry Convex's precision.

## 3. How bunvex does it today

(`main` at `64f396f7`; full map in the review notes, the key points here.)

- **Interface** (`packages/core/src/persistence/index.ts:7-69`): `DocWrite {table: number; id: string;
  json}`, `IndexWrite {index: number; key; id: string | null}`, `ts: number` everywhere; `scan` returns
  developer id strings; `readLog` returns per-**commit** `prevTs`; no per-document `prev_ts`.
- **Ids**: the engine keeps only the developer id string (`tx.ts:1497-1504`), generated as Convex's
  (14 random bytes + day). Tablets and index ids are integer counters: `_tables` tablet 1 (indexes 1, 2),
  `_index` tablet 2 (indexes 3, 4), user tablets from 3, indexes from 5 (`catalog.ts:349-398`, DV-53).
  `_tables` and `_index` have no `_tables` / `_index` rows of their own.
- **Catalog documents**: `_tables {name, number: float, state, tablet: int}`; `_index {tablet, name,
  fields, indexId, state, staged?}` (`catalog.ts:107-137`). Search and vector indexes have no `_index`
  rows (their state is the `search_segments` global, DV-368). Every system index gets `_creationTime`
  appended (`catalog.ts:376-377`), so `_data_sync_progress.by_sync_id`, declared
  `["syncId", "_creationTime"]` (`engine.ts:631`), is stored as `["syncId", "_creationTime",
  "_creationTime"]` (a harmless duplicate today; it must go for Convex's shape).
- **Timestamps**: wall-clock **microseconds** in a JS `number` (`determinism.ts:209-215`), ×1000 at the
  sync, function and export boundaries (`sync.ts:1529-1531`, `engine.ts:2238, 2256`, `functions.ts:1403`,
  `streaming-export.ts`, `data-sync.ts`, `exports.ts:389`, `imports.ts:49, 850`). µs constants in
  `committer.ts:84-100`, `retention.ts:213-220`, `search-indexes.ts:13`, `write-throughput.ts`.
- **SQLite** (`packages/core/src/persistence/sqlite.ts:83-126`): `documents(table_id integer, id text, ts,
  json_value text, deleted)` PK `(table_id, id, ts)` WITHOUT ROWID; `indexes(index_id integer, key, ts,
  deleted, document_id text)`; `persistence_globals`; `read_only`; ts indexes; **WAL**, `synchronous =
  full`, `temp_store = memory`, `cache_size = -262144`; an exclusive OS lock on `<file>.lock` plus
  `<file>.lock.holder` (`lock.ts`, DV-99).
- **Postgres / MySQL** (`packages/persistence/src/postgres.ts:262-274`, `mysql.ts:293-308`): the same
  shape with Convex's key split (`key_prefix`, `key_suffix`, but a hash of the suffix), `bunvex_lease`
  (TTL, holder, epoch, `max_ts`: DV-14, DV-124), `read_only`, ts indexes; JSON as text; MySQL ids
  `varchar(64)`, documents `mediumtext`.
- **MongoDB** (`mongodb.ts`): `documents {t, i, ts, j}`, `indexes {x, k: hex, ts, d}`, `meta` (lease,
  layout, read_only), `persistence_globals {_id, v}`.
- **Memory + log**: a JSONL file with a `{"layout":1}` header (`memory.ts:185, 306-309`).
- **Globals**: `layout_version` (1, `layout.ts:12`), the four retention timestamps as plain µs numbers,
  `table_summary_v2` with integer tablet keys, decimal-string sizes and bunvex's own shape JSON
  (`{n, v}`, `Id {table}`), `search_segments`, `search_snapshot`. No bootstrap globals, no
  `max_repeatable_ts`.
- **Open check**: `checkLayoutVersion` / `checkUnversionedTables` refuse any store without bunvex's
  record, **Convex's tables included** (PERSIST-01 C10, conformance K22's `makeForeign` hooks build
  Convex's DDL and expect a `LayoutError`).
- **System tables**: 22 Convex tables (with the virtual names `_storage` and `_scheduled_functions` stored
  as real tables) plus two bunvex-only ones, `_instance` (9999) and `_storage_deletions` (9998); 13 Convex
  tables are missing (§4.3).

## 4. Every difference

### 4.1 Layout (per driver)

| # | Item | Convex | bunvex today |
|---|---|---|---|
| L1 | `documents.id` | 16-byte `InternalId` (BLOB/BYTEA/BINARY(16)) | the developer id string (text / varchar(64)) |
| L2 | `documents.table_id` | 16-byte `TabletId` = the `_tables` doc's internal id | integer counter |
| L3 | `documents.ts`, all ts | i64 **ns** | µs |
| L4 | `documents.prev_ts` | present (per document) | absent |
| L5 | documents PK and indexes | PK `(ts, table_id, id)`, `documents_by_table_and_id (table_id, id, ts)`; Postgres also `documents_by_table_ts_and_id` | PK `(table_id, id, ts)` + `documents_by_ts` |
| L6 | deleted document | SQLite `json_value NULL`; Postgres the bytes `null`; MySQL v1 empty bytes | `json_value NULL` |
| L7 | `json_value` type | SQLite TEXT; Postgres BYTEA; MySQL LONGBLOB, **v1 = LZ4 sort-key bytes** | text everywhere; MySQL mediumtext |
| L8 | `indexes.index_id` | 16-byte `IndexId` (the `_index` doc's internal id) | integer counter |
| L9 | `indexes.table_id`, `document_id` | 16-byte bytes, NULL on a tombstone | no `table_id`; `document_id` text |
| L10 | index key split | SQLite: whole key, PK `(index_id, key, ts)`; PG: `key_sha256` = SHA-256 of the full key, PK `(index_id, key_sha256, ts)` + `(index_id, key_prefix, key_sha256)`; MySQL v5: PK `(index_id, key_prefix, key_sha256, ts)` | SQLite whole key; PG/MySQL `key_suffix_hash` (hash of the suffix), unique `(index_id, key_prefix, key_suffix_hash, ts desc)` |
| L11 | index read join | the document **at the entry's exact ts** | newest version ≤ ts (DV-67) |
| L12 | extra tables | PG/MySQL `leases (id, ts)`, `read_only (id)`; SQLite none | `bunvex_lease` (PG/MySQL), `read_only` everywhere, ts indexes |
| L13 | SQLite settings | no pragmas: rollback journal, default sync | WAL, `synchronous=full`, temp_store, cache_size; a `.lock` + `.lock.holder` next to the file |
| L14 | open check | none (IF NOT EXISTS) | `layout_version` record; refuses Convex's tables (C10/K22) |
| L15 | Postgres/MySQL database | instance name with `-`→`_`, set by the server | taken from the URL as given |

### 4.2 Globals and catalog

| # | Item | Convex | bunvex today |
|---|---|---|---|
| G1 | bootstrap globals | `tables_table_id`, `index_table_id`, `tables_by_id`, `index_by_id` | none (fixed ids 1–4) |
| G2 | `max_repeatable_ts` | plain JSON number, ns | absent |
| G3 | retention globals | `{"$integer": …}` ns | plain JSON numbers, µs |
| G4 | `table_summary_v2` | tablet base64url keys, base64 i64 sizes and ts, Convex shape JSON | integer keys, decimal strings, `{n, v}` shapes |
| G5 | `layout_version`, `search_segments`, `search_snapshot` | none (search state in `_index` rows) | present |
| G6 | bootstrap rows | ts 0, `_tables`/`_index` have `_tables` rows, ten bootstrap tables | first commit at the clock; no self rows |
| G7 | `_tables` doc | `{name, number: int64, state}` (+ `namespace`) | `{name, number: float, state, tablet}` |
| G8 | `_index` doc | `{table_id, descriptor, config: {type, fields, onDiskState, persistenceIndexId}}`; search/vector rows too | `{tablet, name, fields, indexId, state, staged?}`; no search/vector rows |
| G9 | system index fields | as declared | `_creationTime` appended (duplicated on `by_sync_id`) |
| G10 | `_next_persistence_index_id` | one doc, `{nextId: int64}` | absent |

### 4.3 System tables and their documents (probe stores, field by field)

- **Missing in bunvex:** `_db`, `_backend_info`, `_auth`, `_aws_lambda_versions`,
  `_external_deps_packages`, `_index_worker_metadata`, `_component_definitions`, `_components`,
  `_schema_validation_progress`, `_schema_validations`, `_scheduled_job_args`, `_audit_log_config`,
  `_next_persistence_index_id`.
- **Stored under the virtual name:** `_storage` (Convex `_file_storage`), `_scheduled_functions`
  (Convex `_scheduled_jobs`).
- **bunvex only:** `_instance`, `_storage_deletions`.
- **Same fields and types:** `_canonical_urls`, `_cron_job_logs`, `_data_sync_progress`,
  `_deployment_audit_log`, `_environment_variables`, `_exports`, `_function_handles`, `_log_sinks`,
  `_session_requests`, `_snapshot_imports`, `_usage_limits`, and the user table.
- **Different shapes:**

| Table | Field | Convex | bunvex |
|---|---|---|---|
| `_backend_state` | the document | `{system, usage_limit, user}` = `"none"` | no document |
| `_cron_jobs` | `cronSpec` | `hourUTC`/`minuteUTC` int64, `udfArgs` bytes (JSON args) | numbers, `udfArgs` an array |
| `_cron_next_run` | `nextTs` | int64 ns | number |
| `_scheduled_jobs` | fields | `udfPath`, `udfArgs`/`argsId` (args in `_scheduled_job_args`), `component`, `state: {type}`, `nextTs`/`originalScheduledTs`/`completedTs` int64 ns, `attempts` | `name`, `args`, `scheduledTime`/`completedTime` (ms), `nextTs`, `state: {kind}` |
| `_schemas` | `state` | `{state: "active" …}` | a string |
| `_source_packages` | | `sha256` bytes, `packageSize {zipped, unzipped}` int64, `externalPackageId`, `nodeVersion` | `sha256` string, `packageSize` number |
| `_file_storage` | | `sha256` bytes, `size` int64 | `sha256` string, `size` number |
| `_udf_config` | `importPhaseUnixTimestamp`, `serverVersion` | int64; the CLI version | number; `"bunvex"` |
| `_modules` | `analyzeResult` | int64 positions, `cronSpecs` a list of `{identifier, spec}`, `sourceMapped` | numbers, `cronSpecs` a record |
| `_index_backfills` | | `{indexId, numDocsIndexed, totalDocs, cursor: {snapshotTs, cursor}}` | (no row in the probe) `cursor.snapshotTs` µs |

## 5. Design

### 5.1 Ids in the engine: strings, with bytes only in the drivers

- **Documents keep the developer id string** as the engine's identity. It already carries the table
  number and the 16-byte internal id, every API speaks it, and index keys embed it. The persistence
  boundary derives the internal id from it (`decodeId(...).internal`, a base32 decode of 31–37
  characters) and the read side rebuilds it from the stored JSON's `_id`, which every row has.
- **Tablets and indexes become `InternalId`s**, carried in the engine as their **22-character base64url
  string** — Convex's own string form, the one the globals and `_index.table_id` use — branded
  `TabletId` and `IndexId`. Strings key `Map`s by value (a `Uint8Array` does not) and print readably.
  Drivers bind the 16 decoded bytes. Where bytewise order matters (the log's `(ts, table_id, id)` order,
  the memory driver's trees), a `compareInternalId` on decoded bytes is used, since base64url order is
  not byte order.
- The persistence interface becomes `DocWrite {table: TabletId; id: InternalId; json; prevTs}`,
  `IndexWrite {index: IndexId; key; table: TabletId | null; id: InternalId | null}`. `scan` returns
  `(InternalId, ts)` pairs (or documents, §5.4). This is the shape of Convex's `DocumentLogEntry` and
  `PersistenceIndexEntry` (`crates/common/src/persistence/mod.rs:61-94`).
- Cost: one base32 decode per written document and one base64url decode per tablet (cached in the
  catalog). Measured in the implementation PR (per-commit path).

### 5.2 Table and index identity

As Convex: a table's tablet **is** the internal id of its `_tables` row; an index's id **is** the internal
id of its `_index` row; `_index.table_id` names the tablet. Creating a table = inserting a `_tables` row
whose generated id becomes the tablet; the catalog maps tablet ↔ number ↔ name.

Bootstrap (fresh store) writes, **at ts 0**, Convex's ten bootstrap tables with their `_tables` rows
(`_tables` and `_index` included), their `by_id` / `by_creation_time` and declared system indexes as
`Enabled` with `persistenceIndexId` 1…n, the `_next_persistence_index_id` row, and the four bootstrap
globals; then the application system tables in a first ordinary commit, as Convex's
`initialize_application_system_tables` (the `_db` row with `version: 133`, `_backend_state` with
`"none"`, the root `_components` / `_component_definitions` rows written by the first push as Convex's).
Load reads the globals, scans `_index` and `_tables` by `by_id`, and checks Convex's invariants.

`_index` rows take Convex's shape for all three kinds, so the `search_segments` global goes into the
search rows' `onDiskState` (DV-368's "moves there when they exist"); see §6.3 for what bunvex writes there.

### 5.3 Nanoseconds everywhere

A commit ts becomes a **`bigint` of nanoseconds** in the engine, the drivers and every persisted field.
A JS `number` cannot hold it (≈ 1.8 × 10^18 > 2^53), and a µs `number` scaled ×1000 at the boundary is
not enough: a Convex store written on Linux has full-ns timestamps, two commits can share a microsecond,
and both the exact-ts join (§5.4) and `prev_ts` need the stored value back exactly.

- The clock: `max(last + 1n, wall-clock ns)`; the wall clock is `BigInt(ms) * 1_000_000n` plus the
  sub-millisecond part of `performance.now()` (µs-exact; ns digits from `process.hrtime.bigint()` offset).
- The ×1000 boundaries go away (`sync.ts`, `engine.ts`, `functions.ts`, `streaming-export.ts`,
  `data-sync.ts`, `exports.ts`, `imports.ts`); the sync protocol already carries ns as a u64.
- The constants (`WRITE_LOG_MIN_RETENTION_US`, retention delays, `SEARCH_LOG_RETENTION_US`, the
  write-throughput window) become ns `bigint`s.
- Drivers: `bun:sqlite` with `safeIntegers` for ts columns; Postgres `int8` parsed as `bigint`; MySQL
  `supportBigNumbers` + `bigNumberStrings`; MongoDB `Long`. `max_repeatable_ts` is a bare JSON number
  above 2^53, so it is read from the raw text, not `JSON.parse`. JSON values inside documents use
  `$integer` (Int64), as Convex.
- Document fields that hold ms (`_creationTime`, `scheduledTime` in the virtual view) stay ms floats;
  fields Convex stores as ns `int64` (`_scheduled_jobs.nextTs`, `_cron_next_run.nextTs`,
  `_index_backfills.cursor.snapshotTs`) become ns `int64`.
- **Measured** (bun 1.x, M-series, scratch bench): `max(last+1, clock)` 1.6 ns (number) vs 9.9 ns
  (bigint) per op; a ts compare 1.2 vs 3.4 ns; a binary search over 1 024 ts 47 vs 76 ns; `Map.get` by ts
  5.4 vs 7.8 ns. A commit does a handful of these, against microseconds of other work: negligible. The
  implementation PR re-measures the commit path end to end.

### 5.4 `prev_ts` and the exact-ts join

- The committer knows the version each write replaces (it validated the transaction against it), so it
  sets `prevTs` on each `DocWrite`, as Convex's committer (`committer.rs:995`). Imports and backfills set
  it the same way. Retention never rewrites it (Convex deletes whole old versions; a surviving version may
  point at a pruned one, which Convex tolerates).
- With `prev_ts`, the index read joins the document **at the entry's ts** (DV-67 reversed). `scan` +
  `getVersions` collapse into one query per page on SQL drivers (`scanDocs` already exists).
- DV-66 is built. DV-154/DV-155 (retention without `prev_ts`) and DV-127 (backfill chunks as commits)
  were decided "until `prev_ts` exists"; they are re-opened as questions Q9 (§8), not changed silently.

### 5.5 Every subsystem

| Subsystem | Change |
|---|---|
| Committer / write log (`committer.ts`, `write-log-index.ts`, `tx.ts`) | ts `bigint`; `prevTs` per write from the replaced version; write-log columns as `BigInt64Array` |
| OCC read sets (`read-set-index.ts`, `committer.ts` `Interval`) | index keyed by `IndexId` string instead of a number; no other change (keys are already Convex's bytes) |
| Retention (`retention.ts`) | ns delays; `$integer` globals; reads by `(ts, table_id, id)`; DV-154/155 per Q9 |
| Table summaries (`table-summaries.ts`, `table-summary-checkpoint.ts`, `shapes.ts`) | Convex's `table_summary_v2` JSON exactly: tablet keys, base64 i64 sizes and ts, Convex's shape JSON (`numValues`, `variant`, `Id {tableNumber}`, `Object {fields: [{fieldName, type}]}`) |
| Search segments (`search-segments.ts`, `search-snapshot.ts`) | state in the search `_index` rows (DV-368 resolved); see §6.3 and Q5 |
| Index backfill (`index-worker.ts`, `catalog.ts`) | `onDiskState` with Convex's `Backfilling {backfillState}` → `Backfilled2` → `Enabled`; `_index_backfills` in Convex's shape |
| Streaming export / data sync | the ns ↔ µs conversions removed; cursors are ns already; deltas can use `prev_ts` as Convex's `document_deltas` |
| Snapshot export / import | `_tables` / tablet ids in the import state (`hidden_tables[].tablet`) become tablet strings; imported rows get `prev_ts` NULL as Convex's import |
| Scheduler, storage, cron (`scheduler.ts`, `storage.ts`, `scheduled-jobs.ts`) | real tables `_scheduled_jobs` / `_file_storage` with the virtual names on top; Convex's field shapes (§4.3) |
| Cursors (`cursor.ts`) | the fingerprint embeds `tablet:index` strings instead of integers (opaque to apps) |
| Drivers | §5.6 |
| PERSIST-01 | C1 (shape, ns), C3/C11–C14 (types), C10 (no layout record; Convex's store **accepted**), C15 (one id in two tables = two tablets), C16; K22 inverted: a Convex store must open; new K-cases: cross-open fixtures (§7, PR 9) |
| Conformance suite (2 813 LOC) | ids become 16-byte internal ids, tables/indexes tablet strings, ts `bigint`; the `makeForeign` hooks become "a Convex store opens" |
| Jepsen (`packages/jepsen`, 1 520 LOC) | wraps `Persistence`; only types change |
| Differential | no layout assumptions; gains a cross-open scenario (PR 9) |

### 5.6 Drivers

- **SQLite:** Convex's DDL exactly (§1.5). No `WITHOUT ROWID`, no extra indexes beyond Convex's (the log
  by ts is the PK order now). Pragmas: Q1. The lock file and `read_only`: §6.5 and Q2.
- **Memory + log:** not a Convex driver; keeps its JSONL file, with the new types (bytes as base64url) and
  `prev_ts`. It never cross-opens.
- **Postgres:** Convex's DDL exactly (§1.6), JSON as BYTEA, deleted = `null` bytes, Convex's
  `key_sha256` (of the full key) replacing `key_suffix_hash`, Convex's `leases` and `read_only` tables.
  Lease semantics: Q3. Database naming: Q7.
- **MySQL:** Convex's v5 DDL exactly (§1.7), `BINARY(16)` ids, LONGBLOB JSON, `key_sha256`. Reading must
  accept v0 and v1 encodings; writing v1 needs LZ4 with Convex's dictionary over the sort-key encoding:
  Q4. v6 (multitenant) is out of scope.
- **MongoDB** (Convex has none): the closest analogue of Convex's Postgres layout, proposed in Q6:
  `documents {_id: {ts, table_id, id}, json_value: string|null, deleted, prev_ts}` with `ts` as `Long`,
  ids as BinData subtype 0 of 16 bytes (fixed length, so length-first BinData order equals byte order),
  index `{table_id, id, ts}`; `indexes {_id: {index_id, key_prefix, key_sha256, ts}, key_suffix,
  deleted, table_id, document_id}` with the key prefix **hex-encoded** (variable length; hex keeps byte
  order) and index `{index_id, key_prefix, key_sha256}`; `persistence_globals {_id: key, json_value}`;
  `leases`, `read_only` collections. It cannot cross-open with Convex (no driver), only with itself and
  through export/import.

## 6. A real cross-open, beyond the raw layout

### 6.1 What both sides need in the store

1. Convex's DDL (§1.5–1.7) and the four bootstrap globals; rows at ts 0 for the bootstrap.
2. `_tables` / `_index` rows in Convex's exact shape and types (P5/P6 show a wrong type fails the load),
   with `by_id` for every table (P2).
3. The `_db` row with `version: 133` and `_backend_state` with its document. Convex creates the other
   missing system tables itself at start (§1.10), but bunvex should create them too, so that a bunvex
   store looks like a Convex one and Convex does not have to.
4. The real names `_file_storage` / `_scheduled_jobs` with the virtual names on top. Otherwise Convex
   creates empty real tables and bunvex's data sits in tables Convex treats as unknown system tables
   (P2b): invisible to `ctx.storage` and the scheduler.
5. System-table documents in Convex's shapes (§4.3), since Convex parses them when it reads them. The
   scheduled job's args move to `_scheduled_job_args` as Convex's.
6. System indexes with exactly the declared fields (G9); otherwise Convex drops and re-backfills them
   (`model/src/lib.rs:507-584`).
7. `table_summary_v2` in Convex's format, or absent (absent is recomputed; unparseable is stuck, §1.11).
8. A `_db.version` policy in bunvex: accept 133; refuse lower ones ("open it with Convex first, which
   migrates it"), since bunvex will not port Convex's migrations; warn and continue on higher ones, as
   Convex. The `layout_version` global goes away (Q8).

### 6.2 Components

Convex's store always has a root `_components` / `_component_definitions` row. bunvex has no components
(DV-55): it writes the root rows as Convex's first push does and **refuses at open a store with non-root
components** (tables with a `namespace`), naming them, until DV-55 is built (Q10).

### 6.3 Search and vector indexes: cannot share segments

Convex's segments are Tantivy and Qdrant archives; bunvex's are its own format (STUDY-111). Neither can
read the other's, and that will not change. So the `_index` row of a search index must never point one
system at the other's files. Proposal (Q5):

- bunvex writes Convex's `_index` shape for search / vector rows, with `onDiskState` in a state Convex
  rebuilds from (`{"state": "backfilling"}` — Convex then backfills it itself), and keeps its own segment
  list in a bunvex-only global keyed by `IndexId` (a global Convex ignores, P9);
- on open, bunvex ignores a Convex snapshot it cannot read and rebuilds the index (STUDY-79/111
  backfill); a query meanwhile fails with `IndexBackfillingError` as for any backfilling index.

Either way, a moved store's search indexes are unavailable until rebuilt. Database indexes need nothing.

### 6.4 Code: redeploy, not cross-run

`_modules` / `_source_packages` hold bundles built by each system's CLI against its own runtime
(`bunvex/server` vs `convex/server`, different syscall layers). bunvex will not run Convex's bundles nor
the reverse. After a cross-open the target system's `deploy` pushes the code again; until then function
calls fail as on a deployment without code. The documents themselves must still parse on both sides
(§4.3 `_modules.analyzeResult`), so that the open, the dashboard and the push work. **Cannot be done:**
running the other system's deployed bundles.

### 6.5 The SQLite file: WAL, lock file, `read_only`

From probe P1: **Convex opens a WAL-mode file with an extra `read_only` table and a `.lock` next to it, and
reads and writes it.** So none of them breaks Convex's open. But:

- **WAL** is a property of the file (its header), persistent until changed. The file stays WAL under
  Convex. Identical bytes need the rollback journal (Q1).
- **The lock file** is advisory and separate: Convex ignores it. A Convex process and a bunvex process on
  the same file at once will both write (Convex has no lock at all, DV-99). Nothing in the store can
  prevent that; the lock only protects bunvex from bunvex.
- **`read_only`** (DV-125): an extra table Convex ignores; Convex would write to a store bunvex marked
  read-only. Keep or drop: Q2.

### 6.6 What cannot be done

- Sharing search/vector segment files (§6.3).
- Running the other system's deployed bundles (§6.4).
- Opening Convex stores with components until DV-55 (§6.2), or MySQL v6 (multitenant) stores.
- Opening a Convex store whose `_db.version` is below bunvex's (no ported migrations); Convex migrates it
  first.
- Mutual exclusion between a Convex and a bunvex process on one SQLite file.
- The MongoDB driver has no Convex counterpart; its stores move only by export/import.

## 7. The PR series (main green at each step)

Sizes are changed lines (code + tests), estimated from the files in §5.5.

| PR | Content | Size |
|---|---|---|
| 1 | **ns `bigint` timestamps** (DV-30's µs reversed): clock, committer, write log, retention, search, sync and export boundaries, all drivers' bindings, globals; layout otherwise unchanged; `LAYOUT_VERSION` 2 so a µs store is refused | ~1 800 |
| 2 | **Identity model**: tablet and index ids become `InternalId` strings (tablet = `_tables` row id); `_tables`/`_index` rows for themselves; bootstrap at ts 0 with Convex's ten bootstrap tables; the four bootstrap globals; `_tables`/`_index` in Convex's shape (database indexes, `persistenceIndexId`, `_next_persistence_index_id`); system index fields as declared. Drivers store the strings in their current columns | ~2 200 |
| 3 | **Persistence interface as Convex's**: internal-id bytes for `id`/`document_id`, `table_id` on index entries, `prev_ts` from the committer, exact-ts join (DV-67 reversed), DV-66 built; every driver adapted with its current DDL plus the new columns; conformance rewritten for the new types | ~2 500 |
| 4 | **SQLite + memory**: Convex's SQLite DDL exactly, WAL kept (DV-411), lock/`read_only` kept (DV-412); globals in Convex's encodings (`$integer`, `max_repeatable_ts`); `layout_version` replaced by `_db.version` (DV-418); K22 inverted (a Convex store opens) | ~900 |
| 5 | **Postgres**: Convex's DDL, BYTEA JSON, `key_sha256`, Convex's `leases` with newest-wins (DV-413, DV-14 reversed), the database from the instance name when the URL has none (DV-417) | ~1 000 |
| 6 | **MySQL**: Convex's v5 DDL, LONGBLOB, `BINARY(16)`, `leases` (DV-413), DV-417; documents read as v0 and v1 and **written as v1** (LZ4 with Convex's dictionary over the sort-key bytes, DV-414), measured; numbers to the owner before it is final if LZ4 in JS/WASM is much slower | ~1 400 |
| 7 | **MongoDB** layout per Q6 | ~600 |
| 8 | **System tables and documents**: `_file_storage`/`_scheduled_jobs` with virtual views, `_scheduled_job_args`, the 13 missing tables, `_db` (version 133) and `_backend_state` rows, every shape of §4.3, `table_summary_v2` in Convex's format, root components; `_db.version` policy; Q10's refusal. May split by table group | ~2 500 |
| 9 | **Search state in `_index`** (DV-368, DV-415), and the **cross-open tests**: stores written by the Convex binary opened by bunvex and the reverse, **local only**: skipped (with a message naming the env var to set) when the binary is not present; never downloaded in CI (Q11) | ~1 200 |
| 10 | **Retention by `prev_ts`** as Convex's (DV-419 reverses DV-154, DV-155) | ~600 |
| 11 | **Backfill entries at each document's own ts** as Convex's (DV-419 reverses DV-127) | ~500 |

PR 1 is independent and can start at once. 2 → 3 → (4, 5, 6, 7 in any order) → 8 → 9; 10 and 11 follow 3. Total ≈ 13 500
lines. Each PR runs the full suite and PERSIST-01 on every driver; until PR 9, a fixture test per PR pins
the part it makes identical (e.g. PR 4 diffs bunvex's SQLite schema against Convex's).

## 8. Divergences and open questions

Reversed by the owner's decision (2026-10-05), to be built in the PRs above: **DV-53** (tablets and index
ids as Convex's), **DV-67** (exact-ts join), **DV-68** (bytes ids, Convex's column types), **DV-30**'s
internal µs (ns everywhere), **DV-66** (`prev_ts`), **DV-107**'s bunvex layout record (Convex's store is now
accepted), **DV-368** (search state in `_index`). Questions found by this study,
DV-411 – DV-420, decided in §8a:

| # | Question | Convex | bunvex | Same? | Why | App impact | Recommendation |
|---|---|---|---|---|---|---|---|
| Q1 (DV-411) | SQLite pragmas | none: rollback journal | WAL, `synchronous=full`, cache, temp_store | no | WAL was chosen for write throughput | none; operational (concurrent readers, file header) | match Convex's journal (no pragmas) unless PR 4's measurement shows a large loss, then ask again with numbers; Convex opens WAL files either way (P1) |
| Q2 (DV-412) | lock file and `read_only` on SQLite (DV-99, DV-125) | neither | both | no | protect bunvex from a second bunvex; import/export maintenance | none | keep both: they are outside the store's tables (lock) or an extra table Convex ignores (P1); document that Convex honours neither |
| Q3 (DV-413) | Postgres/MySQL lease | `leases (id, ts)`: newest process wins, old one fails its next write | `bunvex_lease` with TTL, holder, epoch, `max_ts`; a live lease is never taken (DV-14, DV-124) | no | refusing a second process; acknowledging retried flushes | none; operational | use Convex's `leases` row as the fence (so a Convex process and a bunvex process exclude each other), and keep bunvex's TTL/holder/`max_ts` in a separate bunvex table on top |
| Q4 (DV-414) | MySQL document encoding | writes v1 (LZ4 + dictionary over sort-key bytes), reads v0 and v1 | JSON text | no | Ainda não fizemos | none | read both; write v0 (JSON), which Convex reads (its decoder dispatches on the first byte); v1 later if wanted |
| Q5 (DV-415) | search/vector indexes across a cross-open | Tantivy/Qdrant segments in `_index.onDiskState` | own segments | no | Não dá pra fazer: formats are unrelated | a moved store's search queries fail with `IndexBackfillingError` until rebuilt | §6.3: Convex's `_index` shape with `onDiskState` "backfilling", bunvex's segment list in its own global keyed by `IndexId`; rebuild on open |
| Q6 (DV-416) | MongoDB layout | no MongoDB driver | own layout | n/a | addition | none | §5.6's analogue of Convex's Postgres layout |
| Q7 (DV-417) | Postgres/MySQL database name | instance name with `-`→`_`, appended to the cluster URL | the URL as given | no | bunvex takes a full URL | operational: the same server URL points at different databases | match Convex when the URL has no database path; keep a URL with a path as given (Convex refuses it) |
| Q8 (DV-418) | version record | `_db.version` (133), migrations, warn on newer | `layout_version` global, refuse newer/foreign | no | bunvex had no `_db` | operational | drop `layout_version`; use `_db.version`: accept 133, refuse lower, warn on higher as Convex |
| Q9 (DV-419) | retention and backfill now that `prev_ts` exists (DV-154, DV-155, DV-127 were "until `prev_ts`") | walk revision pairs by `prev_ts`; backfill entries at each document's ts | log-based; backfill chunks as commits | no | decided before `prev_ts` | none | keep DV-154/155 (same rows deleted); revisit DV-127 after PR 3 |
| Q10 (DV-420) | stores with components; bunvex-only tables `_instance`, `_storage_deletions` | components; neither table | no components (DV-55); both tables | no | Ainda não fizemos (components); bunvex features | operational | refuse a store with non-root components, naming them; keep `_instance`/`_storage_deletions` as system tables with Convex-style `by_id`/`by_creation_time` (Convex loads them, P2b) |
| Q11 | CI cross-open job | — | — | — | needs the Convex local backend binary (downloaded by the `convex` npm package) | none | allow a CI job that downloads the pinned binary; fixtures checked in otherwise |

### 8a. The owner's decisions (2026-10-05)

| Q | DV | Decision |
|---|---|---|
| Q1 | DV-411 | **Keep WAL** (a decided divergence): Convex opens a WAL file and reads and writes it (P1). |
| Q2 | DV-412 | **Keep the `.lock` file and the `read_only` table** on SQLite (decided); Convex ignores both. |
| Q3 | DV-413 | **Match Convex** on Postgres and MySQL: Convex's `leases (id, ts)`, newest process wins, between two bunvex processes too. **Reverses DV-14** on those drivers. MongoDB follows by analogy (DV-416). |
| Q4 | DV-414 | **Read v0 and v1, write v1** as Convex, measured; if LZ4 in JS/WASM makes reads or writes much slower, the numbers go to the owner before the PR is final. **Format-data exception:** Convex's LZ4 dictionary bytes may be reused as format data (they are needed to read Convex's v1); no Convex logic is copied. If a rule-5 check flags them, an allowlist entry cites this decision. |
| Q5 | DV-415 | As proposed: Convex-shaped `_index` rows in "backfilling", bunvex's segments in their own global, a rebuild on open. |
| Q6 | DV-416 | As proposed: the analogue of Convex's Postgres layout. |
| Q7 | DV-417 | **Match Convex** when the URL has no database: the instance name with `-` → `_`. |
| Q8 | DV-418 | `_db.version`: accept 133, refuse lower, warn on higher; `layout_version` dropped. |
| Q9 | DV-419 | **Match Convex fully** once `prev_ts` exists: retention walks the log with `prev_ts` (reverses DV-154, DV-155) and backfill writes entries at each document's own ts (reverses DV-127). PRs 10 and 11. |
| Q10 | DV-420 | As proposed: a store with non-root components is refused, naming them; bunvex-only system tables get `by_id` / `by_creation_time` `_index` rows. |
| Q11 | — | **No download of the Convex binary in CI.** Cross-open tests run locally only and are skipped, with a message naming the env var or path to set, when the binary is absent. |

**The SQLite lock and the SQL lease (Q2 + Q3).** They answer different questions. On Postgres and MySQL the
fence is in the database, so it is Convex's own `leases` row: a Convex process and a bunvex process (or two
bunvex processes) fence each other, and the newest one wins. On SQLite neither system has an in-database
lease; bunvex's OS lock on `<file>.lock` stops a second bunvex process from opening the file at all (the
oldest wins), and fences nothing against a Convex process, which never looks at it (§6.5). So between bunvex
processes the rule differs by driver (newest wins on SQL servers, oldest wins on SQLite), each as decided.

## 9. Tests (for the implementation PRs)

- **Fixtures from Convex**: stores written by the Convex binary (SQLite file; Postgres and MySQL dumps)
  with the probe app; bunvex opens each and reads every document, index range, file, env var, cron and
  scheduled function, then writes and reopens.
- **The reverse**: a bunvex store opened by the Convex binary (CI job, Q11), the same reads.
- **Schema diff**: `sqlite_master` / `information_schema` of a fresh bunvex store equals Convex's.
- **Byte-level**: ids, tablet ids, index ids, keys, `$integer` globals and `table_summary_v2` match a
  Convex fixture for the same logical content.
- **ns**: two commits inside one microsecond keep distinct, ordered timestamps; a Linux-written Convex
  store with full-ns timestamps round-trips exactly through the exact-ts join and `prev_ts`.
- **`prev_ts`**: every version points at its predecessor (conformance), including after retention.
- **Load failures as Convex's**: a `_tables` number as a float, a missing `by_id`, missing bootstrap
  globals all refuse the open with Convex's messages.
- Sabotage per PR: e.g. write ts in µs, drop `prev_ts`, join by newest-≤-ts, write `number` as a float.

## 10. Probe artifacts

The probe scripts (`inject.py`, `cx.sh`, `shapes.py`, the ts bench) are in the session scratchpad
(`agent-layout/`), not in the repo; §1.12 and §4.3 record their results.

## 11. As built

### PR 1 — nanosecond timestamps

- Commit timestamps are `bigint` nanoseconds everywhere: `wallClockNs` (`determinism.ts`), the committer and its
  write log, `Persistence` (every `ts` parameter and field), retention, table summaries, search state rows
  (`ts`, `last_segment_ts`, `fast_forward_ts` as int64), the query cache, the sync protocol (the engine's ts is
  the wire ts: `wireTs` is gone), streaming export and data sync cursors, imports, exports, function handles
  and `getSnapshotTs`. Convex's knobs are ns constants (`WRITE_LOG_*_RETENTION_NS`, `MAX_TRANSACTION_WINDOW_NS`,
  `SEARCH_LOG_RETENTION_NS`); retention delays stay in ms options, converted once.
- Drivers: `bun:sqlite` statements that read a ts use `safeIntegers`; Postgres parses `int8` text with
  `BigInt` and binds strings; MySQL connects with `supportBigNumbers` / `bigNumberStrings` and binds `bigint`;
  MongoDB decodes int64 as `bigint` (`useBigInt64`) and stores `ts` as int64; the memory log writes `ts` as a
  decimal string. `LAYOUT_VERSION` is 2, so a µs store is refused.
- The memory driver stamps each version with its commit's sequence number and maps a snapshot ts to a sequence
  once per read: comparing `bigint`s per version cost 22 % on index range reads over many versions.
- Tests: conformance K33 (two commits 1 ns apart above 2^53, exact through a reopen, every driver). Sabotage:
  SQLite without safe integers, MySQL without big numbers, Postgres through a JS number, the memory log through a
  JS number (each turns K33 red); a µs wall clock turns the sync test "timestamps travel as Convex's" red.
- Measured (engine, in-process, M-series, median of 3 × 4 s; ops/s main → PR 1): memory insert 40 384 → 39 903,
  patch 31 825 → 31 720, get 280 213 → 298 602, index range 7 376 → 7 224 (a back-to-back rerun after the
  sequence change; 6 045 → 4 719 before it); SQLite insert 7 176 → 7 336, patch 5 064 → 5 120, get 92 168 → 96 434, index range 775 → 793.

### PR 2 — identity

- A table's tablet is the internal id of its `_tables` row and an index's id the internal id of its `_index`
  row, carried as 22-character base64url strings (`internal-id.ts`); `_next_tablet_id` is gone (DV-408).
  `_tables` rows are `{name, number, state}`, `_index` rows `{table_id, descriptor, config}` for database,
  search and vector indexes alike (DV-428); `table_summary_v2` is keyed by tablet ids.
- A new store is bootstrapped at ts 0 (`bootstrap.ts`, Convex's `Database::initialize`): the ten bootstrap
  tables in Convex's order and numbers, their `_tables` rows, `by_id` / `by_creation_time` (none for `_index`)
  then the declared system indexes, `persistenceIndexId` 1–26, `_next_persistence_index_id` at 27, then the
  four globals. A start reads the globals and loads `_index` and `_tables` through their `by_id` indexes, with
  Convex's checks and messages ("missing _tables.by_id global", "Missing `by_id` index for …", "Table … is
  missing but has one or more indexes"). `getGlobal` / `setGlobal` are required of every driver (C14).
- `planCatalog` no longer allocates tablets; `writeCatalogChanges` inserts the `_tables` rows first and names
  each new index's table by the tablet its row got. A table without `by_creation_time` (`_index`) is read
  through `by_id`.
- Drivers keep their columns, typed text (`varchar(32)` on MySQL) for the ids; PR 3 makes them Convex's bytes.
- Tests: `bootstrap.test.ts` (the 37 rows at ts 0 field by field, the globals, a reopen, the two load
  failures), the rewritten tablet and index id tests, the row-shape tests now comparing whole rows. Sabotage:
  a `_tables` row whose id is not the tablet (13 red), a `by_creation_time` index on `_index` (red: the
  bootstrap rows), no `by_id` check at load (red: the load failure), a `tablet` field on `_tables` rows (red:
  the bootstrap rows).
- Measured (engine, median of 3 × 4 s, ops/s, main → PR 1 → PR 2): memory insert 47 788 → 49 344 → 48 228,
  patch 35 416 → 36 336 → 35 888, get 318 202 → 320 672 → 307 194, index range 6 696 → 6 880 → 6 544; SQLite
  insert 7 648 → 7 737 → 7 232, patch 5 632 → 5 528 → 5 240, get 108 237 → 106 472 → 104 949, index range
  792 → 808 → 834. SQLite writes lose ~6 % to text keys in place of integers; PR 3 replaces them with 16 bytes.

### PR 3 — the persistence interface as Convex's (with PR 11's backfill)

- `DocWrite {table, id, json, prevTs}` and `IndexWrite {index, key, table, id}`, as Convex's `DocumentLogEntry`
  and `PersistenceIndexEntry`: `id` is the document's internal id (`internalIdOf`, a direct base32 → base64url
  decode: 140 ns, against 820 ns through `decodeId`); `prevTs` is the ts of the version the transaction read,
  set when the transaction is turned into writes; the write log keeps the documents' own ids for conflict
  reports (`LoggedIndexWrite.docId`).
- `scan(table, index, …)` returns each live entry's document at the entry's own ts (the exact-ts join, DV-67
  reversed), with its ts; `scanDocs` is gone. `get` returns the version and its ts. The document log returns
  `prevTs` (DV-66 built).
- **The exact-ts join needs the backfill at each document's own ts** (an entry written by a chunk commit at a
  new ts has no document version at that ts), so PR 11 (DV-127 reversed) is built here: `writeIndexEntries`
  (PERSIST-01 C17) writes entries at past timestamps, outside any commit; the worker reads at the checkpoint's
  snapshot and resumes there (it starts over at a new snapshot once retention has passed it). A mutation that
  began before an index change and commits after it would leave the new index without its entries (Convex's
  committer computes index writes with the latest registry; bunvex's transactions use the catalog they began
  with): the commit that changes a table's `_index` rows logs a key on that table's `_tables` row, which every
  mutation that used the table read, so such a mutation conflicts and runs again with the new catalog, which
  is installed when that commit becomes visible.
- Drivers keep their DDL with the new columns (`documents.prev_ts`, `indexes.table_id`) and text ids; PRs 4–7
  give them Convex's. `LAYOUT_VERSION` is 4.
- Tests: conformance K34 (`prev_ts`), K35 (the exact-ts join), K36 (`writeIndexEntries`), K30/K31 rewritten;
  `persistence-interface.test.ts` (the `prev_ts` chain, the join, the backfill at each document's ts, the
  conflict of a mutation older than an index). Sabotage: `prevTs: null` (red), the SQLite join by `ts >=` (red),
  backfill entries at the snapshot (red), no catalog touches (red), memory log without `prevTs` (K34 red),
  `insert or ignore` for entries (K36 red), Postgres entries without the fence (K36 red).

### PR 10 — retention by `prev_ts`

- The index pass is Convex's `expired_index_entries`: it walks the document log (PERSIST-01 C12) up to the
  window. For each version with a `prev_ts` it reads both versions, re-derives the replaced version's key on
  every index of the table (enabled or being built), and deletes that key at or below `prev_ts`. Where the key
  changed or the document was deleted, it also deletes the tombstone the new version wrote, at or below its
  ts. A predecessor already pruned is skipped, as Convex's. DV-154 reversed.
- The document pass is Convex's `expired_documents`: each version's predecessor at `prev_ts`, and a delete's
  own tombstone. DV-155 reversed. DV-419 is resolved in full.
- `readLog` (PERSIST-01 C11, the `indexes` log by ts) had no other reader and is removed from the interface
  and from every driver, with conformance K25 (PERSIST-01 v3.1). Convex has no such read. DV-120 (followers
  read `indexes` by ts) is resolved with it: the log is `documents` by ts.
- An index tombstone with no `prev_ts` is never pruned. Only a document created and deleted in one
  transaction would write one, and the engine writes no index entry for that.
- Measured: 4000 documents with two indexes, 5 patches each (20 000 revision pairs), passes run to the end by
  hand, median of 3, ms, load average ~15. Memory: index pass 80 → 148, document pass 9 → 6. SQLite: index
  pass 827 → 1008, document pass 335 → 246. The index pass now reads two versions per pair, as Convex's.
  This is background work, rate-limited in production.
- Tests: `retention-prev-ts.test.ts` (a moved key, a backfilled index, the document pass, a pruned
  predecessor) and conformance K27–K29 deriving the prunes from the store's revision pairs. Sabotage: no
  tombstone prune (red), prune at `prevTs - 1` (red), always prune at the new ts (red), the document pass
  without a delete's tombstone (red), without the pruned-predecessor skip (red).

### PR 4 — SQLite in Convex's layout

- The SQLite driver creates Convex's three tables with Convex's own statements (`SQLITE_LAYOUT`, run with `IF NOT
  EXISTS` on every open), so a fresh store's `sqlite_master` equals that of a store the Convex binary created
  (`packages/core/test/fixtures/sqlite-reference-schema.json`), `read_only` aside (DV-412). Ids, tablets and
  index ids are bound as their 16 bytes. WAL stays (DV-411). The ts indexes, `WITHOUT ROWID` and the
  `layout_version` record are gone: an open checks that the tables it finds have Convex's columns
  (`checkStoreTables`), so a Convex store opens and an older bunvex layout is refused untouched (K22 in its
  reference form). `maxTs` reads `documents` only, as Convex's `max_ts` (PERSIST-01 C5, K16 reworded).
- Index scans use Convex's form: the newest ts per key from the primary key's index alone (covering), then that
  row and its document at the entry's ts in one statement. With Convex's rowid tables a plain
  `order by key, ts desc` scan pays a row lookup per old version; on a fixed store with 20 000 patches a range
  of 20 took 790 µs that way, 600 µs this way (PR 10, `WITHOUT ROWID`: 550 µs; on a clean store 146 µs against
  177 µs).
- `max_repeatable_ts`: every start writes `max(maxTs, the global, the clock)` and resumes there, as Convex's
  `new_idle_repeatable_ts`; the committer bumps it as Convex's (5 s after a commit, every 1–2 h idle, taking the
  next commit ts when nothing is pending). Globals' integers above 2^53 travel as `bigint` (`encodeGlobal` /
  `decodeGlobal`, every driver; conformance K29).
- `DATABASE_VERSION` is 133 with DV-418's policy, checked before anything is written (`_db` is read right after
  the bootstrap catalog).
- Checked locally with the Convex binary: a store it created opens in bunvex, takes a mutation and reads it
  back; Convex then starts on that store, and on a fresh bunvex store, and serves. Not yet a test (PR 9), and
  the system tables' shapes are PR 8's.
- Conformance ids are now valid internal ids (`did(name)`), since SQLite binds bytes.

### PR 5 — Postgres in Convex's layout

- The driver runs Convex's `init_sql` (single-tenant) statement for statement, so a fresh database's columns and
  indexes equal those of one the Convex binary created (`packages/persistence/test/fixtures/postgres-reference-schema.json`).
  Ids, tablets and index ids are BYTEA; `json_value` is the JSON's bytes and a deleted version stores `null`;
  `key_sha256` is the SHA-256 of the whole key. No layout record: the open checks the five tables' columns.
- The lease is Convex's `leases (id, ts)` (DV-413, reversing DV-14 here): a start takes it at once when its
  wall-clock ns are newer; the previous holder fails its next write. The flush's last statement checks the row
  `FOR SHARE`; a retried flush finds its group landed by its rows at its top ts while the lease is still ours
  (DV-124's rule on this driver). An acquisition held up by a writer paused inside its flush ends the sessions
  that block it. The lease row is inserted on every open when missing, as Convex.
- A URL without a database connects to the instance name's, `-` → `_` (DV-417; DV-110 resolved).
- Checked locally with the Convex binary: a Convex-created database opens in bunvex, takes writes and reads back;
  Convex then starts on it (taking the lease from bunvex's later start) and serves.
- Measured (engine, in process, local Postgres 17, median of 3 × 4 s, ops/s, PR 4 → PR 5): get 7 958 → 7 781,
  range of 20 2 220 → 1 822, insert 9 560 → 7 800, patch 4 197 → 2 936. Convex's `indexes` index has no ts
  column, so the planner priced a range's newest versions as a full sort and chose a sequential scan (32 ms
  against 1.7 ms for a range over 160k rows); the pool now sets `enable_seqscan` and `enable_bitmapscan` off, as
  Convex's planner hints do (range 1 168 → 1 822). Neither the `FOR SHARE` fence nor the third `documents` index
  explains the write cost (each removed in turn: no change); the primary key led by `key_sha256` scatters index
  inserts across the btree, which is Convex's layout.
- **Investigated further (owner, 2026-10-06).** pg_stat_statements, a bun CPU profile and the Convex binary on
  the same Postgres:
  - The patch regression was postgres.js's per-connection catalog query (`fetch_types`), which took ~0.75–1.1 s
    under `enable_seqscan = off` (12 calls, 9–13 s in a 4 s phase): `fetch_types` is off, and the two array
    parameters travel as jsonb.
  - About a quarter of the driver's CPU was `Buffer` hex conversions and node's `createHash`: ids and keys are
    hexed from tables, tablets and indexes cached, SHA-256 is `Bun.SHA256`.
  - A group that fits one statement per table is written by one statement (both inserts and the fence) inside its
    transaction: three round trips instead of four. Without the transaction (one round trip) an attempt that
    timed out could still land once the store answers again (K20, K21 red), so it stays a transaction.
  - "The `key_sha256`-led primary key scatters inserts" is refuted: a key-ordered primary key, otherwise the same,
    gained nothing. The database cost is row width (the 32-byte hash in the heap and both btrees): per insert
    commit, 27 µs and 2.0 KB of WAL on PR 4's layout, 33.5 µs and 2.76 KB on Convex's. The Convex binary on the
    same Postgres writes 2.70 KB of WAL per commit: it pays the same.
  - Convex's planner hints are comments on a stock Postgres (no pg_hint_plan); its index query avoids the
    sequential scan by putting its LIMIT inside the DISTINCT ON.

### PR 6 — MySQL in Convex's v5 layout

- The driver runs Convex's v5 `init_sql` and `init_lease` statement for statement: `BINARY(16)` ids, LONGBLOB
  documents, `key_prefix` VARBINARY(2500) with `key_sha256` BINARY(32) of the whole key, Convex's `leases`,
  `read_only` and `persistence_globals`. A fresh database's columns, indexes and `SHOW CREATE TABLE` equal those
  of one the Convex binary created (`packages/persistence/test/fixtures/mysql-reference-schema.json`). No layout
  record: the open checks the five tables' columns.
- Documents are read as v0 (the JSON text, `null` when deleted) or v1 (the byte `0x01`, the sort key's length, then
  the document's sort key as one LZ4 block with Convex's dictionary, format data; a deleted version is empty), and
  written as Convex's `MYSQL_DOCUMENT_ENCODING` knob says: **0 by default** in bunvex, 1 in Convex (owner,
  2026-10-07, DV-414, a decided divergence). With the first decoder v1 halved point gets of 3 KB documents (17 989
  → 8 743 ops/s); decoding the sort key straight to JSON text (72 → 22 µs a document) left it 13 % behind main and
  27 % behind v0 (11 998 / 10 483 / 14 271). v1 saves only storage; Convex reads v0, so cross-open still works. The LZ4 block codec is bunvex's own, from the format's specification
  (`packages/persistence/src/lz4.ts`); it decodes all 137 v1 documents of a store the Convex binary wrote, and its
  blocks are 0.99× the size of Convex's. LZ4 costs ~10 µs to compress and ~7 µs to decompress 2.3 KB; the v1
  path's cost is mostly the JSON ↔ value ↔ sort-key conversions (≈4 µs for a 300-byte document, 50–70 µs for a
  3 KB one).
- The lease is Convex's (DV-413), as on Postgres: the newest start wins; the fence is a `FOR SHARE` read before
  COMMIT; a retried flush finds a landed group by its rows.
- Index scans take a page of keys and their newest ts from the primary key (grouped), then those rows and their
  documents, as Convex's v5 `index_scan`. A form that kept each row whose ts is its key's newest, by a lookup per
  row, took ~1 s a statement on a store with many versions.
- Conformance documents are sorted-field JSON (v1 hands documents back re-serialized).
- Checked locally with the Convex binary (`--db mysql-v5`): bunvex opened a database Convex created, wrote and read
  back, and Convex then served it, taking the lease back (it loaded bunvex's v1 `_tables` / `_index` rows).

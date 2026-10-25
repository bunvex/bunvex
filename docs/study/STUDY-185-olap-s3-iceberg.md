# STUDY-185 — OLAP: the managed S3 export (Iceberg change log)

- **Status:** draft. Nothing to build until the owner answers §6. The open-source binary does not run the writer.
- **Convex source read:** `db19afd4a` of get-convex/convex-backend (2026-10-22, "Report Parquet bytes as S3 export egress"). Ahead of bunvex's reference `72ce13c` (2026-10-09). The writer landed 2026-10-06 (`c4dfd3b46`) and was still moving on 2026-10-22.
- **Related:** [STUDY-60](STUDY-60-streaming-export.md), [STUDY-69](STUDY-69-data-sync.md) (the page Porter consumes), [STUDY-59](STUDY-59-log-streams.md) (the sink row), [docs/parity/platform.md](../parity/platform.md) (S3 export drains, as the open-source stub).

This is not a SQL engine inside the database. Convex's public comments and the code agree: analytical SQL stays off the transactional store. What they are testing internally is a mirror. A worker copies document revisions into Apache Iceberg tables in the customer's S3 bucket and registers them in AWS Glue. Athena, Spark, DuckDB or ClickHouse run the SQL against that bucket.

## 1. How Convex does it

### 1.1 What the founders said, and what the code is

| When | Who | What they said | What the repo has |
|---|---|---|---|
| 2023-01-30 | Jamie Turner, [HN](https://news.ycombinator.com/item?id=34582549) | An early SQL read adapter was kept on ice: SQL on the live store would slow the app the way every other database does. The practice was Airbyte into ClickHouse, MySQL or Snowflake. A later idea was an embedded column store (DuckDB was the example), not built. | No SQL parser, no DuckDB, no DataFusion. |
| 2025-12-17 | Jamie Turner, [Discord](https://discord-questions.convex.dev/m/1450920191415419114) | Fivetran can sync out to ClickHouse. Soon, built-in OLAP so people can run read-only SQL against their tables. | Still no query endpoint. |
| 2026-08-16 | Nipunn Koorapati, [Ship #234](https://ship.convex.dev/requests/js748s9fhk0391q18a4hjww71x83e5xr) | Working on it this quarter: replicate to an S3 bucket, streaming, in a standard format BI tools and OLAP databases can connect to. Estimated Q3 2026, still in progress. | This study. |

The internal name of the writer is **Porter**. The dashboard cites `crates_private/porter/src/managed_sync.rs` (`warehouse_uri`, `glue_database_name`). That crate is not in the public checkout. The public binary's `InProcessExportProvider::sync` returns *"In-process managed streaming exports are not implemented yet"* (`crates/exports/src/interface.rs`). `local_backend` wires that provider (`crates/local_backend/src/lib.rs`). The self-hosted dashboard forces `s3ExportIntegrationEnabled: false`.

So an app on the open-source binary can store an S3 export configuration. The worker starts, calls `sync`, and the call fails. The log manager's client for this sink only drains events (`crates/log_streaming/src/lib.rs`, `SinkConfig::S3Export`). bunvex already matches that stub (`packages/server/src/log-sinks.ts`, `DrainingSink`).

### 1.2 The configuration an operator stores

One row in `_log_sinks`, type `s3Export`, beside the log streams. It is not a log sink: it carries no topics and the log manager does not deliver function logs to it (`crates/model/src/log_sinks/types/s3_export.rs`).

`S3ExportConfig`: `bucket`, `region`, `prefix` (optional), `accessKeyId`, `secretAccessKey`, `selection`, `period`.

- **Period.** `continuous`, `hourly`, `daily` (`npm-packages/system-udfs/convex/tableDefs/streamingExport.ts`).
- **Selection.** The streaming-export `Selection`: nested maps of component, table and column, with `_other` as the default. Field filters are rejected: `FieldFiltersUnsupported`, "S3 exports can't filter fields within a table yet. Select whole tables instead." (`crates/local_backend/src/log_sinks.rs`, `validate_s3_selection`).
- **Destination is frozen.** Changing bucket, region, prefix or access key id is `S3ExportDestinationChanged` (400). The secret, the selection and the period may change. A prefix of `None` and `""` are the same root; an update that only respells the prefix keeps the stored one (`requires_resync`, `ensure_same_s3_destination`).
- **Bucket name.** AWS rules: 3–63 characters, lowercase, digits, dots and hyphens, no `..`, not an IPv4 address, not the reserved prefixes `xn--` / `sthree-` or suffixes `-s3alias` / `--ol-s3`. Error `InvalidS3Bucket`.
- **Auth.** `create_log_stream` and `update_log_stream` for this type need `WriteIntegrations` and `ViewData` (Convex `4933aa2`). One sink of the type per deployment.
- **Listing.** `listConfiguredSinks` omits `secretAccessKey` and joins `_s3_export_state` as `exportProgress`.

Progress lives in `_s3_export_state`, indexed by `configId`, not on the sink row (`crates/model/src/s3_export_state`). `S3ExportProgress` is `snapshotting` (table and document counts, current component and table), `stale { ts }` or `upToDate { ts }`. `ts` is nanoseconds.

### 1.3 The worker

`S3ExportWorker` (`crates/application/src/s3_export_worker.rs`) is spawned with the application (`crates/application/src/lib.rs`). One loop:

1. Read the `s3Export` sink as system. If there is none, clear the gauges and wait until `_log_sinks` changes.
2. Read the progress checkpoint in the same transaction. The configuration read stays in that transaction so OCC also sees an edit that restores the old values while a page is in flight.
3. Call `ExportProvider::sync` with the latest database snapshot, `SyncDestination::ByoAwsBucket` (no custom endpoint from the config), `SyncFormat::Iceberg`, the selection, and the sink document id as `export_id`. Porter commits the page in S3 before it returns. The open-source provider bails here.
4. Bill the returned page as `CallType::Export` (`s3_export`). A lost checkpoint race does not un-bill it. Parquet bytes are reported as egress (`db19afd4a`).
5. Write the new checkpoint to `_s3_export_state` if it changed (`s3_export_worker_record_progress`). Losing this commit loses no exported data: the cursor lives in S3 (`9ff64aab5`, "Stop storing the S3 export cursor in the backend").
6. If the page is `upToDate`, sleep. `continuous` wakes on the next write, on a config change, or after 5 s (`CONTINUOUS_POLL_INTERVAL`). `hourly` is 3600 s and `daily` is 86400 s, or sooner if the sink row changes. Any other status starts the next page immediately. The due time is wall clock, because an idle deployment's snapshot timestamp only moves with the repeatable-timestamp heartbeat.
7. A failure backs off from 1 s to 60 s and is reported.

`SyncDestination::Managed` (a Convex-owned bucket) and a custom `endpoint_url` exist on the type (`crates/streaming_export/src/managed.rs`). The worker always passes the customer's bucket and `endpoint_url: None`. The custom endpoint is for a local mock that serves both S3 and Glue.

### 1.4 What one page is

Porter is the missing function. The commits describe it (`19a02dfda`, `5c8a555d9`). It does not pull the public HTTP data-sync API. It runs the same iterator the API uses (`crates/streaming_export/src/lib.rs`, `data_sync`) and writes the page itself.

`data_sync` (STUDY-69) returns:

- `truncates`: tables that entered the sync on this page (cold start, newly selected, or replaced by an import). Apply them before the rows. A deselected table is not deleted here; it is retired later.
- `entries`: a document (`ts`, component, table, document) or a tombstone (`ts`, component, table, id).
- `cursor`: the opaque `SyncCursor`.
- `status`: `Snapshotting`, `Stale { ts }` or `UpToDate { ts }`.

For each request Porter:

1. Reads `s3://<bucket>/<prefix>/<deployment>/data-lake/_convex/state.json`. If `export_id` matches, it re-mirrors that state to Glue first, which finishes a mirror a crash interrupted. A missing object, or one from another export id, starts fresh.
2. Writes the page with `IcebergChangeWriter::staged` (S3 only, no Glue).
3. Commits data and cursor with one conditional PUT of the state (`If-Match` on the ETag, or `If-None-Match: *` for the first page). 409 or 412 is `ExportStateConflict`.
4. Mirrors Glue and returns. The cursor it returns to the worker is empty; the next page reads the cursor from the state object. Porter ignores a cursor on the request.

The state object (`crates/managed_export/src/destination.rs`, `ExportState`): `export_id` (the `_log_sinks` id), `page` (a counter), `cursor` (base64 `SyncCursor`, absent before the first page), `tables` (Glue name to current Iceberg metadata location), `retired` (Glue names marked retired).

Layout, from the dashboard, which mirrors Porter (`S3ExportStatus.tsx`):

- Warehouse: `s3://<bucket>/<prefix>/<deploymentName>/data-lake/`.
- One directory per source table, case-sensitive: `data-lake/<component>/<table>/`. The root component is the directory `app`. A component path's `/` becomes `__`.
- Glue database: the deployment name lowercased, every character outside `[a-z0-9]` replaced by `_`.
- Glue table: `<component>__<table>` lowercased. Names are at most 255 bytes and must match `[a-z0-9_]+`. Two Convex tables that collapse to the same Glue name or the same directory are an error. An S3 location longer than 896 bytes is an error (keys are at most 1024; the rest is Iceberg's file names).

The IAM policy the dashboard shows is least privilege on that prefix: `s3:ListBucket` on the prefix, get/put/delete/abort-multipart on `…/data-lake/*`, and Glue get/create/update/delete of that database and its tables.

### 1.5 The Iceberg table

`crates/managed_export` (crate `iceberg` 0.10.1, Parquet 58). Each table is an **append-only change log**, unpartitioned. Schema (`change_log_schema`):

| id | name | type | required |
|---|---|---|---|
| 1 | `_id` | string | yes |
| 2 | `ts` | long | yes |
| 3 | `deleted` | boolean | yes |
| 4 | `payload` | string | no |

A row is one revision. `deleted` is true exactly when `payload` is null. A retried page can repeat rows; readers deduplicate on (`_id`, `ts`). The current document is the row with the greatest `ts` for that `_id`, dropped when that row is a delete.

Table properties: `convex.porter.encoding` = `convex-change-log-json-v1`, `convex.porter.component`, `convex.porter.table` (Glue lowercases names, so these keep the real names), and `convex.porter.retired` = `true` or `false`. Each append records `convex.export-id` and `convex.page` on the snapshot. Glue parameters mirror those plus `table_type=ICEBERG` and `metadata_location`.

`apply(truncated, changes)` drops and recreates a truncated table (so a replaced `Users` does not keep `users`'s files), then appends. Creates the table on first use. `retire_unselected` runs only at a consistent snapshot, when `selected` lists every source table: it sets `convex.porter.retired` on tables the selection no longer includes and clears it on the rest. It does not delete their files. A slow Glue mirror will not move a table backward or drop a later page's table: a table already stamped at this export's page or later is left alone (`ExportStore::publish`).

The staged writer uses an in-memory Iceberg catalog whose files go to S3 through OpenDAL. Glue is written only by the mirror. File names are UUID-prefixed because the generator numbers from zero per writer. The duplicate-file check is off, because those names cannot collide, and because the check would read every manifest.

The JSON inside `payload` is produced in Porter, which is not in this checkout. The public writer treats it as an opaque string. The encoding property names the version `convex-change-log-json-v1`. The data-sync page bunvex already emits uses `export_json` (STUDY-69); whether Porter stores that string, or another encoding, is not visible here.

### 1.6 How a reader queries it

There is no query API on the deployment. The operator points Athena (or any Iceberg engine) at the Glue database. The read is: latest `ts` per `_id`, skip `deleted`, and ignore a table whose `convex.porter.retired` is `true`. A table that was truncated has a new metadata location; older files are not part of the current snapshot.

Compaction, partitioning and equality deletes are not in this code. Every revision stays as a row until something outside this crate compacts the table. That is why the worker's job is replication, not serving the analytical query: a scan of the change log never takes a lock in the document store, and a heavy aggregation never shares the transaction scheduler.

## 2. What an app can observe

On **Convex Cloud**, once the flag is on (it is not, in the source defaults):

- Creating the integration with the dashboard or `POST /api/v1/create_log_stream` (`logStreamType: "s3Export"`).
- Objects under `s3://<bucket>/<prefix>/<deployment>/data-lake/`, Glue tables, and the state object `data-lake/_convex/state.json`.
- Progress on the integration card: starting, snapshotting (counts), stale, up to date, or the sink's failed reason.
- Documents appear as revisions, not as a rewritten current row. Deletes remain as rows with `deleted = true`.
- A change of bucket, region, prefix or access key id is refused. Field filters are refused.
- The deployment's own queries, mutations and sync are unchanged. The export reads a snapshot and the document log the way data sync does. It does not add a SQL function to `ctx`.

On the **open-source binary**, and on bunvex today: the configuration is stored, the secret is hidden from `listConfiguredSinks`, create and update require view-data, and nothing is written to S3. The self-hosted dashboard does not offer the card.

## 3. How bunvex does it

Today it matches the open-source stub, which is what [platform.md](../parity/platform.md) records. `s3Export` is a `DrainingSink`: `verify` and `send` do nothing (`packages/server/src/log-sinks.ts`). The create and update routes accept the body, check the bucket with a shorter rule than Convex's, and require `ViewData` (`packages/server/src/log-sinks-routes.ts`). There is no `_s3_export_state`, no progress join, no destination freeze, and no `FieldFiltersUnsupported`.

The page source a writer would consume is already in process: `dataSync` / `dataSyncPage` (`packages/server/src/data-sync.ts`). A bunvex Porter would be a worker in the server process, not a second program and not an HTTP client of its own API.

If the owner wants the cloud behaviour, the shape is:

1. **Close the configuration gaps** so the stored row matches Convex before any byte is written: full bucket check, `FieldFiltersUnsupported`, `S3ExportDestinationChanged`, `_s3_export_state` with `by_config_id`, and `exportProgress` on `listConfiguredSinks`.
2. **A worker** with Convex's loop: no sink means wait; one page; bill it; checkpoint; sleep 5 s / 1 h / 24 h or until the next commit when caught up; backoff 1–60 s. It calls `dataSyncPage` on the engine. The cursor it passes is the one in the state object, not a cursor in the database.
3. **An Iceberg writer**, written in TypeScript, aimed at the contract in §1.5: the four columns, append-only Parquet, unpartitioned, UUID-prefixed files, metadata locations recorded in the state object, truncate as drop-and-create, retire as a property. The Rust crate is the reference for behaviour, not a source to translate line by line.
4. **The commit.** Read `data-lake/_convex/state.json` (the key is part of the contract; see Q2). Conditional PUT, then Glue `CreateDatabase` / `CreateTable` / `UpdateTable` / `DeleteTable` with `convex.export-id` and `convex.page` (see Q2). A 409 or 412 retries the page.
5. **Dashboard.** The card already exists in Convex's dashboard-common and is hidden on self-hosted. bunvex shows it only if this worker exists. The status UI can reuse the Fivetran progress shape Convex already maps `S3ExportProgress` onto.

What this does **not** add: a SQL endpoint, a DuckDB inside the transaction, or aggregates in queries. Those would put the analytical scan on the same scheduler as the app, which is the design Convex refused in 2023 and has not built.

## 4. Divergences

Each one is the owner's. None is decided. Q2 is the one that changes bytes an analytics tool sees.

| # | Divergence | Why | Decision |
|---|---|---|---|
| D1 | bunvex does not write the mirror. It stores the config and drains, as Convex's open-source binary. Convex Cloud's Porter is private and still moving (last public commit 2026-10-22). | Matching the binary an app runs locally. Building Porter is matching an unreleased cloud feature. | pending |
| D2 | If D1 is "build it": the state key `data-lake/_convex/state.json`, the properties `convex.porter.*` and `convex.export-id` / `convex.page`, and the encoding name `convex-change-log-json-v1` contain a name rule 5 forbids in shipped strings. Renaming them means a Glue table written by bunvex is not the table Convex's dashboard and a Convex-aimed Athena query expect. | Rule 5, same kind of choice as DV-307. | pending |

The configuration gaps in §3 (bucket rules, field filters, frozen destination, progress table) are observable against Convex's API even while the writer stays a stub. They are part of D1's "match the binary" work if the owner wants the API exact before any mirror. They are not listed again here until that choice is made.

## 4b. Additions (beyond Convex)

None proposed. A local file catalog, a SQL endpoint, or DuckDB inside the process would be an addition and needs its own row after the owner asks for it.

| # | Addition | Why | Decision |
|---|---|---|---|

## 5. Tests

Against the open-source binary, today: create and update need `ViewData` (`packages/server/test/log-sinks.test.ts`). That is the stub.

If the writer is built, the checks that matter:

- A page of inserts, a replace, and a delete become three rows; the latest `ts` per `_id` with `deleted` skipped is the table. A repeated page does not change that result (duplicate (`_id`, `ts`) collapses).
- A truncate drops the previous snapshot: the new table has only the rows after the truncate.
- Deselecting a table sets `retired` and leaves the files. Selecting it again truncates.
- Two writers: the conditional PUT lets one commit; the loser sees the conflict and retries from the new state.
- A crash after the Parquet append and before the state PUT leaves the next page free to rewrite. A crash after the PUT and before Glue leaves the next page to finish the mirror, and Glue does not move backward.
- The worker does not start a second page while `snapshotting` without sleeping the hourly interval, and a `continuous` export waits for a write or 5 s once `upToDate`.
- Field filters and a changed bucket fail with Convex's codes, before any S3 call.
- Sabotage: drop the `deleted` flag or the dedupe and the read test fails. Point the conditional PUT at an unconditional PUT and the two-writer test fails.

A memory S3 and a memory Glue (the Rust tests use `memory://` and a custom endpoint that serves both) is enough. A real AWS account is not required for the contract.

## 6. Open questions

1. **Build Porter, or stay on the stub?** The binary Convex ships for self-hosting does not write Iceberg. bunvex matches that. Building it matches Convex Cloud's in-progress work, which is private and changed twelve times between 6 Oct and 22 Oct 2026. Recommendation: do not build it until Porter's loop stops moving, or until the owner explicitly wants the cloud feature early. The study is the record either way.
2. **If it is built, do the warehouse names match Convex's, including the `_convex` state key and the `convex.porter.*` properties?** Matching makes the same Athena and Glue setup work. Renaming obeys rule 5 and breaks that. This is D2.
3. **What is `payload`?** It is an opaque string in the public crate, versioned `convex-change-log-json-v1`, produced in the private crate. bunvex's data sync already writes `export_json`. Treating that as the payload is a guess until someone reads an object Porter wrote, or the crate is published. Do not invent the encoding in the writer.
4. **Glue.** Convex's mirror is AWS Glue. A self-hosted deployment with no AWS account has nothing to register. The S3 files would still be readable by DuckDB or Spark with the metadata location from the state object. Whether bunvex requires Glue, or also writes a catalog file an engine can open without Glue, is an addition (none proposed above).

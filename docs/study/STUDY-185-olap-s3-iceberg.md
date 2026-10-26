# STUDY-185 — OLAP: Convex's managed S3 export (an Iceberg change log)
<!-- index: OLAP: Convex's managed S3 export (Iceberg) | decided (owner, 2026-10-26): align the API, stay a stub; DV-570 -->

- **Status:** rewritten from scratch on 2026-10-25. Every claim here was checked again, at the source tag and
  against the binary. Decided (owner, 2026-10-26): every §6
  recommendation; DV-570. Nothing is built yet.
- **Convex source read:** `precompiled-2026-10-24-bb31399`. Files:
  - `crates/application/src/s3_export_worker.rs`;
  - `crates/exports/src/interface.rs`;
  - `crates/streaming_export/src/managed.rs`;
  - `crates/managed_export/` (`Cargo.toml`, `src/{lib,iceberg,iceberg_writer,destination}.rs`);
  - `crates/model/src/log_sinks/types/s3_export.rs` and `crates/model/src/s3_export_state/`;
  - `crates/local_backend/src/log_sinks.rs`;
  - `crates/log_streaming/src/lib.rs`;
  - `crates/model/src/backend_info/mod.rs`;
  - `npm-packages/system-udfs/convex/_system/frontend/listConfiguredSinks.ts`;
  - `npm-packages/dashboard-common/.../integrations/S3ExportStatus.tsx`;
  - `npm-packages/dashboard-self-hosted/src/pages/_app.tsx`;
  - `npm-packages/docs/docs/production/state/state.mdx`.
- **Oracle:** the Convex binary at the same tag, through `packages/differential`. The log stream API was probed on
  both backends (§2.2).
- **Related:**
  - [STUDY-60](STUDY-60-streaming-export.md) and [STUDY-69](STUDY-69-data-sync.md) (the data-sync page the writer
    consumes);
  - [STUDY-59](STUDY-59-log-streams.md) (the `_log_sinks` row);
  - [STUDY-186](STUDY-186-convex-after-72ce13c.md) A13 and A14 (the S3 export API items already queued);
  - `docs/parity/platform.md` (log sinks rows).
- **What changed from the earlier draft:**
  - The Iceberg writer is public code. Only the driver that calls it is private.
  - The destination freeze is a body-shape error, not `S3ExportDestinationChanged`.
  - Four differences between bunvex and Convex were measured that the draft did not list (§2.2).
  - One founder quote could not be checked (§1.1).

## 1. How Convex does it

### 1.1 What Convex said, and what is in the code

| When | Who, where | What was said | Checked |
|---|---|---|---|
| 2023-01-30 | Jamie Turner, [HN 34586364](https://news.ycombinator.com/item?id=34586364) | A SQL read adapter was "kept on ice": SQL on the live store would make "your website … slow down just like every other database". The recommended practice was Airbyte into ClickHouse, MySQL or Snowflake, "That's basically what we do". Maybe one day "some sort of mirrored column store sql thing (maybe DuckDB based? who knows)", "probably won't for some time" | yes, the comment text through HN's Algolia API |
| 2026-08-16 | Nipunn Koorapati, [Ship #234](https://ship.convex.dev/requests/js748s9fhk0391q18a4hjww71x83e5xr) "Better support for analytics/OLAP" | "I'm working on this in this quarter": replicate to an S3 bucket, streaming, in a standard format BI tools and OLAP databases connect to. Status "In Progress", Q3 2026 | yes (the page shows Aug 16; the request is from March 2026) |
| 2025-12-17 | Jamie Turner, Discord (cited by the earlier draft) | built-in read-only SQL "soon" | **not checked**: the page answered 429. Treat it as unverified |

Convex's public docs still say the same thing today (`production/state/state.mdx`): Convex serves OLTP. For OLAP,
download a backup or use the Fivetran connector (streaming export).

The code agrees: there is no SQL parser, no DuckDB and no query endpoint anywhere in the repository. What Convex is
building is a **mirror**: document revisions copied into Apache Iceberg tables in the customer's S3 bucket and
registered in AWS Glue. The SQL runs elsewhere, in Athena, Spark, DuckDB or ClickHouse.

### 1.2 What is public and what is private

| Piece | Where | Public? |
|---|---|---|
| The configuration row, the API, the progress table, the dashboard card | `model`, `local_backend`, `system-udfs`, `dashboard-common` | yes |
| The worker loop that calls the exporter once per page | `application/src/s3_export_worker.rs` | yes |
| The Iceberg writer (`IcebergChangeWriter`) and the commit store (`ExportStore`: state object plus Glue mirror) | `crates/managed_export` | yes, but **no public crate depends on it** (only its own `Cargo.toml` names it) |
| The driver ("Porter") that reads a snapshot, runs the data-sync iterator, calls the writer and commits | `crates_private/porter/src/managed_sync.rs`, named in a comment in `S3ExportStatus.tsx:22,31` | no |

The open-source binary wires `InProcessExportProvider` (`local_backend/src/lib.rs:280`). Its `sync` fails with
"In-process managed streaming exports are not implemented yet" (`exports/src/interface.rs`). So on a self-hosted
Convex:
- the worker starts (`application/src/lib.rs:929-938`);
- it finds the config and calls `sync`;
- the call fails, and the worker backs off from 1 s to 60 s and reports the error, forever, while an S3 export
  exists.

The self-hosted dashboard hides the card (`dashboard-self-hosted/src/pages/_app.tsx:332`,
`s3ExportIntegrationEnabled: false`). The log manager gives this sink a client that only drains events
(`log_streaming/src/lib.rs:747-753`).

### 1.3 The configuration

The configuration is one `_log_sinks` row of type `s3Export`
(`model/src/log_sinks/types/s3_export.rs`). It carries `bucket`, `region`, `prefix?`, `accessKeyId`,
`secretAccessKey`, `selection` and `period` (`continuous` | `hourly` | `daily`).

**Create** (`POST /api/v1/create_log_stream`, `logStreamType: "s3Export"`; `local_backend/src/log_sinks.rs`):
- **Permissions:** `WriteIntegrations`, plus `ViewData` for this type (`:669-671`). The gate
  `ensure_streaming_export_enabled` is on by default for local and self-hosted (`backend_info/mod.rs:77-91`).
- **One export per deployment.** A second create gets 409 `LogStreamAlreadyExists`, "S3Export log stream already
  exists for this deployment".
- **Bucket name** (`validate_s3_bucket`, `:507-531`):
  - 3–63 characters of `[a-z0-9.-]`, starting and ending with a letter or digit;
  - no `..`;
  - not an IPv4 address;
  - not the reserved prefixes `xn--` / `sthree-` or suffixes `-s3alias` / `--ol-s3`.

  Otherwise: 400 `InvalidS3Bucket`, "`<b>` is not a valid S3 bucket name".
- **Selection:**
  - It defaults to everything, which is stored and returned as `{"_other":"included"}` (`Selection::default`).
  - A selection that filters fields inside a table is refused: 400 `FieldFiltersUnsupported`, "S3 exports can't
    filter fields within a table yet. Select whole tables instead." (`validate_s3_selection`, `:453-473`).

**Update** (`UpdateS3ExportSinkArgs`, `:1274-1288`, `deny_unknown_fields`):
- It takes only `secretAccessKey`, `selection` and `period`.
- A body naming `bucket`, `region`, `prefix` or `accessKeyId` is refused as a body-shape error: 400 `BadJsonBody`,
  "Failed to deserialize the JSON body into the target type: unknown field `region`, expected one of
  `secretAccessKey`, `selection`, `period`" (measured).
- The `S3ExportDestinationChanged` check (`ensure_same_s3_destination`) runs after the update copies the old
  destination, so it cannot fire through the API.

**Reading back:**
- `list_log_streams` / `get_log_stream` return the config without the secret, and leave out `prefix` when it is
  absent (`S3ExportLogStreamConfig`, `:1014-1032`).
- The dashboard's `listConfiguredSinks` also drops `secretAccessKey`. It joins `_s3_export_state` (index
  `by_config_id`) as `exportProgress`.

**Progress** (`model/src/s3_export_state/types.rs`) is one of:
- `snapshotting`: tables and documents done and in total, and the current component and table;
- `stale { ts }`;
- `upToDate { ts }`.

### 1.4 The worker

`S3ExportWorker::run_once` (`application/src/s3_export_worker.rs`):

1. **Read the config as system.** With no export, it clears its gauges and waits for `_log_sinks` to change.
2. **Read the checkpoint, then drop the transaction.** A page can outlast the write log's retention, so the
   worker cannot keep that transaction open (comment at `:126-130`).
3. **Run one page.** It calls `ExportProvider::sync` on the latest snapshot with these arguments:
   - `SyncDestination::ByoAwsBucket { bucket, region, prefix, endpoint_url: None, keys }`;
   - `SyncFormat::Iceberg`;
   - the selection;
   - the `_log_sinks` id as `export_id`.

   The exporter commits the page in S3 before it returns.
4. **Bill the page** as `CallType::Export` ("s3_export"). The Parquet bytes count as egress.
5. **Re-read the config in a new transaction.** If the config changed, or the checkpoint moved, it stops.
   Otherwise it writes the new progress to `_s3_export_state`. Losing that commit loses no data: the cursor lives
   in S3.
6. **Sleep only when `upToDate`:**
   - `continuous` wakes on the next write, a config change, or 5 s;
   - `hourly` and `daily` wake after 1 h or 24 h, or on a config change.

   Any other status runs the next page at once.
7. **On failure,** back off 1–60 s.

### 1.5 One page, as the public writer and commit store define it

What Porter does between "read the cursor" and "return" is private. The public crate fixes its contract:

- **State object** (`destination.rs`, `ExportState`):
  - JSON fields: `export_id`, `page`, `cursor` (base64 `SyncCursor`), `tables` (Glue name → Iceberg metadata
    location) and `retired`.
  - It is read with its ETag and committed with a conditional PUT: `If-Match`, or `If-None-Match: *` for the
    first page.
  - A 409 or 412 is `ExportStateConflict`. That single PUT is the page's commit point.
  - Its key is not in the public crate; the dashboard and the earlier draft place the data under
    `…/data-lake/`.
- **Writer** (`iceberg_writer.rs`, `IcebergChangeWriter::staged`):
  - It uses an in-memory Iceberg catalog over S3 (OpenDAL) and never touches Glue.
  - Tables are registered lazily, from the state's metadata locations, when a page needs them.
  - `apply(truncated, changes)` drops and recreates a truncated table, then appends each table's changes as one
    snapshot.
  - `retire_unselected` sets the table property `convex.porter.retired` to `true` or `false`. It never deletes
    files.
- **Table** (`iceberg.rs`, `change_log_schema`):
  - The table is append-only and unpartitioned, with four columns: `_id` string, `ts` long, `deleted` boolean,
    `payload` string (optional).
  - A delete is a row with `deleted = true` and no payload.
  - A retried page can repeat rows, so readers dedupe on (`_id`, `ts`) and take the latest `ts` per `_id`.
  - The file names are UUID-prefixed, and the duplicate check is off.
- **Names:**
  - The root component is `app`, and a component path's `/` becomes `__`.
  - The Glue table is `<component>__<table>` lowercased: at most 255 bytes, `[a-z0-9_]`.
  - The directory keeps the exact case.
  - A location is at most 896 bytes. Two tables that collapse to one name or directory are an error.
  - The Glue database is the deployment name lowercased, with every other character replaced by `_`
    (`S3ExportStatus.tsx:32-33`).
- **Glue mirror** (`ExportStore::publish`):
  - It creates the database, then creates, updates or drops tables until Glue matches the state.
  - It never moves a table backward: a table stamped with this export's `convex.page` at or after the state's
    page is left alone.
  - A crash between the PUT and the mirror is finished by the next page.
- **Properties carrying Convex's name:**
  - `convex.porter.encoding = convex-change-log-json-v1`;
  - `convex.porter.component` and `convex.porter.table`;
  - `convex.porter.retired`;
  - the Glue parameters `convex.export-id` and `convex.page`.

  These are the bytes an analytics tool reads.
- **The `payload` encoding** is produced by Porter and is not visible. The writer treats it as an opaque string.
- **Not in the code:** compaction, partitioning, equality deletes. Every revision stays a row.
- **IAM policy shown by the dashboard** (`S3ExportStatus.tsx:53-92`): `s3:ListBucket` on the prefix;
  get/put/delete/abort-multipart under it; Glue get/create/update/delete on that database and its tables.

## 2. What an app observes

### 2.1 On Convex

- **Cloud, with the flag on:** the dashboard card and the progress states, objects in the customer's bucket, and
  Glue tables.
- **Unchanged:** the app's own queries, mutations and sync. The export reads a snapshot and the document log, as
  data sync does.
- **Open-source binary:**
  - the API stores and validates the config;
  - nothing is written to S3;
  - the server log shows the worker's error with backoff while the export exists;
  - the self-hosted dashboard does not show the card.

### 2.2 bunvex against the binary (measured 2026-10-25)

The same calls were made on both backends.

| Call | Convex | bunvex |
|---|---|---|
| create, bucket `192.168.1.1` | 400 `InvalidS3Bucket` | 200, stored |
| create, bucket `xn--abc` or `abc-s3alias` | 400 `InvalidS3Bucket` | accepted (the regex at `log-sinks-routes.ts:162-165` has no IPv4 or reserved-name rule) |
| create, bucket `ab` | 400 `InvalidS3Bucket` | 400 `InvalidS3Bucket` |
| create with a field filter | 400 `FieldFiltersUnsupported` | accepted (`:240-259`) |
| create, then list | `selection: {"_other":"included"}`; no `prefix` key; `status: pending`, then `active` on the next read | `selection: null`; `prefix: null`; `status: active` at once |
| update naming `bucket`/`region` | 400 `BadJsonBody` "unknown field …" | accepted, destination changed (`:345-350`) |
| second create | 409 `LogStreamAlreadyExists` | the same |
| `listConfiguredSinks` | secret dropped; `exportProgress` joined | secret dropped; there is no `_s3_export_state` table |
| worker | fails and backs off, logged | none (the `DrainingSink` stub only) |

STUDY-186 A13/A14 already cover:
- the field filters;
- the frozen destination;
- the existence check;
- `_s3_export_state`.

The bucket rules, the stored default selection, the `prefix` key and the `pending` status are new here. STUDY-186
A13 also describes the frozen destination as "400 when bucket … change". The status is right, but the code is
`BadJsonBody`, not a destination code. That wording gets corrected when A13 is built.

## 3. How bunvex does it

- **The API and stub:**
  - The `s3Export` row is stored and validated by `packages/server/src/log-sinks-routes.ts` with the gaps in §2.2.
  - It runs as a `DrainingSink` (`packages/server/src/log-sinks.ts`).
  - `listConfiguredSinks` drops the secret (`system-functions.ts`).
- **The page a writer would consume is already in the process:** `dataSync` / `dataSyncPage`
  (`packages/server/src/data-sync.ts`, STUDY-69).
  - Its truncates, entries, tombstones, cursor and status are the inputs `IcebergChangeWriter::apply` takes.
  - A bunvex writer would be a worker in the server, not an HTTP client of its own API.
- **Missing for a writer:** an Iceberg/Parquet writer in TypeScript, an S3 conditional PUT (the S3 client in
  `packages/file-storage` signs requests already) and a Glue client.

## 4. Divergences

D1 is DV-570 (owner, 2026-10-26, Q2). D3 is recorded with the PR that builds Q1 (Q4). D2 waits for Q3, which
only arises if a writer is ever built.

| # | Possible divergence | Why it arises |
|---|---|---|
| D1 | bunvex does not write the mirror, as Convex's open-source binary does not | the driver is private; the public pieces around it took 23 commits between 2 and 23 Oct 2026 |
| D2 | Only if a writer is built: the state object, the table properties, the Glue parameters and the encoding name contain "convex" | rule 5 (no "convex" in shipped strings). Renaming them makes a bunvex lake differ from what Convex's dashboard and an Athena setup written for Convex expect |
| D3 | The open-source worker logs a failure every ≤60 s while an export exists; bunvex logs nothing | matching it would mean shipping a failing loop |

## 4b. Additions

None proposed. An embedded SQL engine, a local catalog file instead of Glue, or a writer to a bucket of bunvex's
own would each be an addition, and each needs the owner's request first.

## 5. Tests, when something is built

**For the API:** a differential test of every row in §2.2, which must match Convex exactly. Sabotage: drop the
IPv4 rule.

**If a writer is built:**
- inserts, a replace and a delete become rows whose latest `ts` per `_id`, without deletes, is the table, and a
  repeated page changes nothing;
- a truncate leaves only the rows after it;
- deselecting a table retires it and keeps its files;
- two writers: the conditional PUT lets one win;
- a crash before the PUT is rewritten, and a crash after it is finished by the next page's Glue mirror without
  going backward.

A memory S3 and Glue is enough, as the Rust tests use.

## 6. Owner questions

Decided (owner, 2026-10-26): every recommendation below.

| # | Question | Recommendation (decided) |
|---|---|---|
| Q1 | Align the S3 export API with the binary now: the §2.2 rows plus STUDY-186 A13/A14 (bucket rules, field filters, the update body shape, default selection, the `prefix` key, the `pending` status, `_s3_export_state` and `exportProgress`)? | Yes. It is Convex-matching, small, and needs no S3 |
| Q2 | Build the writer (a bunvex Porter), or stay a stub as the open-source binary is? | Stay a stub (D1). The driver is private and still changing, the payload encoding is not visible, and building it would be guessing. Revisit when Convex ships it publicly or an app needs it |
| Q3 | If it is ever built: Convex's names in the lake (D2), or bunvex's? | Decide then. With the stub, nothing is written |
| Q4 | The open-source worker's failing loop (D3): match it? | No. Record D3 when Q1 is built; a failing loop helps no one |

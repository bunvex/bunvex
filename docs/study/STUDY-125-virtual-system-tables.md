# STUDY-125 — Virtual system tables: `_file_storage`, `_scheduled_jobs`, `_scheduled_job_args`

- **Status:** implemented (owner decision 2026-10-05: match Convex's physical/virtual layout; no legacy data,
  no migration)
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-05
- **Related:** STUDY-30 (scheduler, S2 / DV-140), STUDY-32 (file storage, F1 / DV-148), STUDY-42 (import and
  export, X9 / DV-223), STUDY-73 (storage gauges), STUDY-100 (typed `v.id`)

## 1. How Convex does it

### 1.1 The mapping

`crates/common/src/virtual_system_mapping.rs` defines `VirtualSystemMapping`. A system table may declare an
`AssociatedVirtualTable` (`SystemTable::virtual_table()`):

- `Primary { virtual_table_name, virtual_to_system_indexes, doc_mapper }`: the system table holds the virtual
  table's documents, ids, number and indexes. `_file_storage` → `_storage`
  (`crates/model/src/file_storage/mod.rs:81-118`), `_scheduled_jobs` → `_scheduled_functions`
  (`crates/model/src/scheduled_jobs/mod.rs:82-149`). Only two indexes map: `by_creation_time` and `by_id`.
- `Secondary(name)`: the system table holds some of the virtual table's fields. `_scheduled_job_args` →
  `_scheduled_functions` (`scheduled_jobs/args.rs`, no indexes of its own).

`crates/model/src/lib.rs` builds it from every system table (`virtual_system_mapping()`, line 648).

**Numbers and ids.** `DefaultTableNumber` (lib.rs:264-305) gives `ScheduledJobs = 27` (539), `FileStorage = 28`
(540), `ScheduledJobArgs = 38` (550). `DEFAULT_TABLE_NUMBERS` (lib.rs:357-379) also maps a PRIMARY virtual
table's name to its system table's number; a secondary table shares nothing. There is no table named
`_storage`: the id of a virtual document IS the system document's (`system_resolved_id_to_virtual_developer_id`
returns `developer_id` unchanged; `virtual_id_v6_to_system_resolved_doc_id` resolves the number to the
tablet). `all_tables_number_to_name` names a number by its virtual table when there is one, so `v.id("_storage")`
validates a `_file_storage` id (`isolate/src/ops/validate_args.rs`, `udf/src/validation.rs`), schema
validation does the same, and the dashboard's shapes say `Id<"_storage">`.

### 1.2 Documents

`_file_storage` (`file_storage/types.rs`, `FileStorageEntry`): `storageId` (the UUID string), `storageKey`,
`sha256` (bytes), `size` (int64), `contentType` (string or null); index `by_storage_id`.

`FileStorageDocMapper` (`file_storage/virtual_table.rs`) gives `_storage`: `{_creationTime, _id, contentType,
sha256, size}` — sha256 in base64 for npm ≥ 1.9.0 (hex before), `size` a float, `contentType` null when
absent. Clients older than 1.6.1 cannot read virtual tables at all.

`_scheduled_jobs` (`scheduled_jobs/types.rs:68-216`, `SerializedScheduledJob`): `component` (the component path,
`""` at the root), `udfPath`, `udfArgs` (bytes; no longer written, kept for old jobs), `argsId` (the
`_scheduled_job_args` id), `state` (`{type: "pending" | "inProgress" (requestId, executionId) | "success" |
"failed" (error) | "canceled"}`), `nextTs`, `completedTs`, `originalScheduledTs` (ns, int64; absent ones
null — serde's `None`), `attempts: {systemErrors, occErrors}`. Indexes `by_completed_ts`, `by_next_ts`,
`by_udf_path_and_next_event_ts`.

`_scheduled_job_args` (`types.rs:327-362`): `{args}`, the bytes of `args_to_bytes` — the JSON of the arguments
array in the internal encoding (`ConvexArray::json_serialize`, `convexToJson`'s).

`ScheduledJobsDocMapper` (`scheduled_jobs/virtual_table.rs`) joins them: reads the args document in the same
transaction (`tx.get_document`, so the read is recorded), else the inline bytes, and gives `{_creationTime,
_id, args, completedTime?, name, scheduledTime, state}` — times by `timestamp_to_ms` (whole ms plus the
fraction), `state.type` renamed `kind`.

### 1.3 The scheduler

`SchedulerModel::schedule` (mod.rs:238-328) inserts the arguments first, then the job pointing to them;
`nextTs = max(original, now)`. A job scheduled by an action whose own job was canceled is born canceled with
`original_scheduled_ts = completed_ts = begin_ts` (mod.rs:304-315). `complete` (346-394) clears `nextTs` and
sets `completedTs`. `delete` (414-432) deletes the job and its args document; the garbage collector
(`application/src/scheduled_jobs/mod.rs:1150-1210`) uses it, so arguments go with their job. The executor
reads the args through `scheduled_job_from_metadata` (mod.rs:200-236).

### 1.4 How apps read them

- `db.system.get(id)` (`isolate/src/environment/udf/async_syscall.rs:1466-1500`): decode; name the id's number
  with `all_tables_number_to_name` (virtual-aware); `system_table_guard` (210-226) refuses a user table's id
  with "User tables cannot be accessed with db.system." and, from `db.get`, a system one with "System tables
  can only be accessed with db.system."; a private system table's id resolves to nothing (null); a `table`
  argument must equal the id's table (`check_table_name`: `expected to be an Id<"…">, got Id<"…"> instead.`).
- `db.system.query`: `DeveloperQuery` on the virtual index name maps it to the system index
  (`virtual_to_system_index`), reads the system table and converts each document in `index_range.rs:196-210`,
  BEFORE the query's filters run (`query/mod.rs:157-161`: "Filters on virtual tables … should execute on the
  fields of the virtual table"). Reads are charged at the system document's size.
- `db.system.normalizeId("_storage", s)` (`syscall.rs` `syscall_normalize_id`): the virtual table's number is
  its system table's.

### 1.5 Export, import, gauges, dashboard

- Export (`crates/exports/src/lib.rs:156-220`, `export_storage.rs:65-140`): user tables, then — with storage —
  `_file_storage` read and written as `_storage/documents.jsonl` (`{_id, _creationTime, sha256 (base64), size,
  contentType, internalId (the UUID)}`) and `_storage/<id><.ext>`. `_scheduled_jobs` is never exported.
- Import (`snapshot_import/mod.rs:787`, `confirmation.rs:137`, `import_file_storage.rs`): `_storage` is imported
  into a hidden `_file_storage` (display name `_storage`), its ids must carry its number; other system tables are
  skipped. `table_conflict_error` (`bootstrap_model/table.rs:377-406`) says "conflict with existing system
  table" for any table associated with a virtual one (primary or secondary), "internal table …" for other
  system tables.
- Gauges (`snapshot_manager.rs:520-536`, `usage_gauges_tracking_worker/src/lib.rs:330-347`): a virtual table's
  document bytes are the sum of its associated system tables (`_scheduled_functions` = jobs + args).
- Dashboard (`npm-packages/system-udfs/convex/_system/frontend`): `paginatedScheduledJobs` returns raw
  `_scheduled_jobs` documents; `scheduler:getArgs` takes `argsId: v.id("_scheduled_job_args")` and returns the
  raw args document; `fileStorageV2` reads `db.system` (`getFile` on a user id then fails with the guard).

## 2. What an app can observe

- `_storage` and `_scheduled_functions` documents, their keys and types (base64 sha256, float size, ms times,
  `state.kind`, args joined), through `db.system.get` / `query` / `normalizeId`.
- Ids: a file's id is `Id<"_storage">` with number 540, a job's `Id<"_scheduled_functions">` with 539; they pass
  `v.id(<virtual>)` in arguments, results and schemas.
- Filters on `db.system.query` see the virtual fields (e.g. `size` is a float; a filter on `storageKey` matches
  nothing).
- The guard errors of `db.get` / `db.system.get` across user and system tables.
- Snapshot ZIPs (`_storage/…`), the dashboard's schedule queries, the gauges' `systemTableDocumentBytes`.

## 3. How bunvex does it

- `packages/core/src/catalog.ts`: `_scheduled_jobs` 539, `_file_storage` 540, `_scheduled_job_args` 550;
  `VIRTUAL_TO_SYSTEM_TABLE`, `SYSTEM_TO_VIRTUAL_TABLE`, `primaryVirtualTable`, `Catalog.publicNameOf(number)`
  (Convex's `all_tables_number_to_name`), used by `v.id` checks (arguments, results, schema writes, push),
  and the shapes routes.
- `packages/core/src/virtual-tables.ts`: the two virtual tables, their system tables and doc mappers
  (`virtualFile`; `virtualJob` in `scheduled-jobs.ts`).
- `packages/core/src/system-reader.ts`: `db.system` reads the system table; `Tx.queryVirtual` sets a mapping on
  the query state that the scan applies to each document before the operators (`tx.ts` `stream` and the
  limits-only path), so filters, `unique`, `paginate` and iteration see virtual documents; index keys and
  cursors are unchanged because `_id` / `_creationTime` are the system document's. The guards and messages of
  §1.4. Reads are charged at the system document's size.
- `packages/core/src/scheduled-jobs.ts`: Convex's documents; `insertJob` writes the args document then the job;
  `jobArgs` joins them; `deleteJob` / `deleteCompletedJobs` delete both; ns timestamps (`msToNs`, `nsToMs`
  as `timestamp_to_ms`). A born-canceled job is scheduled and completed at `now`, as Convex.
- `packages/server/src/scheduler.ts`: due jobs are read with their arguments at the same snapshot; a job whose
  arguments cannot be read fails its attempt as a system error (retried with backoff).
- `storage.ts`, `exports.ts`, `imports.ts`, `usage-gauges.ts`, `system-functions.ts`: as §1.5.

The owner said there is no legacy data (alpha): no migration, no reading of the old layout.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| V1 (DV-400) | The virtual documents are always the newest shape (base64 sha256); no client-version gate (Convex refuses virtual reads below npm 1.6.1 and gives hex sha256 below 1.9.0) | Não dá pra fazer: a bunvex function carries no Convex npm version, and bunvex's own clients are all newer than the shapes | pending owner (recommend: accept) |
| V2 (DV-401) | Every system index ends with `_creationTime` in bunvex (the new tables' `by_storage_id`, `by_next_ts`, `by_completed_ts`, `by_udf_path_and_next_event_ts` too); Convex leaves these out (`SYSTEM_INDEXES_WITHOUT_CREATION_TIME`) | Ainda não fizemos: pre-existing for every bunvex system table; private indexes, so only the order of exact ties differs (the dashboard's job list) | pending owner (recommend: match Convex for all system tables in a follow-up) |
| V3 (DV-402) | `db.system.get` of a user table's id returned null and `db.get(storageId)` returned null | Now as Convex's `system_table_guard`: both throw | resolved (matches Convex) |

DV-140 (STUDY-30 S2) and DV-148 (STUDY-32 F1) — real tables named `_scheduled_functions` / `_storage` with the
arguments inside — are resolved by this study.

Gaps that stay (not new): `paginatedScheduledJobs` canonicalizes `udfPath` (STUDY-30); `complete` of a job
already succeeded or failed is a no-op (Convex errors); `requestId` / `executionId` of an in-progress job are
bunvex's random hex, not Convex's formats; no components, so `component` is always `""`.

## 4b. Additions (beyond Convex)

None. `_storage_deletions` (bunvex's own deletion queue, DV-150) is unchanged.

## 5. Tests

- `packages/core/test/system-reader.test.ts`: every query shape returns the virtual `_storage` document (keys in
  Convex's order, float size); filters see the virtual fields (`sha256` base64 matches, `storageKey` does not,
  `size` an int64 does not); ids are the system documents' with number 540 and there is no `_storage` table;
  only `by_id` / `by_creation_time`; the physical tables are not reachable; the guards; the
  `_scheduled_functions` join and the stored job document.
- `packages/server/test/virtual-tables.test.ts`: `v.id("_storage")` in arguments and in a schema (a regression
  the examples caught), `db.get` of a file id refused, the args split, `db.system` join and a filter on
  `state.kind`, the executor reading `_scheduled_job_args`, garbage collection deleting both, a missing args
  document as a system error.
- `packages/sync-e2e/test/virtual-tables-oracle.test.ts` (oracle: the official `convex` package):
  `_scheduled_job_args` bytes equal `JSON.stringify(convexToJson(args))` and decode as `jsonToConvex` does, on
  samples and on 300 generated argument objects; `_storage`'s sha256 base64.
- Updated: catalog numbers, imports (into `_file_storage`, read back as `_storage`; system-table conflicts at
  539 / 550 vs 513), dashboard schedule queries (raw `_scheduled_jobs`, `getArgs` by `argsId`), file system
  functions (Convex's key order, the guard), gauges (`_scheduled_functions` = jobs + args), executor races.

**Sabotage** (each restored, `git status` clean after): S1 sha256 left as bytes — 2 tests fail; S2 mapping
skipped in the scan (filters on system fields) — 2; S3 arguments not split — 4; S4 GC keeps arguments — 2;
S5 ids named by the system table — 8; S6 `_scheduled_job_args` number 551 — 2; S7 gauges without arguments — 1;
S8 `_storage` imported under its own name — 2; S9 `db.system.get` lets a user id through — 2; S10 ns stored
as ms — 3. All caught.

**Measurements** (`bench.ts` in the PR body; 2000 jobs / 2000 files, memory persistence, interleaved runs of
main and this branch on one machine): the executor runs 1354–1502 jobs/s before and 1382–1620 after (no
change within noise); scheduling 2000 jobs from mutations takes 35–72 ms before and 73–106 ms after (two
inserts per job, as Convex); `db.system.query("_storage").collect()` of 2000 files 2.6–4.4 ms before, 5.0–6.3 ms
after — the raw read itself doubles (bytes and int64 fields decode slower than strings and floats), the
mapping is small; `db.system.get` and `getUrl` per file ~3.4–5.8 µs before, ~4.0–5.8 µs after.

## 6. Open questions

DV-400 and DV-401 (§4) for the owner.

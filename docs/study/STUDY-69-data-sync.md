# STUDY-69 — Data sync (`/api/v1/data/sync`), the current Fivetran connector's API

- **Status:** implemented. Owner decisions (2026-10-03): Convex's cursor format; per-document revision
  timestamps from a new driver method (PERSIST-01 C16, the PR before this one); `Convex-Client` accepted
  by rule 5's wire-name exception.
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-03
- **Related:** [STUDY-60](STUDY-60-streaming-export.md) (the legacy routes), PERSIST-01 C12 (the document log)
  and C16 (document versions), STUDY-33 (retention), [STUDY-52](STUDY-52-shape-inference.md) (table counts)

## 1. How Convex does it

Sources: `crates/streaming_export`, `crates/table_iteration/src/data_sync.rs`,
`crates/local_backend/src/streaming_export.rs`, `crates/model/src/data_sync_progress` and
`crates/fivetran_source`.

### 1.1 The routes

| Route | Body or query | Answer |
|---|---|---|
| `POST /api/v1/data/sync` | `{cursor?, selection?}` | `{status, truncates, values, syncId, pagination: {hasMore: true, nextCursor}}` |
| `GET /api/v1/data/list_active_syncs` | `limit` (1–100, else `LimitOutOfRange`), `cursor` | `{syncs: [ActiveDataSync], pagination}` |
| `GET /api/v1/data/sync/{syncId}` | — | an `ActiveDataSync`, else 404 `DataSyncNotFound` |
| `POST /api/data_sync_cursor_from_deltas` | `{cursor: ns, selection?}` | `{cursor}` |

- **Checks.** Every route checks the streaming export entitlement, which is on when self-hosted, and then
  `ViewData`.
- **Status.**
  - `status` is `{type: "snapshotting"}`, `{type: "stale", snapshotTs}` or `{type: "upToDate", snapshotTs}`.
  - The connector stops at `upToDate`.
- **Values.** Each value is `{component, table, ts, deleted, value}`:
  - `value` is in the export encoding (`export_json`);
  - a delete is `{_id}`;
  - `ts` is in nanoseconds.
- **Errors.**
  - `InvalidDataSyncCursor`: an unreadable cursor, or one ahead of the deployment.
  - `InvalidDataSyncSelection`.
  - `DataSyncCursorExpired`: a cursor outside retention.
  - `InvalidClientVersion`: a malformed `Convex-Client` header.

### 1.2 The cursor

- **The message.** `DataSyncCursor`, a protobuf:
  - `synced_ts` (ns);
  - the synced tablets, each with its component and name;
  - `Synced`, or `InProgress{tablet, …, current_id, docs_synced}`;
  - `sync_id`;
  - `num_docs_synced`.
- **The seal.** AES-128-GCM-SIV under the KBKDF key "data sync cursor", a random nonce, AAD = [1], all in hex.

### 1.3 The algorithm

- **A cold start** takes `synced_ts` = now and walks the selected tables (user tables, hidden ones too) one
  at a time.
- **By-id pages.**
  - While `now − synced_ts < 30 s`, a page walks the current table by id at `synced_ts`: up to 16 384
    documents or 64 MiB.
  - Each value carries its revision's ts.
  - At the table's end, the next table starts.
- **Log pages.**
  - Otherwise, or once every table is synced, a page follows the document log after `synced_ts`.
  - It sends only rows already captured: those of synced tables, or of the current table at or before its
    position.
  - A commit is never split. A page stops at the first commit boundary past 32 768 rows read, 16 384
    values or 64 MiB.
  - At the log's end `synced_ts` becomes now.
- **Reconcile.** Tables that left the selection are forgotten: no truncate, the consumer keeps their data.
  New ones are started.
- **Truncates** name every table that entered the sync on this page.
- **Status.** `snapshotting` while a table is walked; otherwise `stale` (behind now) or `upToDate`.

### 1.4 Progress

- **The table.** `_data_sync_progress` (553; indexes `by_sync_id` and `by_last_updated`) holds
  `{syncId, lastUpdatedMs, state}`.
- **The state** is `Snapshotting` (with the counts of tables and documents, from the table summaries) or
  `Stale` / `UpToDate` (tables, documents, `syncedTs`).
- **When it is written.**
  - The first page inserts the row with the audit event `create_data_sync {sync_id}`. That write failing
    fails the page, which happens when the table counts are not ready.
  - Later pages update the row best effort, only when:
    - the kind changed;
    - an up-to-date sync's count changed;
    - or 5 s passed.
- **Active syncs** are those updated in the last 3 days.

## 2. What an app can observe

What a connector sees:
- every answer and error;
- pages and their limits;
- truncates and statuses;
- the sync id's `fivetran-` / `airbyte-` prefix from the `Convex-Client` header;
- progress.

## 3. How bunvex does it

- **`server/src/data-sync.ts`.** It holds the cursor codec and seal (Convex's bytes), the page algorithm,
  progress and the routes.
- **Reused from STUDY-60.** The selections and the export encoding.
- **Timestamps.** bunvex's timestamps are microseconds: the cursor and the answers carry them × 1000.
- **Tablets.** A bunvex tablet number goes in the cursor's 16-byte `tablet_id`, big-endian.
- **By-id pages** read the table at `synced_ts`. Each value's ts comes from `getVersions` (PERSIST-01 C16):
  one round trip per 1000 documents.
- **Log pages** read `readDocumentLog` (C12) whole commits at a time. The captured documents of a commit are
  read with one `getVersions` per table.
- **Position comparisons** use `by_id`'s order: the id strings. That is the same order as the internal ids'.
- **`Convex-Client`.** The header name is listed in `WIRE_NAMES` (rule 5's wire-name exception);
  `Bunvex-Client` works too.
- **Components.** bunvex has none, so `component` is always `""`.
- **Cost.** These routes do not touch the function path. Measured on the in-memory store: a 16 384-document
  by-id page takes about 70 ms, and a log page of 5 000 documents about 100 ms.

## 4. Divergences

None.

## 5. Tests

**`server/test/data-sync.test.ts`:**
- **The cursor.** It round-trips, the seal is hex, and a tampered cursor is refused.
- **A cold start.**
  - The truncates: `a`, then `b`, as `a` finishes on the same page.
  - By-id values carry revision timestamps in the export encoding.
  - The sync reaches `upToDate`.
  - Then the log: an insert, a patch and a tombstone, in order.
- **Selection.**
  - A table added later gets its truncate and its walk.
  - A table removed emits nothing.
  - A table selected again is walked again.
- **Limits.**
  - By-id pages of `pageSize`.
  - A log page when behind the freshness bound: the timestamp advances, and a commit is taken whole.
  - A walked document's later delete comes as a tombstone from the log.
  - Every document is seen exactly once, and the sync completes.
- **`Convex-Client`.** It sets the prefix; a malformed header is refused.
- **Progress.**
  - The row and its `create_data_sync` event.
  - `sync/{id}` and `list_active_syncs`, with their errors.
- **`data_sync_cursor_from_deltas`.** It continues from a snapshot's timestamp, with its errors.
- **Retention.** A cursor below the window is expired.

**Sabotage checks**, each failing a test: capture, truncates, freshness, whole commits, the expiry check,
the client prefix, reconcile, the protobuf reader.

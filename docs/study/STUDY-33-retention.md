# STUDY-33 — Retention: garbage collection of old versions

- **Status:** implemented (PERSIST-01 C12–C14 and the engine's `Retention`); R1–R4 accepted (owner, 2026-10-01)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend. The public repository dropped its
  tests in `ba16e0638`; the retention tests below are read from `ba16e0638^`.
- **Related:**
  - [STUDY-09](STUDY-09-persistence-layout.md) D5/D6 (DV-65, DV-66: match Convex, to be built);
  - [STUDY-06](STUDY-06-transactions-and-occ.md) D10 (the write log's retention, done);
  - [STUDY-24](STUDY-24-horizontal-scaling.md) §4.6 (retention runs on the leader, fenced);
  - [STUDY-29](STUDY-29-index-backfill.md) B2 (DV-127);
  - [specs/PERSIST-01](../../specs/PERSIST-01-contract.md) (history kept "until retention");
  - [platform §16](../parity/platform.md#16-retention--gc).

Paths are relative to `crates/` unless stated.

## 1. How Convex does it

### 1.1 Two windows

Convex keeps two lower bounds on what persistence can still answer (`database/src/retention.rs`):

- **The index window,** `min_snapshot_ts`. Every snapshot at or after it reads index rows intact. Index rows
  older than it may be deleted. The window is `INDEX_RETENTION_DELAY` = **240 s** behind
  `max_repeatable_ts`.
- **The document window,** `document_min_snapshot_ts`. The document log (every revision, Convex's WAL) is
  intact from here. The window is `DOCUMENT_RETENTION_DELAY` = **14 days** (`common/src/knobs.rs:709`),
  and the self-hosted docker-compose sets 2 days.

The invariant is `min_document ≤ min_index ≤ max_repeatable_ts` (retention.rs:180-189, 263-266).

Both bounds advance every 30 s, with jitter (`go_advance_min_snapshot`, `ADVANCE_RETENTION_TS_FREQUENCY`,
retention.rs:599-627, 1602):

- The candidate is `max_repeatable_ts − delay`, and a bound only moves forward.
- The document candidate is also capped at the index deleter's confirmed cursor. Index retention derives
  its work from the document log (§1.2), so the document deleter must not get ahead of it.
- A new bound is written to a persistence global **before** it is used in memory (retention.rs:658-661).
  Persistence is therefore always ≥ memory, so a follower or a restart never reads below what was deleted.
- The globals are `min_snapshot_ts`, `document_min_snapshot_ts`, `confirmed_deleted_ts` and
  `document_confirmed_deleted_ts` (`common/src/persistence/mod.rs:210-266`).

Retention runs **only on the leader** (`LeaderRetentionManager`, database.rs:1071, 1096):

- Followers re-read the globals on every check (`FollowerRetentionManager`, retention.rs:1658-1777).
- On Postgres, every delete and every global write runs in `lease.transact`, which checks the lease before
  commit (postgres/src/lib.rs:1822-1890).
- Losing the lease shuts retention down (retention.rs:668-677).

### 1.2 Index retention

`go_delete_indexes` (retention.rs:1090-1215) waits until `cursor + 1 < min_snapshot_ts`, deletes, and then
checkpoints. Since `ba16e0638`, the work goes through `Persistence::reclaim_index_history`. The row
algorithm is in `common/src/persistence/row_index_retention.rs`.

**Which entries expire.** The algorithm walks the document log, not the index rows
(`expired_index_entries`, :164-258). For each revision at `ts` in `(cursor, min_snapshot_ts)` that has a
previous revision `prev`, and for each index on its table:

- the entry `(key(prev), prev_ts)` expires;
- the tombstone `(key(prev), ts)` expires too, when the new revision is a delete or the index key changed.

A create has no `prev` and frees nothing.

**How it deletes.** Every delete is `ts <= X` for one `(index_id, key)`, so one delete also removes
everything older:

- **sqlite:** `DELETE FROM indexes WHERE index_id = ? AND ts <= ? AND key = ?`;
- **postgres:** batches of 8 OR'd clauses, keyed by `key_prefix` and `key_sha256`;
- **mysql:** deduplicated to the highest ts per key first.

**Chunks and progress.**

- Chunks hold 512 entries (`INDEX_RETENTION_DELETE_CHUNK`).
- A chunk is split into 4 parallel parts (`INDEX_RETENTION_DELETE_PARALLEL`), and entries for the same key
  stay in one part.
- A pass stops after 10 000 entries (`RETENTION_DELETE_BATCH`).
- The cursor is checkpointed to `confirmed_deleted_ts` at most every 300 s
  (`RETENTION_CHECKPOINT_PERIOD_SECS`) and reloaded on start.
- Errors back off from 50 ms up to 60 s.

**Dropped and backfilling indexes.**

- Dropped indexes are still processed: the index set only grows.
- Backfilling indexes are skipped, then caught up after the backfill (`delete_all_no_checkpoint`,
  index_writer.rs:706-721). Convex's backfill writes entries at each document's own ts, below the cursor.

### 1.3 Document retention

`expired_documents` (retention.rs:850-903) walks the log over `(cursor, min_document_ts)`. For each entry
`(id, ts, value, prev_ts)`:

| Entry | Deletes |
|---|---|
| has `prev_ts` | `(prev_ts, id)` |
| has `prev_ts` and is a tombstone | also `(ts, id)` |
| no `prev_ts`, a tombstone (created and deleted in one transaction) | `(ts, id)` |
| no `prev_ts`, live | nothing |

**What remains:**

- the newest revision at or below the window is kept;
- tombstones below the window disappear, together with everything under them.

**How it deletes** (`delete_documents`, retention.rs:913-1021):

- Chunks hold 256 entries, in one partition.
- A shared rate limit of 256 documents per second applies (`DOCUMENT_RETENTION_RATE_LIMIT`).
- A pass stops after 10 000 scanned.
- It runs every 60 s (`DOCUMENT_RETENTION_BATCH_INTERVAL_SECONDS`).
- If the cursor would move backward, that is an error.

Tables being deleted are wiped once their delete falls below the window (`delete_tablet_documents`,
chunks of 256).

### 1.4 Reads below the window

**The error.** A read at a snapshot below the window fails with `OutOfRetention`
(`snapshot_invalid_error`, retention.rs:1779-1789):

- the message is "Your request couldn't be completed. Try again later." (short `InternalServerError`);
- the context reads `Index snapshot timestamp out of leader retention window: {ts} < {min}`;
- it is not a user error and not deterministic.

**When it is checked.**

- The check runs **after** the read, so a delete racing the read is caught: `validate_snapshot` after index
  scans, `validate_document_snapshot` after log reads.
- An optimistic check also runs before the read.

**The in-memory snapshot window.** `SnapshotManager` separately keeps 10 s of snapshots
(`MAX_TRANSACTION_WINDOW_SECONDS`), with "Timestamp {ts} is too early, retry with a higher timestamp".

**Where the error is turned into something else.**

- The sync worker retries `update_queries`.
- Fivetran's `document_deltas` and `/data/sync` turn it into "cursor expired, do a full sync" errors.

### 1.5 Around it

Retention removes versions; deleting rows is the job of each table's own cleanup:

- Scheduled jobs are deleted after 7 days.
- `_session_requests` cleanup runs at 256 rows/s, "the maximum rate that retention can process
  tombstones, which is about 300" (knobs.rs).

The in-memory write log has its own retention (STUDY-06 D10, done in bunvex). All the knobs above are
env-overridable under the same names (`env_config`).

## 2. What an app can observe

Results never change: retention removes only versions no snapshot at or above the window can see. What
an app can observe:

1. **A transaction that reads more than 4 minutes after its snapshot** fails with `OutOfRetention`, an
   internal error that is not retried as OCC (HTTP 503, WebSocket close 1013). In Convex, a query or
   mutation is also stopped by its 1 s user-time limit long before that.
2. **Storage stops growing** with rewrites and deletes, and scans over churned ranges stay fast.
   Tombstones no longer pile up under the live rows.
3. **History consumers bounded by the document window.** Streaming export and log streaming would be
   such consumers; bunvex has none yet.

## 3. How bunvex does it

### 3.1 What exists

**What is stored** (STUDY-09; PERSIST-01):

- Every driver appends every document version and every index row, tombstones included.
- Nothing is ever deleted.
- Every document version rewrites all of its index rows, even when a key did not move. A key that moved
  gets a tombstone (`tx.ts`).
- `indexes` has a ts index on every driver (C11, `readLog`). `documents` has no ts index and no
  `prev_ts`.

**What reads old snapshots:**

- every transaction reads at its fixed `snapshot`, for as long as it runs;
- `query_at_ts`, bounded by the 10 s begin window;
- sync transitions at `visibleTs`;
- backfill chunks.

Nothing reads below the latest commit except these. `readLog` has no consumer outside the conformance
suite; STUDY-24's followers will read only its recent tail.

**One writer per store:**

- memory and SQLite take a process lock;
- Postgres, MySQL and MongoDB hold a TTL lease with an epoch that fences every flush.
- `IndexWorker` already starts only in the lease holder.

### 3.2 The design

**The retention manager.** A `Retention` in `@bunvex/core` (`retention.ts`) is owned by the engine,
started in the lease holder like `IndexWorker`, and stopped on `close()` and when the lease is lost.

**The windows:**

- `minIndexTs = visibleTs − INDEX_RETENTION_DELAY` and `minDocumentTs = visibleTs − DOCUMENT_RETENTION_DELAY`
  (timestamps are wall-clock µs, STUDY-06 D9).
- They advance every 30 s with jitter, only forward, with `minDocumentTs ≤ minIndexTs`.
- `visibleTs` stands in for Convex's `max_repeatable_ts`. A snapshot is always `visibleTs` when it
  begins, so a read can only fall below the window when its transaction runs longer than the delay, as
  in Convex.
- Each new bound is written to a persistence global first, then used.

**Index retention** reads the ts-ordered index log in `(cursor, minIndexTs]`, which every driver already
has (R1). For each row `(index, key, ts)`:

- a live row deletes `(index, key)` rows with ts `≤ ts − 1`, because it supersedes them;
- a tombstone deletes `(index, key)` rows with ts `≤ ts`, itself included.

This removes the same rows as Convex's walk over revision pairs. No document needs to be decoded, and no
index definition needs to be known, so dropped indexes and backfill commits (DV-127, normal commits at
their own ts) are covered by the same scan.

**Document retention** does the same over a new ts index on `documents`, in `(cursor, minDocumentTs]`
(R2):

- a live version deletes the older versions of its `(table, id)`;
- a tombstone deletes itself and everything older.

**Deletes** are `ts ≤ X` per key, as Convex's:

- Postgres and MySQL batch them as OR'd clauses;
- every driver runs them fenced by the lease epoch, as flushes are;
- the memory driver prunes its version lists (R3).

**Knobs.** They take Convex's defaults and names:

- `INDEX_RETENTION_DELAY` (240 s) and `DOCUMENT_RETENTION_DELAY` (R4), read from the environment in
  seconds, with an engine option `retention` for tests;
- chunks of 512 (index) and 256 (document);
- 10 000 per pass;
- 256 documents/s;
- checkpoints at most every 300 s;
- error backoff from 50 ms to 60 s.

**Read validation.** Every persistence read in a transaction (`get`, `scan`, `scanDocs`) checks
`snapshot ≥ minIndexTs` before and after it. Below the window it throws `OutOfRetentionError` with
Convex's context text. That error already maps to 503 and to close 1013, and it is not retried as OCC.

**Restart.** The cursors (`confirmed_deleted_ts`, `document_confirmed_deleted_ts`) and the bounds are
reloaded from the globals.

### 3.3 Persistence interface (PERSIST-01)

New optional capabilities, each with conformance cases:

- **Globals:** `getGlobal(key)` and `setGlobal(key, json)`. SQL drivers use their `persistence_globals`
  table, MongoDB its `meta` collection, and memory a map.
- **`readDocumentLog(afterTs, upToTs, limit)`:** `(table, id, ts, deleted)` in ts order, backed by a new
  `documents` ts index.
- **`deleteIndexRows(entries)` and `deleteDocumentRows(entries)`:** each entry is `{…key, ts}` and deletes
  rows at or below `ts`. They are fenced and return the number of rows deleted.
- **No new layout.** The `documents` ts index is created with the tables, and an existing store gets it
  when the lease is acquired (MongoDB at open), as C11's `indexes` ts index. An added index is idempotent
  DDL, not a layout change (PERSIST-01 C10), so `LAYOUT_VERSION` stays 1 and existing stores keep opening.
  This replaces the layout bump the first draft proposed.

Conformance:

- **K26:** after random writes, deleting what retention computes for a window leaves every snapshot at or
  above the window answering exactly as before, and leaves fewer rows (`auditRowsAt`).
- **K27:** deletes and global writes from a holder that lost the lease are refused.
- **K28:** the document log in ts order, with exact limits.

### 3.4 PRs

1. PERSIST-01, on every driver and in the conformance suite:
   - the `documents` ts index (no layout change);
   - `readDocumentLog`;
   - fenced `deleteIndexRows` / `deleteDocumentRows`;
   - globals;
   - K26–K28.
2. The engine's `Retention`:
   - the windows, both deleters and the checkpoints;
   - read validation and the knobs;
   - tests, sabotage checks and a measurement (scan latency over a churned range, and retention
     throughput).
3. Parity rows (platform "Retention", STUDY-09 D5/D6, PERSIST-01's "out of scope" line).

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| R1 | Index retention reads the index log (rows by ts) and deletes, per key, what a newer row in the window supersedes. Convex derives the same entries from the document log's revision pairs, recomputing each index key | Same rows deleted, so not observable. The ts index on `indexes` already exists on every driver (C11), and no document is decoded and no index definition needed. Convex's way would need `prev_ts` (DV-66), a per-document write, before index retention could start | **accepted** (owner, 2026-10-01) |
| R2 | Document retention reads `documents` by ts and, per id, deletes what a newer version in the window supersedes, without a `prev_ts` column. It needs a new ts index (created as C11's, with no layout change) | Same rows deleted. `prev_ts` (DV-66) stays for export and log streaming, which need it, and it would need every write to know its previous version's ts | **accepted** (owner, 2026-10-01) |
| R3 | The memory driver prunes old versions in RAM, but its durable log file is not compacted. On reopen the old versions come back until retention runs again | The log is an append-only replay file for development and tests. Compaction would mean rewriting it under the lock. Convex has no such driver | **accepted** (owner, 2026-10-01) |
| R4 | `DOCUMENT_RETENTION_DELAY` defaults to Convex's knob, **14 days**. Convex's self-hosted docker-compose sets 2 days | follow Convex's binary default; settable by the env variable | **accepted** (owner, 2026-10-01) |

## 5. Tests

**Unit tests.** These are Convex's old retention tests rebuilt over bunvex's rows:

- **Index entries** (min = 8):
  - overwritten rows are deleted;
  - a tombstone left by a key change is deleted;
  - a document deleted below the window loses every row;
  - rows above the window stay;
  - a scan at the window returns the same rows.
- **Documents** (min = 4):
  - the previous revision and its tombstone go;
  - a document created and deleted in one transaction goes;
  - the newest revision below the window stays;
  - a live document with no history stays.
- **One document with 10 revisions** (min = 11): the revision at ts 10 stays because it is visible at 11.

**Read validation:**

- a transaction whose snapshot falls below the window while it runs fails with `OutOfRetention` on its
  next read;
- HTTP gives 503 and sync closes with 1013;
- a read that raced a delete fails the after-read check.

**The windows:**

- they only move forward;
- they are persisted before they are used;
- they are reloaded on restart;
- `minDocumentTs ≤ minIndexTs` always holds;
- a process without the lease does not run retention.

**Conformance:** K26–K28 on memory, SQLite, Postgres, MySQL and MongoDB.

**Property test:** random churn while retention runs. Every query at a snapshot inside the window
answers exactly as it would with retention off.

**Measurement:**

- a hot range rewritten 100 000 times, scanned with and without retention;
- index and document rows deleted per second on SQLite and Postgres.

## 6. Open questions

- **Purging deleted tables** comes with table deletion, which bunvex does not have.
- **Scheduled job retention** (7 days) and session cleanup's rate are STUDY-30's and STUDY-09's. With
  retention in place, their tombstones are finally removed too.
- **Followers** (STUDY-24) will check the persisted bounds as Convex's `FollowerRetentionManager` does.
  That comes with followers.

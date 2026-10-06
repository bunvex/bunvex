# STUDY-29 — Background index backfill

- **Status:** implemented (#115); B1 and B2 (§4) decided (owner, 2026-10-01: approved as recommended); B2 reversed and built as Convex's with STUDY-133 PR 3 (DV-127)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:** [STUDY-04](STUDY-04-table-and-index-metadata.md) D3/D4 (DV-54, DV-55),
  [STUDY-24](STUDY-24-horizontal-scaling.md) S5 and §4.6 (singletons), [PERSIST-01](../specs/PERSIST-01-contract.md),
  [STUDY-06](STUDY-06-transactions-and-occ.md) (OCC)

The owner decided DV-54 / STUDY-24 S5 on 2026-10-01: "match Convex (to be built)". This study reads how
Convex builds a new index and records what bunvex now does.

## 1. How Convex does it

### 1.1 Index states

- `DatabaseIndexState` (`crates/common/src/bootstrap_model/index/database_index/index_state.rs:19-28`):
  - `Backfilling(DatabaseIndexBackfillState)`: "All new writes should update the index".
  - `Backfilled { staged }`: complete, but "not yet available for reads".
  - `Enabled`: serves reads.
- An index of a newly created table starts `Enabled`; every other index starts `Backfilling`
  (`index_state.rs:14-18`).
- `DatabaseIndexBackfillState` (`backfill_state.rs:10-20`) holds `index_created_lower_bound`,
  `retention_started` and `staged`. Its comment: "Progress checkpoints are stored in `_index_backfills`".
- The `IndexRegistry` keeps two maps, `enabled_indexes` and `pending_indexes`
  (`crates/indexing/src/index_registry.rs:609-690`). A changed index has an enabled AND a pending version
  under the same name until the push finishes.
- Every write updates every index of its table, enabled or pending: `index_registry.index_updates` covers
  both (`index_writer.rs:567-571` uses the same function for the backfill).

### 1.2 Queries on an index that is not enabled

- `IndexRegistry::require_enabled` (`index_registry.rs:725-744`):
  - enabled: it is used;
  - pending and staged: `IndexStagedError`, "Index {name} is currently staged and not available to query
    until it is enabled." (`:863-868`);
  - pending: `IndexBackfillingError`, "Index {name} is currently backfilling and not available to query
    yet." (`:856-861`);
  - neither: `IndexNotFoundError`. All three are `bad_request` errors: no wait, no retry.
- On success, `TransactionIndex::require_enabled` records a read of the index's `_index` document
  (`crates/database/src/transaction_index.rs:620-652`). A cached query or a subscription that used an index
  is invalidated when that index is replaced or dropped. A name miss records a read of all of `_index`.

### 1.3 The schema push

- `start_push` → `prepare_new_and_mutated_indexes` (`crates/database/src/bootstrap_model/index.rs:657-698`):
  - adds new and changed indexes, `Backfilling`;
  - drops PENDING indexes the schema no longer has, at once;
  - patches the `staged` flag of existing ones.
  - Enabled indexes are not touched: the old version of a changed index keeps serving.
- The CLI then calls `/api/deploy2/wait_for_schema` in a loop (`npm-packages/convex/src/cli/lib/deploy2.ts:224-300`):
  - The server (`crates/application/src/deploy_config.rs:708-815`) answers `InProgress` with
    `indexesComplete / indexesTotal` until no non-staged index is `Backfilling`.
  - Staged indexes are not counted: "Staged indexes do not block push completion"
    (`npm-packages/convex/src/server/schema.ts:175-184`).
  - The CLI shows "Backfilling indexes (n/m ready)...".
- `finish_push` → `commit_indexes_for_schema` (`bootstrap_model/index.rs:307-349`), in one transaction with
  the new code:
  - drops enabled indexes that were replaced or removed;
  - enables `Backfilled` ones (`enable_index` refuses anything not `Backfilled`, `:169-199`);
  - disables enabled ones now declared staged (`Enabled` → `Backfilled { staged: true }`, `:362-380`).
  - The index diff behind it is `get_index_diff` (`:513-560`).
- So **deployed code never sees an index that is not enabled**: the push completes only after the backfill,
  and the old code serves meanwhile. A staged index is the only way an app meets `IndexStagedError`.

### 1.4 The worker

- `IndexWorker` (`crates/database/src/database_index_workers/mod.rs:94-338`) is spawned once by
  `Application::new` (`crates/application/src/lib.rs:758-771`), unless `INDEX_BACKFILL_ENABLE=false`. It
  runs in the one backend process, which holds the persistence lease.
- Its loop reads every `_index` document, queues the `Backfilling` ones with their `_index_backfills` cursor,
  and runs up to `INDEX_BACKFILL_CONCURRENCY` (8) tables at once. It then waits for an invalidation of
  `_index`, a finished table or a progress update (`:191-338`).
- Failures back off from `INDEX_WORKERS_INITIAL_BACKOFF` (500 ms) to `INDEX_WORKERS_MAX_BACKOFF` (30 s)
  and the loop restarts (`:165-184`).
- The indexes of one table that have the same cursor are filled in one pass (`queue_index_backfill`,
  `:342-378`).
- `backfill_tablet` (`:384-491`):
  1. Fresh start: one transaction writes an `_index_backfills` document per index
     (`{ indexId, numDocsIndexed: 0, totalDocs, cursor: { snapshotTs, cursor: null } }`,
     `bootstrap_model/index_backfills/mod.rs:95-145`). Its begin timestamp is the snapshot.
  2. Resume: it continues from the stored cursor AT THE STORED SNAPSHOT (`:412-426`). That snapshot must
     still be inside retention.
  3. `IndexWriter::backfill_from_ts` walks the table's `by_id` at the snapshot in pages of
     `INDEX_BACKFILL_READ_SIZE` (500) (`index_writer.rs:338-406`). It writes each document's entries at the
     DOCUMENT'S OWN TIMESTAMP (`PersistenceIndexEntry::from_index_update(revision_pair.ts(), …)`,
     `:567-576`), directly to persistence (`write_index_backfill`, `crates/common/src/persistence/mod.rs:343-347`),
     not through a commit.
  4. Live writes after the index was created write their own entries at their commit timestamps. Every
     backfilled entry is older than any of them, so the two never fight: "as long as new index entries are
     written for document revisions after `snapshot`, then you are allowed to read `index_name` at any
     snapshot after `snapshot`" (`:329-337`).
  5. Chunks hold `INDEX_BACKFILL_CHUNK_SIZE` (1024) entries, split across the indexes of the pass (`:545-547`).
     Up to `INDEX_BACKFILL_WORKERS` (4) chunks are written at once (`:610`).
  6. Rate limit: `INDEX_BACKFILL_CHUNK_RATE` (16) chunks a second, so 16 384 entries/s with the defaults
     (`:219-233`, `:585-599`); `IndexRateLimit::Unlimited` exists for migrations.
  7. Progress (cursor and documents indexed) is reported every `INDEX_BACKFILL_PROGRESS_INTERVAL` (1 s)
     and committed to `_index_backfills` by the worker loop (`:631-652`, `mod.rs:257-329`).
  8. Persistence v6 then reconciles deletions it recorded during the scan (`reconcile_index_backfill`), and
     index retention runs from `index_created_lower_bound` (`mark_retention_started`, `run_retention`,
     `mod.rs:468-530`). Both clean up after writing at old timestamps; bunvex has no retention (DV-65).
  9. `finish_backfill` (`mod.rs:638-695`) moves the index to `Backfilled { staged }`. A system index, or an
     index of a system table, goes straight to `Enabled`: no push enables those.
- Knobs: `crates/common/src/knobs.rs:726-750`, `:1609-1614`, `:2004-2005`.

## 2. What an app can observe

1. Adding an index never blocks the deployment's reads and writes: they go on during the backfill.
2. A push that adds an index completes once the index is ready. Code using it goes live with it.
3. A changed index keeps answering with its old definition until the new one is enabled, then switches
   atomically.
4. A query on a backfilling index fails at once with `IndexBackfillingError`; on a staged one, with
   `IndexStagedError`. Apps only meet the second, through staged indexes.
5. Once enabled, the index holds exactly the live documents. No write made during the backfill is lost or
   duplicated.
6. A crash or restart during the backfill resumes it. Nothing is redone from scratch.
7. Cached query results and subscriptions that read a replaced index re-run.

## 3. How bunvex does it

`packages/core/src/catalog.ts`, `index-worker.ts`, `engine.ts`, `tx.ts`.

- **States** as Convex's: `_index.state` is `backfilling | backfilled | enabled`, with `staged`.
  `defineTable(...).index(name, { fields, staged: true })` declares a staged index, as Convex's API.
- **Catalog** = Convex's registry. A `TableDef` has `indexes` (enabled, by name: what queries use) and
  `pending` (backfilling or backfilled). `Tx` maintains both on every write and reads only enabled ones
  (`resolveIndex`):
  - Convex's two errors, with its messages and a `code`;
  - a read of the index's `_index` document, as Convex records (§1.2).
- **The push is the engine's open.** bunvex declares its schema in code, so `Engine.init()` plays
  `start_push` (`planCatalog`: new and changed indexes `backfilling`, stale pending ones dropped, `staged`
  flags patched). It then returns WITHOUT waiting. The worker plays the CLI's wait.
  - `finishSchema()` (`finishCatalog`) is `finish_push`: enable backfilled, disable newly staged, drop
    replaced or removed, in one commit.
  - It runs at once when nothing non-staged is backfilling, otherwise when the worker has filled the last
    such table.
  - `engine.indexesReady()` resolves after it, as `wait_for_schema` returning `Complete`. It rejects if
    the engine closes or stops first.
- **Catalog changes are snapshots.** A commit that enables, disables or drops indexes installs a NEW
  catalog object from the commit's `onVisible` hook, before any commit listener runs. Running
  transactions keep the catalog they began with, as Convex's registry belongs to a snapshot.
  - An index enabled at ts E has `readyTs = E`. A transaction at an older snapshot (a sync transition at
    an earlier ts) gets `IndexBackfillingError` instead of reading it.
  - The query cache is cleared on such a change.
- **The worker** (`IndexWorker`) is started by `init()` when an index is backfilling, so only in the process
  that holds the store's lease (STUDY-24 §4.6: a leader singleton). It follows Convex's loop:
  - groups the backfilling indexes by table, up to 8 tables at once;
  - checkpoints in `_index_backfills` (`{ indexId, numDocsIndexed, totalDocs: null, cursor }`, with
    `by_index_id`), at most once a second;
  - marks the index `backfilled`, or `enabled` for a system table's index;
  - backs off 500 ms → 30 s after a failure;
  - takes Convex's knobs as `Engine` options (`indexBackfill: { chunkSize, chunkRate, readSize,
    progressIntervalMs, concurrency }`, `chunkRate: null` = unlimited).
- **How a chunk stays correct** (the one mechanical difference, B2): bunvex cannot write below its latest
  timestamp.
  - PERSIST-01 calls `apply(ts, …)` "once per commit, in increasing `ts` order"
    (`docs/specs/PERSIST-01-contract.md`, C4), and the memory driver relies on it (it appends versions).
  - bunvex reads no per-document ts either (DV-66).
  - So a chunk is an ordinary COMMIT at a new ts. Its read-set is the `by_id` range it scanned at its
    snapshot. Any write in that range after the snapshot (an update, a delete, an insert) makes it
    conflict, and it is read again at a newer snapshot, at half the size (it grows back after a success).
  - A document the chunk saw unchanged gets its entry at the chunk's ts. A document written later already
    has its entries from that write, which maintains the index.
  - The chunk's writes stay out of the in-memory write log (`logWrites: false`): no transaction can read
    a pending index, so validation, cache invalidation and subscriptions need not scan them.
- **Resume after a crash:** from the least advanced checkpoint, at a NEW snapshot. Each committed chunk was
  exact at its own ts and live writes have maintained it since, so the old snapshot is not needed (Convex
  needs it because it writes at old timestamps).
- **Dropped while backfilling:** the next open drops the pending index and its checkpoint. The worker
  skips an index that is gone.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| B1 | **No push gate.** The new code is live as soon as `init()` returns. Until a new index is enabled, a query on it fails with `IndexBackfillingError`; a changed index answers with its OLD definition. Convex's push only completes, and deploys the code, once the index is ready, so deployed code never meets either. To let such a query's subscription re-run when the index is enabled, the failed lookup also records a read of the index's `_index` document (Convex records it only on success). | bunvex has no push: the schema is code, loaded at open. Waiting in `init()` is what DV-54 removed (and what blocked failover, S5). A server can gate on `engine.indexesReady()` before taking traffic, or not. **Recommendation:** keep, and have the future `bunvex deploy` (or the server's start) wait on `indexesReady()` as Convex's CLI does, with an opt-out. | **Decided (owner, 2026-10-01): keep**; revisit with `bunvex deploy` ("when bunvex deploy exists we adjust what's needed") (DV-126) |
| B2 | **A chunk is a commit at a new ts, validated by OCC**, not entries written directly at each document's own ts. The resume starts at a new snapshot, not the checkpoint's. The checkpoint is deleted when its index finishes. | PERSIST-01 has no write below the latest ts and bunvex has no per-document ts (DV-66). Not observable: the index's content is the same, and no transaction can read it before it is enabled. Costs a ts and a durable write per chunk. A chunk under heavy writes to its range is redone at half size (measured in §7). **Recommendation:** keep until PERSIST-01 gains a by-ts read (DV-66); revisit then. | **Decided (owner, 2026-10-01): keep** until `prev_ts` (DV-66) exists (DV-127); **reversed** (owner, 2026-10-05, DV-419) and built with STUDY-133 PR 3: entries at each document's own ts through `writeIndexEntries`, a resume at the stored snapshot |

Matched (no divergence): states, staged indexes and their errors, the errors' messages, the old version
serving until the swap, the `_index` read on lookups, `_index_backfills` checkpoints and resume, the knobs
and their defaults, the per-table grouping, concurrency, backoff, and system indexes enabled by the worker.

Not applicable: Convex's retention phase (`retention_started`, `run_retention`) and v6 reconciliation, which
clean up after writing at old timestamps. bunvex does neither, and keeps every version (DV-65).

## 5. Tests

- `packages/core/test/index-backfill.test.ts`:
  - `init()` returns before the backfill ends on a 3 000-document table (rate-limited to about 3 s), and
    is timed. Queries and mutations on the index get Convex's error; other reads and writes go on.
  - 16 concurrent writers (inserts, moves, deletes) during a backfill. Range scans are delayed so writes
    land inside chunks: about half the chunks are refused and redone. At three snapshots (enable, end of
    writes, after more writes), every live document has exactly one entry at its key, and there are no
    other entries.
  - A child process is SIGKILLed after its first checkpoint. The reopened store resumes from the
    checkpoint (it indexes fewer than all documents itself), finishes, audits clean, and drops the
    checkpoint.
  - A changed index serves its old definition until the swap, then the new one. A subscription's reads
    of the old one are invalidated by the swap.
  - A staged index is backfilled, never enabled, and never holds readiness up. Un-staging enables it
    without a new backfill; staging it again disables it.
  - A new table's index needs no worker. A snapshot older than the enabling commit cannot read the index.
- `packages/core/test/catalog.test.ts`: the existing STUDY-04 tests, waiting on `indexesReady()`.
- **K24** (`@bunvex/persistence-conformance`, every driver): 3 000 documents, a new index, 8 writers during
  the backfill. Each driver's range scans are delayed so writes land inside chunks. At two snapshots, the
  index equals the live documents in key order. It passes on memory, SQLite and Postgres (all of K1–K24 on
  Postgres 17); MySQL and MongoDB run in CI.
- **Sabotage** (each made the named test fail):
  - chunk commits without the read-set: the concurrent-writers test (4 481 entries for 4 391 live
    documents) and K24 (3 119 for 3 100 on memory, 3 072 for 3 048 on SQLite);
  - writes not maintaining pending indexes: the concurrent-writers test (6 643 documents without their
    entry);
  - enabling before the backfill is done: five of the seven tests;
  - no `readyTs` check: the older-snapshot test;
  - no `_index` read: the changed-index test;
  - resume ignoring the checkpoint: the crash test (6 000 indexed again).

## 6. Open questions

- B1 and B2 (above).
- Convex's dashboard shows backfill progress from `_index_backfills`. bunvex records it, but the server's
  admin API does not exist yet, so the dashboard still uses its mock.

## 7. Measurements

`bench/backfill.ts` on an M-series Mac, Bun 1.4.2. The store holds N documents (`{ n, pad: 40 bytes }`),
and is opened with a new index on `n`. Each run uses a fresh copy of the store.

- **before** is `origin/main` (synchronous backfill in `init()`).
- **after** uses Convex's default rate (16 384 entries/s); **unlimited** sets `chunkRate: null`.
- **open** is the store's open (the memory driver replays its log); **init** is `Engine.init()`; **ready**
  is the time from open until the index serves queries.
- **commits/s** come from 16 writers inserting into another table. "during" is measured while the backfill
  runs (2 s, or until it ends); "idle" afterwards.

| Store | N | Run | open | init | ready | commits/s during | commits/s idle |
|---|---|---|---|---|---|---|---|
| memory | 100k | before | 282 ms | 441 ms | 441 ms | (blocked) | 60 290 |
| memory | 100k | after | 270 ms | **9 ms** | 5.2 s | 50 448 | 55 553 |
| memory | 100k | unlimited | 276 ms | 11 ms | 0.47 s | 3 575 | 55 475 |
| memory | 1M | before | 4.2 s | 5.8 s | 5.8 s | (blocked) | 52 536 |
| memory | 1M | after | 3.9 s | **7 ms** | 60.1 s | 48 506 | 52 026 |
| memory | 1M | unlimited | 3.8 s | 7 ms | 5.9 s | 2 840 | 52 016 |
| SQLite | 100k | before | 3 ms | 1.92 s | 1.92 s | (blocked) | 16 448 |
| SQLite | 100k | after | 3 ms | **248 ms** | 5.4 s | 10 763 | 12 496 |
| SQLite | 100k | unlimited | 3 ms | 247 ms | 1.92 s | 983 | 15 200 |
| SQLite | 1M | before | 3 ms | 42.7 s | 42.7 s | (blocked) | 11 880 |
| SQLite | 1M | after | 3 ms | **3.4 s** | 63.5 s | 9 342 | 9 944 |
| SQLite | 1M | unlimited | 4 ms | 3.6 s | 43.1 s | 869 | 11 376 |
| Postgres 17 (local) | 100k | before | 16 ms | 13.2 s | 13.2 s | (blocked) | 20 952 |
| Postgres 17 (local) | 100k | after | 16 ms | **11 ms** | 5.8 s | 15 863 | 16 280 |
| Postgres 17 (local) | 100k | unlimited | 19 ms | 12 ms | 6.3 s | 9 917 | 16 856 |

- **`init()` no longer depends on the index.**
  - What is left on SQLite (248 ms at 100k, 3.4 s at 1M) is `maxTs()`, a full scan that was in "before"
    too: 236 ms of the 248 ms, profiled.
  - Postgres opens in 11 ms instead of 13 s.
- **Time to ready is Convex's rate limit** at the default: 16 384 entries/s, so about 6 s per 100k
  documents per index.
  - Unlimited, it matches the old synchronous backfill (memory 5.9 s vs 5.8 s at 1M; SQLite 43.1 s vs
    42.7 s), and is faster on Postgres (6.3 s vs 13.2 s: one commit per 1024 entries instead of 1000 reads
    then a commit).
- **Writes during a default-rate backfill** keep 89–97% of idle throughput (memory 48.5k vs 52.0k at 1M;
  SQLite 9.3k vs 9.9k; Postgres 15.9k vs 16.3k).
  - Unlimited, the backfill takes most of each group commit and writes drop to 5–60%. That is why Convex
    rate-limits by default.
  - The idle column varies by ±20% between runs of the same build on Postgres (18.1k / 18.0k after vs
    19.5k / 14.9k before, repeated). Idle commits are unchanged within that noise.
- **Indexed queries:** every `withIndex` on a user index now records a read of its `_index` document, as
  Convex does. The interval is built once per index. An indexed `first()` runs at 442–462k/s vs 430–439k/s
  before (memory, 5 runs each). Without that caching it cost 25%.

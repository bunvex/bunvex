# STUDY-06 — Transactions, OCC and the committer

- **Status:** decided — D1, D2 fixed (#9); D4–D7, D9 resolved to match Convex (DV-30, DV-31, DV-38, DV-39); D10 resolved to match Convex in #118 (DV-60), with a 256 MiB write-log cap by default (DV-128, decided); D11 resolved to match Convex in #120 (DV-61); D3 resolved to match Convex in #PR (DV-57, §9); D8, D12 to match Convex, gaps tracked in docs/parity (DV-59, DV-62). Retroactive: the code in §3 was written before the study-first rule.
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **bunvex code read:** `main` at `f60e934`; for D10 (§1.6, §7), `main` at `9c9bd14` (2026-10-01); for D11
  (§1.7, §8), `feat/occ-time-window` at `da84195` (#118); for D3 (§1.1, §9), `main` at `6fcb525` (2026-10-01)
- **Related:**
  - [STUDY-02](STUDY-02-read-own-writes.md) and [STUDY-03](STUDY-03-deterministic-execution.md): not
    repeated here.
  - [STUDY-08](STUDY-08-cache-and-subscriptions.md): the write log also drives invalidation.
  - [ENGINE-00](../specs/ENGINE-00-requirements.md) C3–C5.

## 1. How Convex does it

### 1.1 Read-set

`crates/database/src/reads.rs` (`TransactionReadSet`, `ReadSet`):

- The read-set is a set of **intervals per index**, together with the index's fields.
- `db.get` records the point interval of the id on `by_id`.
- An index range records only **the part actually scanned**. In
  `crates/database/src/query/index_range.rs` (`IndexRange::start_next`, l. 163):
  - `initial_unfetched_interval` is the queried interval cut to the start and end cursors (l. 111–131).
  - Each row the range **returns** (l. 192–227) moves the cursor to `After(key)` and records
    `initial_unfetched_interval.split(cursor, order).0` with `record_indexed_directly`
    (`crates/database/src/reads.rs` l. 447): the part from the start of the range, in scan order, up to that
    key. Rows fetched ahead in a prefetched page but not yet returned are not recorded.
  - When the range runs out (`unfetched_interval` empty, or the cursor at `End`; l. 246–261), it records the
    whole `initial_unfetched_interval`.
  - `Interval::split_after` (`crates/common/src/interval/mod.rs` l. 128–157) is where the edges are:
    ascending, the read part is `[start, increment(key))`, where `BinaryKey::increment`
    (`crates/common/src/interval/key.rs` l. 68–80) is the smallest key above every key that starts with
    `key`, so the last key is included; if there is no such key, or it is not below the interval's end, the
    whole interval. Descending, the read part is `[key, end)`: it starts at the last key, inclusive.
  - Successive records for one index are unioned into its `IntervalSet` (`_record_indexed`, `reads.rs`
    l. 280), so a scan that returns k rows leaves one interval, not k.
- A scan stops early only because the operator above it stops pulling: `Limit::next`
  (`crates/database/src/query/limit.rs` l. 53–70) returns `None` once `limit` rows went out, without asking
  the range again. `take(n)` is `limit(n).collect()`, `first()` is `take(1)`, `unique()` is `take(2)`
  (`npm-packages/convex/src/server/impl/query_impl.ts` l. 323–344). A `for await` that breaks just stops
  calling `1.0/queryStreamNext`. So:
  - `first()` on a queue reads `[start, first key]`, and an insert later in the range does not
    conflict with it.
  - `take(n)` that gets exactly n rows reads up to the n-th, even if nothing follows; with fewer than n rows
    it asked once more, found the range empty and recorded all of it.
  - `first()` on an empty range records the whole range. `take(0)` never pulls: it records nothing.
- Documents a `filter` rejected still count: `Filter::next` (`crates/database/src/query/filter.rs`
  l. 53–72) pulls rows from the range until one passes, and the range records each one it returns. The
  recorded prefix therefore runs through the rejected rows up to the row that passed.
- Pagination is the same stream: a full page stops at its last row (`[start cursor, last key]`), a page that
  runs out of the range or reaches its end cursor records all of it (STUDY-17).

### 1.2 Limits per transaction

`crates/common/src/knobs.rs`:

- **Documents read:** 32 000 (`TRANSACTION_MAX_READ_SIZE_ROWS`). Error `TooManyDocumentsRead`,
  "Too many documents read in a single function execution (limit: 32000)…", raised by
  `record_read_document`.
- **Bytes read:** 16 MiB (`TRANSACTION_MAX_READ_SIZE_BYTES`). Error `TooManyBytesRead`.
- **Read-set intervals:** 4 096 (`TRANSACTION_MAX_READ_SET_INTERVALS`). Error `TooManyReads`,
  raised by `record_indexed_directly`.
- **User writes:** 16 000 documents (`TRANSACTION_MAX_NUM_USER_WRITES`) and 16 MiB
  (`TRANSACTION_MAX_USER_WRITE_SIZE_BYTES`). Enforced in `crates/database/src/write_limits.rs` and
  `writes.rs`.
- **Scheduled functions, file reads and file writes** have their own limits (same file).

### 1.3 Write log and conflict detection

`crates/database/src/write_log.rs`:

- Each commit is stored as its index-key writes, computed from the old and new document for **every
  index** (`index_keys_from_full_documents`).
- The writes are grouped per index (`by_database_index`), then by commit ts, so a read-set is checked
  index by index over the commits in its window rather than over the whole log. Details in §1.7.
- `is_stale(reads, reads_ts, ts)` reports any write in `(reads_ts, ts]` that falls inside a read
  interval.
- Retention is by time and size, never by count; a transaction older than the retained log fails with
  `OutOfRetention`. Details in §1.6.

### 1.4 The committer

`crates/database/src/committer.rs`:

- **Timestamps:** `next_commit_ts` is `max(latest_ts + 1, wall clock in ns, last_assigned + 1)`.
  Timestamps are nanosecond wall-clock values, strictly increasing.
- **Validation:** `validate_commit` checks the read-set against the published write log
  (`commit_has_conflict`), and also against **`pending_writes`**: commits already validated but not
  yet persisted. They are appended right after validation, so a later conflicting commit fails even
  before the earlier one is durable.
- **Writing:** commits are handed to a write batcher. Up to `COMMITTER_MAX_WRITE_BATCH_DOCUMENTS` (64)
  or 64 KiB per batch, `COMMITTER_MAX_COMMIT_DELAY` 1 ms, and up to 16 batches in flight.
- **Persistence errors:** "The batcher acking the write is the commit point… If we are unsure whether
  the write went through, we crash the process and recover from whatever has been written to
  persistence" (the comment on `track_and_write_to_persistence`). A failed write is never left
  half-visible.

### 1.5 Retries and the error an app sees

`crates/application/src/application_function_runner/mod.rs`, the `run_mutation` loop:

- The mutation is re-executed on an OCC error up to `UDF_EXECUTOR_OCC_MAX_RETRIES = 4` times. That
  is 5 executions in total.
- Between executions it waits with exponential backoff and jitter (`common/src/backoff.rs`), from
  `UDF_EXECUTOR_OCC_INITIAL_BACKOFF` 100 ms to `UDF_EXECUTOR_OCC_MAX_BACKOFF` 2 s. It then waits for
  the conflicting write's ts to be visible (`wait_for_write_ts`).
- After the last retry the app gets `ErrorMetadata::user_occ` (`crates/errors/src/lib.rs`). The short
  code is `OptimisticConcurrencyControlFailure`. The message is:

  > Documents read from or written to the "tasks" table changed while this mutation was being run
  > and on every subsequent retry. <write source>. See https://docs.convex.dev/error#1

- **Mutation idempotency:** each attempt first calls `check_mutation_status`, and a success is
  recorded with `write_mutation_status`. A client that re-sends a mutation (same session and request
  id) after a reconnect gets the recorded result, not a second execution.
- **Commit timestamp for apps:** `db.vars.commitTs`
  (`npm-packages/convex/src/server/database.ts`) is a placeholder. When written into a field, it
  resolves at commit to an int64 ordered by commit order.

### 1.6 Write-log retention, `OutOfRetention` and the transaction window

Studied for D10 (owner, 2026-10-01: "match Convex"), at the same commit.

**Retention.** `crates/common/src/knobs.rs:867-885` and `crates/database/src/write_log.rs:395-441`
(`WriteLogManager::enforce_retention_policy(current_ts)`):

- `WRITE_LOG_MAX_RETENTION_SECS` = 300 s: a commit older than `current_ts - 300 s` is dropped.
- `WRITE_LOG_SOFT_MAX_SIZE_BYTES` = 50 MiB: while the log's size is at or over it, the limit becomes
  `current_ts - WRITE_LOG_MIN_RETENTION_SECS` (30 s). The limit is re-evaluated after each drop, so trimming
  stops as soon as the size is back under the budget.
- `WRITE_LOG_MIN_RETENTION_SECS` = 30 s is a floor: "we will never retain for less, even if
  WRITE_LOG_SOFT_MAX_SIZE_BYTES is exceeded… to allow some minimum buffer for queries to refresh after
  execution" (the knob's comment). **There is no hard cap** in bytes or in commits.
- "Older" is read off the commit ts: timestamps are wall-clock nanoseconds, so `current_ts - 30 s` is a
  timestamp. A commit is dropped when its ts is strictly below the limit.
- The size is the sum of the entries' `heap_size()` (index-key writes and write source), kept in
  `WriteLogManager.size` (`append` / `remove_at_ts`).
- `purged_ts` becomes the ts of the last dropped commit (`write_log.rs:415`); it starts at the ts the
  log was created at (`WriteLog::new`, `:587-594`).
- Who trims: the subscription workers, once every manager has processed a ts, call it with the minimum
  processed ts (`crates/database/src/subscription.rs:237-254`). So `current_ts` is the latest commit (or
  `max_repeatable_ts` bump, below) the subscriptions have seen, not the clock.

**At commit.** `WriteLog::is_stale(reads, reads_ts, ts)` (`write_log.rs:600-618`) returns
`OutOfRetentionError` when `reads_ts < purged_ts`, **before** looking at the read set: a transaction that
read nothing is refused too. The committer calls it in pre-validation (`committer.rs:229-262`, skipped only
when `begin_ts >= max_ts`) and in `commit_has_conflict` (`:1007-1018`).

- The error (`write_log.rs:568-584`): "Timestamp {reads_ts} is outside of write log retention window
  (minimum timestamp {purged_ts})", with `ErrorMetadata::out_of_retention()`.
- `ErrorMetadata::out_of_retention()` (`crates/errors/src/lib.rs:400-411`): code `OutOfRetention`, short
  message `InternalServerError`, message `INTERNAL_SERVER_ERROR_MSG` ("Your request couldn't be completed.
  Try again later.", `:1102-1103`). It is not a user error (`:515-532`), answers HTTP **503**
  (`:719-731`), and closes a WebSocket with `CloseCode::Again` (1013, `:676-690`).
- **It is not retried as OCC.** `_retry_mutation`
  (`crates/application/src/application_function_runner/mod.rs:1052-1124`) re-runs only errors with
  `occ_info()`. An `OutOfRetention` is logged as a system error and returned. Over HTTP the client gets 503
  `{code: "InternalServerError", message: "Your request couldn't be completed. Try again later."}`. Over the
  sync protocol the mutation's future fails, the connection closes with 1013 `InternalServerError`
  (`crates/local_backend/src/subs/mod.rs:270-325`, no `FatalError` frame since it is not a user error), and
  the client reconnects and re-sends the mutation (once: mutation idempotency).

**Reads: refresh.** `WriteLog::refresh_token` (`write_log.rs:621-638`) answers `Err(None)` when the
token's ts is out of retention, and `LogReader::refresh_token` (`:678-695`) first returns the token
unchanged when its ts already equals the target. The callers treat `Err` as "can't prove it is still
valid": the subscription is invalidated and re-run (`subscription.rs:430-440`), the query cache misses and
re-executes (`crates/application/src/cache/mod.rs:780`), and the sync worker re-runs the query
(`crates/application/src/api.rs:660`). No error reaches the app.

**The transaction window.** `MAX_TRANSACTION_WINDOW` = 10 s (`knobs.rs:432-436`) bounds the snapshot
versions the snapshot manager keeps in memory:

- `SnapshotManager::push` (`snapshot_manager.rs:747-758`) drops the oldest version while its *successor*
  is more than 10 s older than the version being pushed. So the earliest version is the last one before
  `latest - 10 s`.
- `SnapshotManager::snapshot(ts)` (`:661-678`), called when a transaction BEGINS
  (`database.rs:1997-2014`, `begin_with_repeatable_ts`), fails with `out_of_retention()` and "Timestamp
  {ts} is too early, retry with a higher timestamp" when `ts < earliest_ts()`.
- Mutations, queries and actions begin at the latest ts, so they never hit it. The callers that begin in
  the past are `/api/query_at_ts` (`crates/local_backend/src/public_api.rs:532-575`, HTTP 503) and the sync
  worker's query updates, which retry with backoff on `OutOfRetention` (`crates/sync/src/worker.rs:1035-1047`).
- A transaction that has begun keeps its snapshot however long it runs; a long one meets the write log's
  retention at commit, not this window.

**`max_repeatable_ts`.** The committer bumps `max_repeatable_ts` 5 s after a commit
(`MAX_REPEATABLE_TIMESTAMP_COMMIT_DELAY`, `knobs.rs:664-665`; `committer.rs:360-490`) and every 1–2 h when
idle. The bump pushes a snapshot version and appends an empty write to the log, which moves `current_ts`
for both windows forward without adding entries.

### 1.7 How the write log is indexed for conflict checks

Studied for D11 (owner, 2026-10-01: "match Convex (to be built)"), at the same commit.

**The published log.** `crates/database/src/write_log.rs`:

- `WriteLog` (`:561-566`) holds `by_database_index` and `by_text_index`, each a `WritesByIndex`
  (`:497-558`): an `OrdMap<TabletIndexName, OrdSet<ArcWriteInIndex>>`, persistent (`imbl`) maps so that a
  snapshot of the log is a cheap clone.
- An `ArcWriteInIndex` (`:442-494`) is one commit's writes into one index: `WriteInIndex { ts,
  index_updates, write_source }`. Its `Eq`/`Ord` compare **the ts only** (`:472-493`), so each index's set
  is ordered by commit ts, not by key. Nothing in the published log is ordered by key.
- `WriteLogManager::append` (`:346-373`) inserts each index's `WriteInIndex` into that index's set (and the
  index into `min_ts_to_index` the first time it appears). Trimming (`enforce_retention_policy`,
  `:395-441`) pops the oldest `(ts, index)` from the binary heap `min_ts_to_index` (`:306-315`) and calls
  `remove_at_ts` (`:530-550`), which drops that commit's entry from the index's set and pushes the index's
  next minimum, or removes the index when its set is empty.

**The check.** `WriteLog::is_stale` (`:600-618`) calls `ReadSet::writes_overlap_by_index`
(`crates/database/src/reads.rs:167-221`):

- For each index the transaction read (`ReadSet.indexed`, a `BTreeMap<TabletIndexName, IndexReads>`,
  `reads.rs:98`, so in index order), it looks the index up in the log, takes
  `updates.range((Excluded(from), Included(to)))`, and for every key of every update in those commits
  asks `index_reads.intervals.contains(key)`. The first hit is the conflict: its `write_ts`, the index,
  the document id and the commit's `write_source`. So Convex reports the **oldest** conflicting commit in
  the **first** index read that has one.
- `IntervalSet` (`crates/common/src/interval/interval_set.rs:28-37`) is a `BTreeMap<start, end>` of
  intervals kept "non-intersecting, non-adjacent, and non-empty" (merged on `add`, `:150-…`); `contains`
  (`:242-249`) looks at the single interval preceding the key, `O(log i)`.
- Text-index reads are checked the same way against `by_text_index` (`:198-219`).
- **Complexity:** `O(Σ over the indexes read of (log n + w × log i))`, where `w` is the number of keys
  written into that index by commits in `(from, to]` and `i` the number of read intervals on it. Writes into
  indexes the transaction did not read, and commits outside its window, are never looked at. A transaction
  that read an index many commits wrote during its window still pays for each of those keys.
- `refresh_token` (`:621-638`) uses the same `is_stale`, so subscription and cache revalidation pay the
  same.

**Pending writes.** `committer.rs:1007-1020` (`commit_has_conflict`) checks the published log first, then
`PendingWrites::is_stale` (`write_log.rs:1095-1100`): the commits validated but not yet published. Those
are indexed differently: per index a `BTreeMap<key, PendingKeyWriter { ts, document_id }>`
(`PendingKeysInIndex`, `:928-972`), filled by `push_back` / `index_by_key` (`:1010-1071`) and emptied by
`pop_first` (`:1156-1187`). `overlaps` (`:961-972`) probes the smaller side against the other (each pending
key against the intervals, or each interval as a key range of the map), so it reports the conflicting key
**lowest in key order**, not the oldest. Text reads against pending writes are a linear scan
(`:1124-1146`): tokenizing on the committer thread is too costly.

**Pre-validation off the committer.** `pre_validate_batch` (`committer.rs:227-262`) runs `is_stale` on a
cloned `WriteLogSnapshot` outside the committer's loop up to the log's `max_ts`; the committer then only
checks `(validated_through, commit_ts]` (`validate_commit`, `:888-905`). This is concurrency, not indexing:
it moves most of the work off the single committer thread.

## 2. What an app can observe

1. **Serializable mutations.** A conflict is invisible unless it persists through 5 attempts. The app
   then sees the OCC error above, with its code and message.
2. **Conflict footprint:** `take(n)`, `first()` and a paginated page conflict only with writes inside
   the part they scanned.
3. **Hard limits:** 32 000 documents and 16 MiB read, 4 096 intervals, 16 000 documents and 16 MiB
   written. Each has a named error.
4. **Retry latency:** a contended mutation takes 100 ms to 2 s per retry, not microseconds.
5. **Exactly-once over the sync protocol:** a mutation re-sent after a reconnect is not run twice.
6. **`db.vars.commitTs`** is available to mutations.
7. **Long transactions:** a mutation whose snapshot is older than the write log's retention (≥ 30 s, up to
   300 s, depending on write volume) fails once with the internal error: 503 over HTTP, close 1013 over the
   sync protocol (and the client re-sends). It does not count as an OCC failure. A query re-runs instead.
   `/api/query_at_ts` more than ~10 s behind the latest ts answers the same 503.

## 3. How bunvex does it today

`packages/core/src/tx.ts`:

- `get` records the `by_id` point interval, as Convex does.
- ~~`query(...).run` records **the whole `[lo, hi)` range** before scanning, whatever `take(n)` read.
  The comment calls it "only affects how often the query cache is invalidated". It also widens the OCC
  footprint of mutations.~~ Since D3 was built (§9): the read-set ends at the last key read, as Convex's.

`packages/core/src/committer.ts`:

- **Timestamps:** `appliedTs = max(appliedTs + 1, wall clock in µs)`, resumed from `maxTs()` (D9, as Convex).
- **Validation:** `validate` checks the pending commit's intervals against each `LogEntry` with
  `ts > snapshot`, linearly (`overlaps`). The log holds commits already *applied* in the current or
  previous group, so it plays the role of Convex's `pending_writes` too. (Since D11, through the log
  indexed per index: §8.)
  - Since D10 (this section describes `main` before it): the log was trimmed to `logWindow = 20 000`
    commits, and a snapshot older than the window was treated as a conflict, retried against the OCC budget.
- **Group commit:** everything queued while a flush runs forms the next group, with no size cap. For
  each accepted commit, `persistence.apply` is called **before** the group's `flush()`.
- **Flush failure:** if `flush()` throws, the group's promises are rejected, but:
  - `appliedTs` has already advanced;
  - the log entries stay;
  - the writes are already applied to persistence (memory: in the B-trees; SQLite: in the still-open
    SQL transaction, since `inTx` stays true).

  The next successful group then publishes a `visibleTs` above them. **Probe:** with a wrapper whose
  `flush()` threw once, a mutation was rejected with "disk full", yet after the next commit the
  "rejected" document was visible to queries.
- An exception thrown by `persistence.apply` inside `drain()` is not caught. `running` stays true,
  and every later commit waits forever.

`packages/core/src/engine.ts`:

- `mutation` retries a `ConflictError` up to `maxRetries = 30` times.
- It sleeps `min(2^attempt, 20) * random()` ms between attempts, so at most 20 ms.
- A read-only mutation returns without going through the committer.
- The final error is `ConflictError("write conflict")`.

There are no transaction limits, no mutation idempotency, and no `db.vars.commitTs`.

## 4. Divergences

| # | Divergence | Class | Why / impact | Decision |
|---|---|---|---|---|
| D1 | A failed `flush()` rejects the commit but leaves its writes applied, its ts consumed and its log entry in place; a later group makes them visible (`committer.ts` `drain`) | BUG | The client is told the mutation failed, yet its writes appear, and can become durable (SQLite commits them with the next group). Convex crashes and recovers from what persistence actually holds | **fixed in #9** |
| D2 | An exception from `persistence.apply` in `drain()` is uncaught, and `running` stays true forever (`committer.ts`) | BUG | A driver whose `apply` does I/O can throw there. SQLite inserts inside `apply`, so `SQLITE_FULL` or `SQLITE_IOERR` would do it. Every commit after that hangs. The remote drivers only buffer in `apply` and fail in `flush` (D1) instead, e.g. with an index key over MySQL's `varbinary(512)` (STUDY-09) | **fixed in #9** |
| D3 | The read-set of `take(n)`/`first()` is the whole range, not the scanned prefix (`tx.ts` `run`) | OBSERVABLE | More OCC conflicts than Convex. A mutation that pops the head of a queue conflicts with every insert into the queue, so it can exhaust retries where Convex succeeds | **as Convex, fixed in #PR** (owner, 2026-10-01: match Convex; DV-57): see §9 |
| D4 | Retries: 30 with ≤20 ms jittered backoff vs Convex's 4 retries (5 runs) at 100 ms–2 s (`engine.ts`) | OBSERVABLE | Different failure rate and latency under contention. Tests that expect an OCC error after hot-key contention behave differently | **as Convex** (owner): [STUDY-21](STUDY-21-occ-error-and-retries.md); resolved to match Convex in #38 (DV-38) |
| D5 | OCC error: `Error("write conflict")` vs `OptimisticConcurrencyControlFailure` with "Documents read from or written to the "T" table changed…" (`committer.ts` `ConflictError`) | OBSERVABLE | Apps and tooling that match on the message or code differ | **as Convex**: [STUDY-21](STUDY-21-occ-error-and-retries.md); resolved to match Convex in #38 (DV-38) |
| D6 | No transaction limits: reads (32k docs / 16 MiB), intervals (4 096), writes (16k docs / 16 MiB) | OBSERVABLE | Code that works on bunvex can fail on Convex, and unbounded transactions can exhaust memory or stall the single committer | resolved to match Convex: read limits in #12, write limits in #35 (DV-39) |
| D7 | No mutation idempotency: no session or request id, no recorded result | OBSERVABLE | A re-sent mutation after a reconnect runs twice. Needed with the client sync work | resolved to match Convex (owner, 2026-09-30): `_session_requests`, built in #63 (DV-31) |
| D8 | No `db.vars.commitTs` | OBSERVABLE | Missing API | Decided (owner, 2026-10-01): match Convex (gap, to be built) (DV-59) |
| D9 | Commit timestamps are a counter, not nanosecond wall-clock values | ~~INTERNAL~~ observable since sync protocol v1 (transition and mutation `ts`, `maxObservedTimestamp`) | A recreated store restarts the counter at 1 and refuses clients that saw a higher ts; `maxTs` errors reuse a ts (STUDY-24 S2) | **Decided (owner, 2026-09-30): as Convex.** `ts = max(last + 1, wall clock)`, in **microseconds** internally (a JS number is exact only to 2^53) and × 1000 on the wire, so clients see Convex's wall-clock nanoseconds at µs resolution. The write log's window is tracked explicitly (`purgedTs`), since timestamps are sparse. Built in #64 (DV-30) |
| D10 | The write log is trimmed by count (20 000 commits), not by time or size, and a snapshot outside it is a retried conflict, not `OutOfRetention` | INTERNAL | Very long mutations fail differently; rare. Under load the count runs out in well under a second (STUDY-24 §4.2: 60 % of lagged attempts conflicted) | **Decided (owner, 2026-10-01): as Convex.** Resolved to match Convex in #118 (DV-60): see §7. Plus a hard byte cap Convex does not have, **on by default at 256 MiB** (DV-128, decided by the owner on 2026-10-01; may be revisited) |
| D11 | Validation is linear over log entries × writes × read intervals; Convex indexes the log per index | INTERNAL | Performance only (ENGINE-00 M4). With D10 the log holds seconds of commits (~50k entries at 500 ms of full load), so the scan matters | **Decided (owner, 2026-10-01): as Convex.** Resolved to match Convex in #120 (DV-61): see §8 |
| D12 | Group size is unbounded; Convex batches ≤64 docs / 64 KiB with up to 16 batches in flight | INTERNAL | Performance and latency only | Decided (owner, 2026-10-01): match Convex (gap, to be built) (DV-62) |

## 5. Tests

- **Flush failure:** a persistence double whose `flush()` rejects once. The rejected mutation's writes
  must never become visible, and the next commits must work. Also a double whose `apply()` throws:
  the committer must not wedge.
- **Conflict footprint:** mutation A reads `first()` from `by_creation_time` while B inserts a later
  document. A must commit without a retry. Assert `stats.retries === 0`. Built with D3: §9.
- **Retry budget:** a hot-key contention test counts executions (5 max) and checks the final error
  code and message against Convex's.
- **Limits:** reading 32 001 documents, writing 16 001 documents and making 4 097 range reads each
  fail with the named error.
- **Cross-check:** the `increment, one doc` scenario of convex-bench, comparing the OCC failure rates
  of bunvex and Convex.

## 6. Open questions

1. On a flush failure, should the committer fail-stop, as Convex does (crash, then recover from
   persistence), or roll back? Rolling back means undoing the memory apply, rewinding `appliedTs` and
   removing the log entries.
2. Keep bunvex's fast retries (a single process with no network hop to storage), or match Convex's
   budget exactly? Matching the *final error* is required in both cases. The backoff numbers are the
   owner's call.

## 7. D10 as built: retention by time and size

`packages/core/src/committer.ts`:

- **Retention, as `enforce_retention_policy`.** Each log entry is kept with its approximate size
  (`logEntryBytes`: entry, writes array, per write its object, key bytes and id). After each group is
  published (as Convex trims once the subscriptions have seen a ts), the oldest entries are dropped while
  their ts is below `latest - 300 s`, or below `latest - 30 s` while the log is at or over 50 MiB. `purgedTs`
  becomes the last dropped ts. Timestamps are wall-clock microseconds since D9, so a commit's age is read off
  its ts, as in Convex; no separate wall-clock time per entry is needed. There is no count limit.
- **The size estimate** was calibrated on Bun 1.4 (`bun bench/write-log.ts calibrate`): ~580 bytes
  estimated vs ~590 measured for a three-index insert. At 7 M entries the estimate (3 863 MiB) and the heap
  (3 916 MiB) agree within 2 %.
- **The log** is an array with a moving head (compacted when the dropped prefix is the larger part), so
  trimming is amortized O(1) per commit; the old `splice` was O(log length).
- **At commit:** a snapshot below `purgedTs` is refused with `OutOfRetentionError` (Convex's message),
  before the read set is looked at, as `is_stale`. It is counted in `outOfRetention`, not `conflicts`.
- **`changedBetween`** is unchanged: true when `from < purgedTs`, so subscriptions and the sync worker
  re-run, as `refresh_token`'s `Err(None)`.
- **Begin window:** `checkBeginTs(ts)` / `earliestBeginTs()` compute Convex's earliest snapshot version from
  the log (the last commit before `visibleTs - 10 s`, or `purgedTs`). `Functions.runQueryAtJson` (the HTTP
  `query_at_ts`) checks it. Every other bunvex transaction begins at the latest ts (a sync transition at the
  `visibleTs` it read in the same tick), as in Convex, so the check could not fail there.

`packages/core/src/engine.ts`: only `ConflictError` is retried; `OutOfRetentionError` propagates after one
execution. The knobs are an `Engine` option (`writeLogRetention`).

`packages/server`: `OutOfRetentionError` is a system error (`errors.ts` `isSystemError`). HTTP answers 503
`{code: "InternalServerError", message: "Your request couldn't be completed. Try again later."}`; protocol
v1 closes with 1013 `InternalServerError` (other system failures stay 500 / 1011).

**Not modelled: the `max_repeatable_ts` bump.** bunvex has no `max_repeatable_ts` (a multi-node mechanism,
STUDY-24/25), so `current_ts` for both windows is the latest commit. After a burst followed by silence,
Convex trims up to 5 s later relative to the bump; bunvex keeps those entries until the next commit. This
only makes bunvex more lenient by at most the bump delay, and it disappears if `max_repeatable_ts` is built.

**Measured** (`bench/write-log.ts`, a laptop with 8 cores and 16 GiB, Bun 1.4.2, memory driver unless noted; "before" is
`main`'s committer):

| Scenario | Before (20 000 commits) | After (time and size) |
|---|---|---|
| 64 writers, no reads, 20 s: commits/s | 111.6k / 118.1k | 111.6k / 116.5k |
| same, RSS (the memory store dominates) | 3 641 / 3 434 MiB | 3 688 / 3 795 MiB |
| same, log | 20 000 entries (~12 MiB) | 2.2–2.3 M entries, ~1.2–1.3 GiB estimated (nothing is 30 s old yet) |
| null driver (RSS is the committer's), 20 s | 357k/s, 115 MiB | 349k/s, 5 828 MiB |
| null driver, 45 s (steady state) | 357k/s, 115 MiB | 285k/s, 7.4 M entries, 4.1 GiB heap |
| null driver, 40 s, hard cap 256 MiB (DV-128, now the default) | | 337k/s, 462k entries, 262 MiB heap |
| lagged snapshots, noise at max rate, lag 500 ms: failed | **100 %** (1 635/1 635) | **0 %** (0/982) |
| same, lag 2 s | 100 % | 0 % |
| noise at 2 000 commits/s, lag 500 ms | 0 % | 0 % |
| noise at 2 000 commits/s, lag 15 s | **100 %** | **0 %** |
| engine, 64 writers inserting (`Engine.mutation`) | | 95k/s; 5 s of commits = 477k entries, 181 MiB |

Notes:

- With the count window a lagged snapshot fails as soon as 20 000 commits pass: ~170 ms at full load.
- Under the lag scenario the noise rate falls (122k → 78k/s at 500 ms): lagged commits are now validated
  against up to ~50 000 entries each, linearly (D11, DV-61), where they used to be refused at once. Since
  D11 they are validated through the indexed log and the noise rate is back to ~125k/s (§8).
- **Memory.** Convex's 30 s floor has no byte bound. At bunvex's commit rates it is gigabytes: ~1.1 GiB at
  the engine's 95k inserts/s, ~4 GiB for the raw committer. The memory driver already keeps every version
  (DV-65), so the log is a fraction of RSS there; on SQLite or a remote driver it would be most of it. The
  committer therefore has a hard byte cap Convex does not have: **DV-128, decided by the owner on
  2026-10-01** (approved as recommended; may be revisited).

**The hard cap (DV-128).** `writeLogRetention.hardMaxBytes`, default `WRITE_LOG_HARD_MAX_BYTES` = 256 MiB.
While the log's estimate is over it, the oldest commits are dropped whatever their age, so the 30 s floor
no longer holds under extreme sustained load: at the engine's 95k inserts/s the capped log is ~7 s of
commits, and a mutation (or `query_at_ts`) older than that gets `OutOfRetention` where Convex would still
validate it. Below 256 MiB nothing changes. `null` or `0` (or `Infinity`) turns the cap off, which is
Convex's exact rule (tested). Re-measured with the default (`bench/write-log.ts`, memory driver, 64 writers;
"previous head" is this PR before the default, i.e. no cap):

| | previous head (no cap) | cap on by default |
|---|---|---|
| 10 s: commits/s | 106.4k / 105.1k | 111.8k / 99.1k |
| 10 s: log, RSS | 1.06 M entries, ~585 MiB; 1 912 / 1 949 MiB | 462k entries, 256 MiB; 1 971 / 1 798 MiB |
| 40 s (past the 30 s floor): commits/s | 67.0k | 73.3k |
| 40 s: log, RSS (the memory store dominates) | 1.54 M entries, 855 MiB; 2 954 MiB | 462k entries, 256 MiB; 3 524 MiB |
| null driver, 10 s: commits/s, heap, RSS | 310.6k, 1 745 MiB, 3 255 MiB | 309.2k, 265 MiB, 1 158 MiB |

Throughput is unchanged within noise. On the memory driver RSS is the store's (it keeps every version,
DV-65) and swings by a few hundred MiB between runs; the null driver shows the committer's own share.

## 8. D11 as built: the write log indexed per index

`packages/core/src/write-log-index.ts` (`WritesByIndex`), used by `packages/core/src/committer.ts`:

- **The structure, as Convex's `WritesByIndex`.** Per index id, the writes into that index in commit order:
  two parallel arrays, the commit ts and the write (`{ index, key, id }`, the same object the log entry
  holds), from a moving head. Convex keeps one `WriteInIndex` per commit and index in an `OrdSet` by ts;
  bunvex keeps one slot per write in an array, which is ordered by ts because commits are appended in ts
  order. The write source is not copied per index: on a conflict it is found by binary search in the log.
- **Append** happens where the commit enters the log (right after `persistence.apply`), so the next commits
  of the same group are checked against it.
- **Trim.** `enforceRetention` drops the oldest log entry, then removes its writes from the head of each
  index's column (asserting they are there), deletes a column that becomes empty, and compacts a column when
  its dropped prefix is the larger part. bunvex already walks its log oldest first, so it needs no
  `min_ts_to_index` heap.
- **The check, as `writes_overlap_by_index`.** The read-set is grouped per index and each index's
  intervals are sorted and merged (non-intersecting, non-adjacent, non-empty, like `IntervalSet`), the
  indexes in ascending id order. For each, a binary search finds the first write with ts above the
  snapshot, and each write up to the upper bound is tested with a binary search over the intervals. The
  first hit is reported with its ts, index, document id and write source.
- **Published, then pending, as `commit_has_conflict`.** `validate` checks `(snapshot, visibleTs]` first,
  then `(max(snapshot, visibleTs), appliedTs]`, the commits of the current group applied but not yet
  flushed (Convex's `pending_writes`). bunvex keeps one structure for both, and names the conflicting write
  as each Convex structure does: among published commits the oldest, among pending ones the lowest key (the
  oldest among equal keys, a case Convex rules out by panicking), in the first index read that has one. The
  name reaches the OCC error's write source and the retry's wait for the conflicting ts. Before D11 bunvex
  named the newest conflicting commit. Scanning the pending window for its lowest key costs the group's
  writes into the index, which is small; Convex's key-ordered map would be `O(min(p, i) log)`.
- **`changedBetween`** (subscriptions, the sync worker; Convex's `refresh_token`) runs the same check over
  `(from, to]`.
- **Size estimate.** `logEntryBytes` counts each write's two column slots: 104 bytes per write instead of 80
  (`bench/write-log.ts calibrate`, now through a committer: ~650 estimated vs ~670 measured per three-index
  insert, ~590 before).
- **Not modelled: pre-validation off the committer.** bunvex runs on one JavaScript thread, so there is no
  other thread to validate on; the whole window is checked in `validate`.
- **Text indexes:** bunvex has none yet; their reads will need the same per-index treatment.
- **Not shared with the subscription index (DV-64, #119).** That one indexes the other direction: the
  registered read intervals, queried by a commit's written keys (an interval tree). This one indexes
  written keys by ts, queried by a read-set. Convex keeps them separate too. A later cleanup could share the
  read-set normalization (`intervalSetsByIndex`).

**Tests.** `packages/core/test/occ-validation.test.ts`: 150 seeded runs of random commits (four indexes,
deletes, write sources) through the real committer with small retention windows (so the log is trimmed by
time and by size), random read-sets (points, ranges, overlapping, empty and reversed intervals) and random
snapshots, including ones between sparse timestamps and ones just past the log. Against a linear oracle (the
validator this replaced) every commit must be accepted or refused as the oracle says, the conflict named must
be a real conflicting write chosen as Convex chooses it, `changedBetween` must agree, and the index must hold
exactly the writes and indexes of the retained log (~600 000 assertions, ~0.5 s). Sabotage, each turns it
red: an interval's end inclusive, its start exclusive, the window's lower bound inclusive, its upper bound
exclusive, trimmed writes not removed, empty columns kept, the committer not appending or not trimming,
pending commits ignored, published-first order dropped, pending conflicts named by age instead of key, a
wrong write source, a merge that shrinks an interval.

**Measured** (a laptop with 8 cores and 16 GiB, Bun 1.4.2; "before" is #118's committer, run through
`COMMITTER=`):

`bun bench/occ-validation.ts`: one validation against a log of N three-index inserts, µs, after / before:

| Log entries | Point read, index nobody wrote | Point read on `by_id` (all wrote it), whole log | 10 ranges on a written index, whole log | Conflict with the oldest commit | Point read on `by_id`, last 100 commits |
|---|---|---|---|---|---|
| 1 000 | 0.6 / 13 | 9 / 18 | 14 / 66 | 0.5 / 37 | 1.6 / 2.4 |
| 10 000 | 0.2 / 170 | 54 / 199 | 122 / 730 | 0.9 / 343 | 1.5 / 1.8 |
| 50 000 | 0.2 / 2 250 | 945 / 2 480 | 1 860 / 5 220 | 0.3 / 3 380 | 0.7 / 1.8 |
| 200 000 | 0.2 / 11 560 | 5 660 / 13 270 | 9 950 / 25 230 | 0.3–1 / 18 460 | 0.7 / 1.8 |

What remains linear is Convex's too: the keys written, during the transaction's window, into an index it
read. A transaction that only spans recent commits (the last column) pays for those, whatever the log's
size.

`bun bench/write-log.ts lag` (64 noise writers at full rate, a lagged transaction every 5 ms reading an
index the noise does not write; two runs each):

| Lag | Noise commits/s, after / before | Lagged commit latency p50 / p99, after | before | Lagged commits in 10 s, after / before |
|---|---|---|---|---|
| 500 ms | 125–127k / 80–81k | 0.5 / 1.0–1.3 ms | 4.1 / 7.2–7.6 ms | 1 569–1 586 / 980–982 |
| 2 s | 124–126k / 64k | 0.5 / 1.2–1.6 ms | 10.2–10.3 / 24.4–24.6 ms | 1 301–1 305 / 474–475 |

The noise rate is back to what it is without lagged transactions. None failed, before or after.

`bun bench/write-log.ts throughput` (64 writers, no reads, 10 s, two runs): the cost of maintaining the
index on append and trim. Memory driver 124–128k commits/s after vs 129k before; null driver 352–361k vs
364–372k (−1 to −5 %, within run-to-run noise for the memory driver). Heap per retained entry 660 vs
590 bytes (+12 %).

## 9. D3 as built: the read-set ends at the last key read

`packages/core/src/tx.ts` (`ScanReads`, `readEndAfter`, `Tx.reads`):

- **One `ScanReads` per scan** (`runQuery` for `take`/`first`/`unique`/`collect`, `iterate` for `for await`).
  Each document the scan reaches, before the filters, is handed to it; when the scan runs out of its range
  it records the whole range. Nothing is recorded until the first document, so `take(0)` (which, as
  Convex's `Limit`, never scans) records nothing. The edges are Convex's `split_after`:
  - ascending: `[lo, readEndAfter(key, hi))`, where `readEndAfter` is `prefixEnd(key)` (Convex's
    `increment`) capped at the range's end. Index keys end with the self-delimiting document id, so no index
    key lies strictly between `key` and `prefixEnd(key)`: the interval is exactly "up to and including the
    last key";
  - descending: `[key, hi)`.
- **Where the scan stops.** Without filters, `take(n)` fetches one page of n rows (plus this transaction's
  removals, STUDY-02): fewer than n means the range ran out (whole range), exactly n ends the read-set at
  the n-th row, as Convex's `Limit` stops without asking for more. With filters, the stream stops at the row
  that met the limit; rows the filter dropped are before it, so inside the prefix. Rows this transaction
  wrote are part of the scan (the merge of STUDY-02), so they extend it too.
- **Keys are encoded once per scan, not per row.** Encoding an index key for every row would double the cost
  of a long `for await` (measured: 10 000 rows, 8.6 → 17.0 ms). A `ScanReads` keeps the last document it
  reached and its interval object (recorded at the first document, so the 4 096-interval limit applies when
  it did); the key is encoded when the read-set is next read: `Tx.reads` settles every scan that moved.
  Every consumer goes through `Tx.reads`: the committer's validation, the query cache, and the sync hub's
  read-set index (`engine.ts` `queryTracked`). An iterator abandoned without `return()` keeps the prefix it
  reached.
  - The app may change a document it was given (`d.n = …`), and the key must be the stored one. So before a
    document is handed out (each `yield`, and the result of `take`/`first`/`unique`), `handOut` takes the
    key's values. Strings, numbers, booleans and null cannot change; a key holding an object, array or bytes
    value is encoded at once instead.
- **Pagination** already recorded `[start, last key]` (STUDY-17); its end now uses the same
  `readEndAfter`.
- **Not changed:** a scan's prefetch (pages of 64, growing to 1 024) still counts every fetched document
  toward the 32 000-document read limit, where Convex counts the rows returned (`record_read_document` in
  `start_next`). It only matters near the limit, with a filter or a `for await` that stops early; noted
  here for a follow-up, not decided.

Tests (`packages/core/test/read-set-prefix.test.ts`, `read-set-serializable.test.ts`,
`packages/server/test/sync.test.ts`):

- Each shape (asc/desc `take`, `first`, `unique`, filters, `for await` with `break`, an abandoned iterator,
  a returned document the app changed, pages asc/desc, an empty range, `take(0)`, `collect`) is checked
  against writes before, at and after the last key read, through `changedBetween`, the check both
  validation and invalidation use.
- OCC: a queue pop that raced with an append commits without a retry; one that raced with a write to its
  head retries once; a mutation's own insert inside the scanned prefix extends it.
- Query cache and sync: appends past a subscribed `first()` re-run nothing; deleting its head re-runs it.
- **Serializability:** 60 seeds × 6 workers × 14 random mutations (early-stopping scans asc and desc,
  filters, `unique`, `for await` + `break`, pages, inserts, moves), interleaved at random points between
  reads and writes. Each committed result equals its result in a serial replay in commit-ts order, and the
  final states match.
- **Sabotage** (each run over the four test files above):
  - ending the ascending interval at the last key, exclusive (one key too short): 10 tests fail, the
    serializability test and the sync test among them;
  - starting the descending interval just after the last key: the descending edge test and the
    serializability test fail;
  - reading one key too far: the four "no conflict past the last key" tests fail;
  - never settling (the whole range, as before this change): 13 fail;
  - not taking the key's values before handing a document out: the "changed a returned document" test fails.

Measured on the memory driver unless named (Apple M-series, `bun bench/queue-head.ts`, 5 s, Convex's retry
budget, 4 appenders):

| | before | after |
|---|---|---|
| 1 popper: pops/s, pop executions lost to a conflict | 0 (35 executions in 5 s), 97.1 % | 3 655, 0 % |
| 4 poppers: pops/s, executions lost, OCC errors surfaced | 1, 97.4 %, 27 | 3 531, 0.6 %, 19 (pop against pop, same head) |
| 4 poppers, SQLite: pops/s, executions lost | 1, 97.1 % | 448, 4.9 % |
| Re-runs of a cached `first()` per append at its tail | 1 | 0 |

Before, the pops starve: each loses to any append and sleeps in Convex's backoff, so the appenders run
alone (73 k inserts/s; 74 k with no popper at all). After, both run: 18 k commits/s, 3.7 k pops and 14.6 k
inserts. A pop is the expensive commit here: each `first()` skips the tombstones of the pops before it (no
retention yet, DV-65; 33 → 69 µs per pop over 8 000 pops, the same before and after this change).

Per query, encoding the last key costs about a microsecond: through `queryTracked`, `first()` 1.7 → 2.7 µs
and `take(10)` 6.4 → 7.9 µs. Scans of 10 000 rows (`for await`, a filtered `collect`, a filtered `first()`
that matches late, `collect`): 9.0 → 9.7 ms for `for await` (one `handOut` per row), the others within
noise (8.1–9.9 ms both sides).

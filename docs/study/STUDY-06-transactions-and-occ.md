# STUDY-06 — Transactions, OCC and the committer

- **Status:** draft (retroactive). The code in §3 was written before the study-first rule.
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **bunvex code read:** `main` at `f60e934`
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
  `crates/database/src/query/index_range.rs` (`IndexRange::start_next`), each returned row records
  `initial_unfetched_interval.split(cursor)`, from the start of the range to the last key returned.
  The whole range is recorded only when the stream is exhausted.
  - So `first()` on a queue reads `[start, first key]`, and an insert later in the range does not
    conflict with it.
- Documents a `filter` rejected still count: they were scanned, so their interval is recorded.

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
- The writes are grouped per index (`by_database_index`), so a read interval is checked with a range
  lookup rather than a scan.
- `is_stale(reads, reads_ts, ts)` reports any write in `(reads_ts, ts]` that falls inside a read
  interval.
- Retention is by time and size (`WRITE_LOG_MIN_RETENTION_SECS` 30 s, `WRITE_LOG_MAX_RETENTION_SECS`
  300 s, `WRITE_LOG_SOFT_MAX_SIZE_BYTES` 50 MiB). A transaction older than the retained log fails
  with `OutOfRetention`.

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

## 3. How bunvex does it today

`packages/core/src/tx.ts`:

- `get` records the `by_id` point interval, as Convex does.
- `query(...).run` records **the whole `[lo, hi)` range** before scanning, whatever `take(n)` read.
  The comment calls it "only affects how often the query cache is invalidated". It also widens the OCC
  footprint of mutations.

`packages/core/src/committer.ts`:

- **Timestamps:** `appliedTs = max(appliedTs + 1, wall clock in µs)`, resumed from `maxTs()` (D9, as Convex).
- **Validation:** `validate` checks the pending commit's intervals against each `LogEntry` with
  `ts > snapshot`, linearly (`overlaps`). The log holds commits already *applied* in the current or
  previous group, so it plays the role of Convex's `pending_writes` too.
  - The log is trimmed to `logWindow = 20 000` commits. A snapshot older than the window is treated
    as a conflict.
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
| D3 | The read-set of `take(n)`/`first()` is the whole range, not the scanned prefix (`tx.ts` `run`) | OBSERVABLE | More OCC conflicts than Convex. A mutation that pops the head of a queue conflicts with every insert into the queue, so it can exhaust retries where Convex succeeds | Decided (owner, 2026-10-01): match Convex (gap, to be built) (DV-57) |
| D4 | Retries: 30 with ≤20 ms jittered backoff vs Convex's 4 retries (5 runs) at 100 ms–2 s (`engine.ts`) | OBSERVABLE | Different failure rate and latency under contention. Tests that expect an OCC error after hot-key contention behave differently | **as Convex** (owner): [STUDY-21](STUDY-21-occ-error-and-retries.md) |
| D5 | OCC error: `Error("write conflict")` vs `OptimisticConcurrencyControlFailure` with "Documents read from or written to the "T" table changed…" (`committer.ts` `ConflictError`) | OBSERVABLE | Apps and tooling that match on the message or code differ | **as Convex**: [STUDY-21](STUDY-21-occ-error-and-retries.md) |
| D6 | No transaction limits: reads (32k docs / 16 MiB), intervals (4 096), writes (16k docs / 16 MiB) | OBSERVABLE | Code that works on bunvex can fail on Convex, and unbounded transactions can exhaust memory or stall the single committer | owner |
| D7 | No mutation idempotency: no session or request id, no recorded result | OBSERVABLE | A re-sent mutation after a reconnect runs twice. Needed with the client sync work | owner |
| D8 | No `db.vars.commitTs` | OBSERVABLE | Missing API | Decided (owner, 2026-10-01): match Convex (gap, to be built) (DV-59) |
| D9 | Commit timestamps are a counter, not nanosecond wall-clock values | ~~INTERNAL~~ observable since sync protocol v1 (transition and mutation `ts`, `maxObservedTimestamp`) | A recreated store restarts the counter at 1 and refuses clients that saw a higher ts; `maxTs` errors reuse a ts (STUDY-24 S2) | **Decided (owner, 2026-09-30): as Convex.** `ts = max(last + 1, wall clock)`, in **microseconds** internally (a JS number is exact only to 2^53) and × 1000 on the wire, so clients see Convex's wall-clock nanoseconds at µs resolution. The write log's window is tracked explicitly (`purgedTs`), since timestamps are sparse |
| D10 | The write log is trimmed by count (20 000 commits), not by time or size, and a snapshot outside it is a retried conflict, not `OutOfRetention` | INTERNAL | Very long mutations fail differently; rare | Decided (owner, 2026-10-01): match Convex (gap, to be built) (DV-60) |
| D11 | Validation is linear over log entries × writes × read intervals; Convex indexes the log per index | INTERNAL | Performance only (ENGINE-00 M4) | Decided (owner, 2026-10-01): match Convex (gap, to be built) (DV-61) |
| D12 | Group size is unbounded; Convex batches ≤64 docs / 64 KiB with up to 16 batches in flight | INTERNAL | Performance and latency only | Decided (owner, 2026-10-01): match Convex (gap, to be built) (DV-62) |

## 5. Tests

- **Flush failure:** a persistence double whose `flush()` rejects once. The rejected mutation's writes
  must never become visible, and the next commits must work. Also a double whose `apply()` throws:
  the committer must not wedge.
- **Conflict footprint:** mutation A reads `first()` from `by_creation_time` while B inserts a later
  document. A must commit without a retry. Assert `stats.retries === 0`.
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

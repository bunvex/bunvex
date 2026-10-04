# STUDY-78 — The write throughput limit

- **Status:** implemented
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-04; the tests removed from
  it, at bea52bde0
- **Related:** [STUDY-21](STUDY-21-occ-error-and-retries.md) (the OCC retry budget it shares),
  [STUDY-68](STUDY-68-function-limits.md) (the other rate-limited error, `TooManyConcurrentRequests`),
  [STUDY-30](STUDY-30-scheduler-and-crons.md), [STUDY-42](STUDY-42-import-export.md), DV-62 (write batch sizes)

## 1. How Convex does it

**Knobs** (`crates/common/src/knobs.rs:1080-1092`):

- `MAX_BYTES_WRITTEN_PER_SECOND` is 4 MiB, "the maximum write rate (per second) allowed for mutations and
  import".
- `WRITE_THROUGHPUT_WINDOW` is 1000 ms.
- `PROPOSED_MAX_BYTES_WRITTEN_PER_SECOND` (1 MiB) only feeds a metric. It never refuses anything (§1, last
  bullets).

**The limiter** (`crates/database/src/write_throughput_limiter.rs`) has one instance per deployment, owned by
the snapshot manager (`snapshot_manager.rs:91`, `:559`).

- **Recording.** Each published commit pushes `(commit ts, write bytes)` into a sliding window with a running
  total (`record_write`, `snapshot_manager.rs:747-761`, called from `committer.rs:1135`).
  - Entries older than the window, measured from the new commit, are dropped then.
  - The bytes are the commit's `write_bytes` (`committer.rs:1059-1086`): per document version `ts + id +
    value + prev_ts`, per index entry `ts + index id + key + document id`
    (`common/src/persistence/mod.rs:69-122`).
  - These are the same bytes the write batcher sizes its batches by.
  - **Every commit counts**, system tables and system writers included.
- **Checking** (`check_limit(current_ts)`, called by `Database::check_write_throughput_limit`, `database.rs:2105`):
  - The limit is `MAX_BYTES_WRITTEN_PER_SECOND × window`.
  - When the running total is over it, the bytes of the commits within the window before *now* (the wall
    clock) are summed again, so a deployment that stopped writing is not blocked by a stale total. That was
    the bug fix 8bd79365b.
  - Over the limit → refused.
  - The transaction about to run does not count. So one large commit can take the window over, and the next
    writers wait.
- **The error** (`snapshot_manager.rs:763-776`):
  - `ErrorMetadata::rate_limited("TooManyWrites", "Too many writes per second. Your deployment is limited to 4
    MiB bytes written per 1 second. Reduce your write rate or upgrade to a larger deployment.")`, using
    `format_bytes` and `format_duration` (`common/src/fmt.rs`). The text really says "MiB bytes".
  - It is rate-limited: HTTP 429 and WebSocket `CloseCode::Again`. It is not a user error, so a function
    cannot catch it.
- **Who is gated**:
  - Each attempt of a mutation run by the function runner checks it first (`run_mutation_no_udf_log`,
    `application_function_runner/mod.rs:1158`). That covers client mutations (HTTP API and sync), an action's
    `runMutation`, scheduled mutations and crons.
    - **Client mutations** retry `TooManyWrites` in the OCC loop, sharing its budget (4 retries) and backoff
      (100 ms → 2 s), with `warn!("Write throughput limit exceeded, retrying …")`. After that they fail
      (`:932-999`), logged as a system error.
    - **Scheduled mutations** retry indefinitely; the job stays pending (`scheduled_jobs/mod.rs:843-864`).
    - **Crons** log and fail the attempt; the cron loop runs it again (`cron_jobs/mod.rs:531-547`).
  - **Snapshot import** waits before each write step, retrying indefinitely with backoff from 10 ms to 30 s
    (`execute_with_overloaded_and_ratelimited_retries`, `database.rs:1937-1966`, used by `snapshot_import`
    and its storage table).
  - Nothing else checks it: the scheduler's bookkeeping, retention, index backfill, … They still count.
- **Not to confuse with**:
  - the per-transaction `TooManyWrites` (16 000 documents, `writes.rs:293`): same short message, another
    error;
  - the client's `TooManyWritesInTimePeriod` reconnect entry, a retired retention-era error.
- **Tests** (removed from `main`; at bea52bde0):
  - five limiter cases (`write_throughput_limiter.rs:94-195`);
  - a mutation refused with the limit at 0 (`application/src/tests/mutation.rs:299-313`);
  - a scheduled job that stays pending until the limit is raised (`tests/scheduled_jobs.rs:570-630`).

## 2. What an app can observe

1. While the deployment has committed more than 4 MiB in the last second, a new mutation is refused and then
   retried, up to 4 times with backoff. If the window does not clear, it fails with `TooManyWrites`:
   - HTTP 429 `{code: "TooManyWrites", message}`;
   - over the sync protocol, the session closes with 1013 `TooManyWrites`, and the client reconnects and
     resends.
2. An action's `runMutation` sees the same failure.
3. A scheduled mutation is delayed, never failed, by it. A cron run is delayed.
4. An import is slowed down, never failed, by it.
5. Writes that are not gated still count toward the limit: an import's own writes, the scheduler's bookkeeping.

## 3. How bunvex does it

`packages/core/src/write-throughput.ts` (`WriteThroughputLimiter`, `TooManyWritesError`, Convex's
`format_bytes` / `format_duration`):

- **Recording.**
  - The engine owns one limiter (`engine.writeThroughput`, Engine option `writeThroughput`). Its defaults
    come from Convex's knobs `MAX_BYTES_WRITTEN_PER_SECOND` and `WRITE_THROUGHPUT_WINDOW`.
  - The committer records each commit's bytes when it publishes its batch. Every commit counts, system ones
    included.
  - The bytes are `commitWriteBytes`, the measure bunvex's write batches already use for Convex's
    `write_bytes` (DV-62). It counts the document's stored JSON where Convex counts its value's size. On
    typical documents the two are within about ±15%, and equal for large ones.
- **Gating.**
  - `Engine.mutation` / `mutationWithTs` / `sessionMutation` take `{ throttled: true }`; the function runner
    passes it (`THROTTLED` in `functions.ts`) for every mutation it runs. That covers the HTTP API, sync, an
    action's `runMutation`, scheduled mutations and crons.
  - Each attempt checks the limit first. A refusal counts as a failure of the OCC loop (same budget and
    backoff), and then the call throws `TooManyWritesError`.
- **Callers.**
  - `/api/mutation` answers 429 with the code and message.
  - Sync closes with 1013 `TooManyWrites`.
  - The scheduler and the cron executor retry it as they retry OCC: a job stays pending, a cron run is
    delayed.
  - Imports wait before each insert batch (backoff 10 ms → 30 s, no limit).
- **The message** replaces Convex's upgrade offer with how to raise the limit, as `TooManyConcurrentRequests`
  does (STUDY-68): "… Reduce your write rate or set MAX_BYTES_WRITTEN_PER_SECOND to raise the limit."
- **Not built:**
  - the proposed-limit metric and the throughput histogram (Convex internals);
  - the `warn!` log line.

**Measured.** Hot path: in-memory deployment, 20 000 mutations sequentially and then concurrently, median of
5 runs, the limit raised so nothing is refused:

| | `main` | This branch |
|---|---|---|
| sequential | 29.1–30.5 µs | 29.1–30.2 µs |
| concurrent | 20.2–20.7 µs | 19.5–19.8 µs |

That is within noise. Per commit the cost is two array pushes; per mutation attempt, one comparison (and a
re-sum only while over the limit). With the default limit, that concurrent burst (about 8 MB/s) is refused
after its retries, as Convex would refuse it. Benchmarks that measure raw write capacity set
`MAX_BYTES_WRITTEN_PER_SECOND` higher.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| W1 | The bytes are bunvex's stored bytes (`commitWriteBytes`: the document's JSON) rather than Convex's value size | The same quantity, bytes written to the store, in bunvex's storage format, as DV-62's write batches. Within about ±15% on small documents and equal on large ones. | not a divergence (same measure as DV-62) |
| W2 | The message's last sentence names the knob instead of offering an upgrade | As STUDY-68's `TooManyConcurrentRequests` | as STUDY-68 |

## 5. Tests

`packages/server/test/write-throughput.test.ts`:

- **Unit cases:**
  - Convex's five limiter cases (under, over, eviction on record, passing after the window without writes,
    accumulation);
  - a window other than 1 s;
  - the defaults and message;
  - Convex's `format_bytes` / `format_duration` doc-test values.
- **Mutations:**
  - refused after 4 retries with `TooManyWrites`, while the transaction's own bytes do not count and system
    writers are not gated;
  - retried and succeeding once the window passes;
  - the HTTP API's 429, and the sync close 1013 `TooManyWrites`;
  - a scheduled mutation pending while over the limit, then `success`.
- **Imports:** an import that waits for the window, then writes.

`scheduler.test.ts`'s messages test commits about 16 MiB of scheduled arguments in one mutation, so it now
raises the limit, as it would need to on Convex.

Sabotage checks, each failing tests:

- the committer not recording: 5 tests;
- the engine not checking: 4;
- the scheduler not retrying: 1;
- the import not waiting: 1;
- no 429: 1.

The cron path is the scheduler's (same retry branch) and has no test of its own.

## 6. Open questions

None.

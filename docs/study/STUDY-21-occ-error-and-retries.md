# STUDY-21 — The OCC error and mutation retries

- **Status:** implemented (this PR); D1–D3 await the owner
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:**
  - [STUDY-06](STUDY-06-transactions-and-occ.md), whose D4 (retry budget) and D5 (error) this study
    settles. Owner decision: the budget and backoff follow Convex exactly.
  - [STUDY-20](STUDY-20-function-errors-and-logs.md): how errors reach clients.

## 1. How Convex does it

### 1.1 The retry loop

`crates/application/src/application_function_runner/mod.rs`, `run_mutation_with_occ_retries`
(around line 930):

- A `Backoff` is created with `UDF_EXECUTOR_OCC_INITIAL_BACKOFF` (100 ms) and
  `UDF_EXECUTOR_OCC_MAX_BACKOFF` (2 s) (`crates/common/src/knobs.rs`, env-overridable).
- Each iteration runs the mutation in a new transaction at the latest snapshot, then commits.
- A commit error with `occ_info()` retries while `backoff.failures() < UDF_EXECUTOR_OCC_MAX_RETRIES`
  (4). That is at most **5 executions**. Before retrying, it:
  1. sleeps `backoff.fail(rng)`;
  2. waits for the conflicting write's timestamp (`database.wait_for_write_ts(write_ts)`). The conflict
     may be against a *pending* write, validated but not yet published, and re-running before it is
     visible would lose to it again.
- A `TooManyWrites` error is retried the same way, within the same budget.
- Once the budget is spent, the OCC error is returned as-is: an `anyhow` error carrying
  `ErrorMetadata`, not a `JsError`.

`Backoff::fail` (`crates/convex/sync_types/src/backoff.rs`) is full jitter:
`min(initial × 2^failures, max) × U[0, 1)`. The successive caps are 100, 200, 400 and 800 ms (and 1.6 s,
then 2 s, for longer budgets).

### 1.2 The error

`crates/errors/src/lib.rs`, `ErrorMetadata::user_occ`:

- The code (`short_msg`) is `OptimisticConcurrencyControlFailure` (`OCC_ERROR`).
- The message is:
  > Documents read from or written to the "*table*" table changed while this mutation was being run
  > and on every subsequent retry. *write source*. See https://docs.convex.dev/error#1

  "some table" stands in when the table is unknown.
- The write source is `occ_write_source_string` (`crates/database/src/database.rs`):
  - `A call to "<mutation>" changed the document with ID "<id>"`;
  - or `Another call to this mutation changed …` when the writer is the same function.

  It is present only when the conflicting write's source is known, and names the document the
  conflicting commit wrote inside the read-set (`ConflictingReadWithWriteSource::into_error`).
- System-table conflicts get a longer internal message. They are not user-facing.
- `ErrorCode::OCC` maps to **HTTP 503** (`http_status`). The HTTP API returns it through
  `HttpResponseError`: status 503, body `{"code":"OptimisticConcurrencyControlFailure","message":…}`.
- **Over the WebSocket**, `execute_public_mutation(...).await?` makes the mutation future fail, and the
  sync worker's `m?` ends the connection (`crates/sync/src/worker.rs`). The client reconnects and
  re-sends the pending mutation.
- **Inside an action**, `ctx.runMutation` throws, and the action may catch it. Uncaught, it is the
  action's error.

## 2. What an app can observe

1. A mutation losing every race runs **5 times**, with backoff of up to 100/200/400/800 ms, jittered,
   between runs.
2. Then HTTP answers 503 `{code: "OptimisticConcurrencyControlFailure", message}`, with the message
   above.
3. Contended mutations take tens to hundreds of milliseconds, not microseconds.

## 3. How bunvex does it

- `packages/core/src/engine.ts`:
  - `OCC_MAX_RETRIES = 4`, `OCC_INITIAL_BACKOFF_MS = 100`, `OCC_MAX_BACKOFF_MS = 2000`;
  - `occBackoffMs(failures, initial, max)` is full jitter;
  - `Engine` options `maxRetries`, `occInitialBackoffMs` and `occMaxBackoffMs` stand in for Convex's
    env knobs.
- The retry loop sleeps, then `committer.waitForVisible(conflict.writeTs)`. This is bunvex's
  `wait_for_write_ts`: a commit that lost to an earlier commit of the **same group** (applied, not yet
  flushed) waits for that group to become visible.
- `ConflictError` carries the conflict: the write's ts, index and document id, and its write source.
  `LogEntry` keeps each write's document id and the commit's source.
  - `engine.mutation(body, source?)` takes the write source.
  - The server passes the function name (a one-line hook in `functions.ts`).
- `OccError` (`code = "OptimisticConcurrencyControlFailure"`) has Convex's message, without the
  documentation link (bunvex never links to Convex's docs). The table is resolved from the catalog.
- The server:
  - HTTP `/api/mutation` answers **503** `{code, message}`;
  - inside an action, the error is an ordinary exception, so the action answers the usual function
    error;
  - a WebSocket mutation gets `res {id, e}` with the message (D2).
- The conformance suite's K3 (lost-update detection under 64-way contention) keeps a large budget with
  millisecond backoff through the new options. It checks durability, not Convex's latency. Its give-up
  error is now `OccError`.

Found along the way: `Committer.drain` could miss a commit queued in the microtask chain of the
previous commit's resolution. `running` was still true, so no drain was scheduled, and the commit waited
forever. `drain` now re-checks the queue when it finishes. A test covers it.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| D1 | The message has no `See https://docs.convex.dev/error#1` suffix | bunvex never links to Convex's docs (project rule) | accepted (owner, 2026-09-30; DV-81) |
| D2 | A WebSocket mutation that exhausts its budget gets an error result; Convex ends the connection, and the client re-sends the mutation after reconnecting | Ending the connection only makes sense with protocol v1's idempotent re-send (session + request ids); without it, a re-send could run twice | owner (with protocol v1) |
| D3 | `TooManyWrites` is not retried within the budget | bunvex has no write-throughput limit yet | revisit with the limits |

## 5. Tests

`packages/core/test/occ.test.ts`:

- the constants and the backoff shape;
- a mutation that always loses runs exactly 5 times (4 retries), then throws `OccError` with Convex's
  code and message: table, document id, write source;
- `Another call to this mutation`;
- `maxRetries` is honoured, and the default backoff really sleeps on a 100 ms scale;
- a conflict reports the write it lost to, and `waitForVisible` works;
- a retry waits for the winner of its own group: 2 runs, not 3.

`packages/core/test/committer.test.ts`: the lost-wake-up regression.

`packages/server/test/occ.test.ts`: 503 over HTTP, and a function error inside an action.

Sabotage:

| Broken | Result |
|---|---|
| Budget 30 | 2 tests fail |
| The old ≤20 ms backoff | 1 fails |
| No wait for the winner | 1 fails (3 runs) |
| No re-drain | 2 fail (one hangs) |
| No 503 branch | 1 fails |

## 6. Open questions

1. D1–D3.

# STUDY-75 — Logging a sync query served without running

- **Status:** implemented; no divergence.
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-03
- **Related:**
  - [STUDY-74](STUDY-74-function-execution-fields.md) (`run_reason`), which found this gap;
  - [STUDY-47](STUDY-47-log-streaming.md) (the function log);
  - [STUDY-64](STUDY-64-sync-load.md) (bunvex's shared sync runs).

## 1. How Convex does it

Sources: `crates/sync/src/worker.rs` (`begin_update_queries`), `crates/application/src/cache/mod.rs`,
`crates/application/src/function_log.rs` (`log_query`).

- **Queries that need an answer.** A sync worker answers every query of a transition that has no still-valid
  subscription. A subscription still valid at the new ts is `Reusable`: it is refreshed, not run, and nothing
  is logged.
- **The cache.** Every other query goes through the query cache (`CacheManager::get`), and the cache always
  logs it (`log_query`, cache/mod.rs 528–538), whether it ran or not. `is_cache_hit` is true when:
  - the result was ready in the cache (`CacheOp::Ready`);
  - it waited for another caller's run of the same key (`CacheOp::Wait`).
- **A hit's log** is a `function_execution`, and a function log Completion, with:
  - `cached: true`;
  - the cached run's log lines (also as `console` events);
  - the result's bytes, no usage;
  - this caller's `run_reason` (STUDY-74).
- **Errors are never cached** (only `Ok` outcomes are stored). A query whose shared run failed runs again and
  logs its own failure.

## 2. What an app can observe

- `/api/stream_function_logs` (`bunvex logs`, the dashboard) shows one entry per client query answer.
- Log streams count one `function_execution` per answer.
- A cached answer reads `cached: true` with the lines the run printed.

## 3. How bunvex does it

- bunvex's sync hub shares runs between sessions (STUDY-64):
  - a result still valid for the key is reused (`resultAt`);
  - a session asking for a key already running joins that run (`flight`).
- Neither case was logged. A second session subscribing to a query produced no log entry.
- Now each case logs as Convex's cache does (`SyncHub.logReuse`):
  - a reused result, or a join that is served, logs a cache hit through `functions.logged` with:
    - `cachedQueryLogs.replay` of the lines the run kept (`Execution.logged`, captured with the query
      cache's `wrap`);
    - the run's result bytes;
    - the session's run reason.
  - a reused failure is logged as a failed run, not a hit.
- A query whose own subscription is still valid is never stale in bunvex's transition, so it is neither run
  nor logged, as Convex's `Reusable`.
- **Measured.** 100 sessions subscribing to one query: the first round, with 99 hits now logged, takes
  14–17 ms against 11–12 ms (about 30 µs a hit). Later rounds are unchanged (6 ms).

## 4. Divergences

None. bunvex keeps sharing a failed result between sessions instead of running the query again for each.
The client sees the same error; the log shows a failed run per session, as Convex's does.

## 5. Tests

`packages/server/test/sync-cache-hits.test.ts`:

- a second session reusing a result (the log stream event and the function log entry, with the lines);
- a session joining a run in flight (held on a store read);
- a reused failure;
- a session whose identity changed reusing another session's run under that identity (`identityChange`,
  a hit).

Sabotage checks, each failing a test:

- reuse at the stored key;
- reuse by the base key;
- the flight join;
- a failure logged as a hit;
- the kept lines.

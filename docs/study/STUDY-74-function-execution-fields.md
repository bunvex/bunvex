# STUDY-74 — The `function_execution` fields DV-305 left out

- **Status:** implemented. Owner decisions (2026-10-03):
  - arguments measured re-serialized (DV-320);
  - the lost OCC attempt's returned value measured, as Convex.
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-03
- **Related:** [STUDY-59](STUDY-59-log-streams.md) (the event; DV-305), [STUDY-70](STUDY-70-provider-sinks.md),
  [STUDY-47](STUDY-47-log-streaming.md) (the function log)

## 1. How Convex does it

Sources: `crates/common/src/log_streaming.rs` (the event, `FunctionRunReason`), `crates/application/src/function_log.rs`,
`crates/sync/src/worker.rs` (`begin_update_queries`), `crates/application/src/application_function_runner/mod.rs`
(`_retry_mutation`), `crates/application/src/scheduled_jobs/mod.rs`, `crates/application/src/cron_jobs/mod.rs`.

- **`run_reason`** (`FunctionRunReason::new`):
  - from the caller: `webSocket`, `httpApi`, `httpEndpoint`, `cron`, `scheduler`, `action`, `tester`;
  - for a sync query, from its `QueryInvocation` (`worker.rs` 1100–1120):
    - a query never run is `initialSubscription`;
    - one that ran before reruns as `identityChange` when the client authenticated since (every
      `Authenticate` bumps the identity version), else as `dataChange`;
  - a result still valid is reused without a run, and nothing is logged;
  - a cache hit is logged (`cached: true`) with the reason a miss would have had.
  - Only in log streams, not in `/api/stream_function_logs`.
- **`scheduler_info`**: `{job_id}`, the `_scheduled_functions` document's id, when the caller is the
  scheduler; otherwise null (crons, and functions an action calls).
- **`function_args_bytes`**: the length of the arguments' JSON array as received (`SerializedArgs`). For a
  scheduled or cron job it is the stored bytes; for an HTTP action it is null.
  - **`function_returns_bytes`**: the packed result's length; null for an error.
- **`mutation_retry_count`**: every mutation's attempt number (`backoff.failures()`), 0 for the first; null
  for the rest.
  - The scheduler and crons count across their own retry loops.
  - An attempt that lost an OCC conflict and will retry is logged *before* its outcome is failed:
    `status: "success"`, `error_message: null`, its `occ_info`, `will_retry: true`, and its returned value's
    bytes.
- **`mutation_queue_length`**: a WebSocket mutation's queue on arrival — the mutations still waiting in the
  channel, not the running one; null for every other caller.

## 2. What an app can observe

The log streams' `function_execution` events (a webhook, Datadog, …), and for the lost OCC attempt also the
function log's `error` (null) and `returnBytes`.

## 3. How bunvex does it

- **`run_reason`.** The sync transition marks each query it runs: `initialSubscription` when it was never
  answered, `identityChange` when the identity changed since the last transition, else `dataChange` (also a
  module push, as Convex's `None if has_run_before`). The mark rides on the caller (`SourcedCaller.runReason`)
  to the log. A run shared between sessions (bunvex's in-flight join) carries the reason of the session that
  started it.
- **`scheduler_info`**: the caller's `scheduledFunctionId` when it is the scheduler.
- **`function_args_bytes`**: `JSON.stringify([args])` in the export encoding, measured where the run is logged
  (`logged(…, args)`); none for an HTTP action (DV-320).
- **Retries.** `Running.retries` counts a mutation's lost attempts. It is shared by the runs of a scheduled
  or cron job's loop (`SourcedCaller.retries`), and those loops' escaped OCC errors are logged with
  `willRetry` (`retriesOcc`).
  - A lost attempt has no error. `OccError.attempt` keeps what it returned, so its returned bytes are logged.
- **`mutation_queue_length`**: on arrival, the session's pending mutations minus the running one (the same
  count as the 1000-mutation limit).

## 4. Divergences

| # | Topic | Convex | bunvex | Why | Decision |
|---|---|---|---|---|---|
| F1 | `function_args_bytes` | the raw JSON text as received | the arguments re-serialized compactly | Não dá pra fazer igual without carrying every path's raw text: arguments arrive decoded. Equal for every official client (compact JSON); a hand-written HTTP body with spaces counts fewer bytes | DV-320, owner, 2026-10-03 (as recommended) |

Found, then fixed in [STUDY-75](STUDY-75-sync-cache-hit-logs.md): a sync query served from another session's
run was not logged; it now logs a cache hit, as Convex's query cache does.

## 5. Tests

`packages/server/test/function-execution-fields.test.ts`:

- a sync query's three reasons, and an HTTP query's;
- `scheduler_info` of a scheduled job, none for its scheduler;
- arguments' bytes, none for an HTTP action;
- retry counts, the lost attempt's empty error and returned bytes;
- a scheduled job's conflict retried inside the engine and escaping it (`maxRetries: 0`);
- queue lengths with the first mutation held on a store read, none over HTTP.

`function-log.test.ts`: the lost attempt's `error` is null.

Sabotage checks, each failing a test:

- the identity and initial reasons;
- `scheduler_info`;
- an HTTP action's arguments;
- the arguments' array;
- the retry count, and retries for mutations only;
- the lost attempt's error and returned bytes;
- `retriesOcc`, the shared counter, the count after an escaped conflict;
- the queue length, and none over HTTP.

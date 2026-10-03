# STUDY-47 — Function log streaming

- **Status:** decision pending (owner): L1–L5; PR 1 implements the recommendations
- **Convex source read:** `main` of get-convex/convex-backend, 2026-10-02
- **Related:** [STUDY-20](STUDY-20-function-errors-and-logs.md) (log lines), [STUDY-30](STUDY-30-scheduler-and-crons.md)
  (scheduled and cron runs), [STUDY-37](STUDY-37-cli-and-environment-variables.md) (`dev --tail-logs`),
  [STUDY-44](STUDY-44-ctx-meta.md) (request ids), roadmap item 12. Closes DV-77, DV-141 and DV-184.

## 1. How Convex does it

### 1.1 The function execution log

`crates/application/src/function_log.rs` keeps the deployment's recent function executions in memory:

- `FunctionExecutionLog` holds a `VecDeque<(CursorMs, FunctionExecutionPart)>` of at most
  `MAX_UDF_EXECUTION` = 1000 parts. The oldest part goes when a new one would exceed it. Nothing is
  persisted: a restart starts empty.
- A part is either a **Completion** (`FunctionExecution`) or a **Progress** event (log lines an action or
  HTTP action printed while it ran).
- The cursor is wall-clock milliseconds as an `f64`, strictly increasing: a part logged in the same
  millisecond as the previous one gets the next representable float (`next_time`, `f64::next_up`).
- What gets logged:
  - `log_query`, `log_mutation`, `log_action`, `log_http_action` and their `*_system_error` variants: one
    Completion per execution.
  - `log_mutation_occ_error`: a mutation attempt that hit an OCC conflict is a Completion of its own, with
    `occ_info` (table, document, write source, retry count) and `will_retry` — true when the runner retries
    it (`application_function_runner/mod.rs`, the retry loop around `commit_with_write_source`).
  - `log_action_progress`, `log_http_action_progress`: a Progress part with the lines an action printed,
    as it prints them.
  - Executions of system functions (`_system/…`) are not logged (`if outcome.path.is_system() { return }`).
- Readers:
  - `stream(cursor)`: the Completions after `cursor`, with their lines; waits while there is no part after
    it. The new cursor is the last part's, Progress parts included.
  - `stream_parts(cursor)`: Completions and Progress parts after `cursor`. A Completion of an action or HTTP
    action comes **without** its log lines, which already went out as Progress parts, so each line appears
    once.
- Reading needs `DeploymentOp::ViewLogs` (`Application::function_log`).

### 1.2 The HTTP endpoints

`crates/local_backend/src/logs.rs`, routed in `router.rs` under `/api/` and under `/api/app_metrics/`:

| Route | Reader | Lines |
|---|---|---|
| `GET /api/stream_udf_execution?cursor=` | `stream` | strings |
| `GET /api/stream_function_logs?cursor=[&sessionId=&clientRequestCounter=]` | `stream_parts` | structured for the CLI and dashboard |
| The same two under `/api/app_metrics/` | same | same |

- Long poll: the handler answers as soon as the reader returns, or after **60 s** with
  `{entries: [], newCursor: cursor}`.
- `sessionId` + `clientRequestCounter`: keep only the parts of the **root** execution of that WebSocket
  request. Its request id is `RequestId::new_for_ws_session`: the first 16 hex characters of
  SHA-256(`"<sessionId>|<counter>"`) (`crates/common/src/execution_context.rs`).
- Structured lines only when the `Convex-Client` header names the CLI (`npm-cli-…`) or the dashboard
  (`dashboard-…`); every other client gets the pretty string `"[LEVEL] message"` (with
  `" (truncated due to length)"` when cut). `stream_udf_execution` always sends strings.
- Response: `{entries, newCursor}`.

### 1.3 The entry format

`FunctionExecutionJson` (`crates/common/src/log_streaming.rs`), tagged by `kind`, camelCase:

**Completion** (`execution_to_json`):

| Field | Value |
|---|---|
| `udfType` | `"Query"`, `"Mutation"`, `"Action"`, `"HttpAction"` |
| `componentPath` | `null` for the root app |
| `identifier` | the stripped path (`messages:send`, no `.js`); for an HTTP action the route, `"<METHOD> <path>"` |
| `logLines` | the lines (§1.2 forms) |
| `timestamp` | when the completion was logged, seconds (f64) |
| `cachedResult` | a query answered from the cache |
| `executionTime` | seconds (f64) |
| `userExecutionTime` | seconds, or `null` |
| `caller` | `FunctionCaller`'s name: `SyncWorker`, `HttpApi`, `Tester`, `HttpEndpoint`, `Cron`, `Scheduler`, `Action` |
| `parentExecutionId` | the calling action's execution id, for a function an action ran |
| `success` | `null` for functions; `{status: "<code>"}` for a successful HTTP action |
| `error` | the error's display, or `null` |
| `requestId`, `executionId` | the execution context |
| `usageStats` | `databaseReadBytes`, `databaseWriteBytes`, `databaseIoReadBytes`, `databaseIoWriteBytes`, `databaseReadDocuments`, `databaseWriteDocuments`, `databaseWriteIndexRows`, `storageReadBytes`, `storageWriteBytes`, `vectorIndexReadBytes`, `vectorIndexWriteBytes`, `textIndexQueryBytes`, `textIndexWriteQueryBytes`, `vectorIndexReadQueryBytes`, `vectorIndexWriteQueryBytes`, `networkEgressBytes`, `memoryUsedMb` |
| `returnBytes` | the result's `heap_size()`; `null` for an HTTP action or an error |
| `occInfo` | `{tableName, documentId, writeSource, componentPath, retryCount}` or `null` |
| `willRetry` | for an OCC attempt |
| `executionTimestamp` | when the execution started, seconds |
| `identityType` | `Identity::tag()`: `system`, `instance_admin`, `unknown`, `user`, `member_acting_user`, `team_acting_user` |
| `environment` | `"isolate"` or `"node"` |

Scheduled and cron runs execute as `Identity::Unknown` (`scheduled_jobs/mod.rs`, `cron_jobs/mod.rs`).

**Progress**: `udfType`, `componentPath`, `identifier`, `timestamp` (the function's start, seconds),
`logLines`, `requestId`, `executionId`.

A structured line (`crates/common/src/log_lines.rs`, `to_json`): `{messages, isTruncated, timestamp (ms),
level}`; system metadata is not sent on these endpoints.

### 1.4 The CLI

`npm-packages/convex/src/cli/logs.ts` and `cli/lib/logs.ts`:

- `convex logs [--history [n]] [--success] [--jsonl]` polls `/api/stream_function_logs?cursor=` in a loop.
  The first poll only fetches the head cursor; its entries are printed only with `--history` (all of
  them, or the last `n`). On failure it backs off (`nextBackoff`), warning after 5 failures; a 403 stops it.
  `--tail` is a deprecated alias of `--history`.
- Each line prints as `<toLocaleString(timestamp)> [CONVEX <Q|M|A|H>(<identifier>)] [LEVEL] message` (cyan
  prefix); an error as the same prefix and the error in red; with `--success`, a Completion without error
  prints `… Function executed in <ceil ms> ms` in green. `--jsonl` prints each entry as JSON.
- `convex dev --tail-logs [always|pause-on-deploy|disable]` (default `pause-on-deploy`) runs the same loop
  to stderr, holding output back while a push is running.
- `Watching logs for dev deployment <name>...` in yellow on stderr first.

## 2. What an app can observe

- The deployment's recent executions, through the endpoints above, with the fields of §1.3; nothing from
  system functions; nothing older than the last 1000 parts or the last restart.
- Which request a line belongs to (`requestId`), and for a WebSocket request, by `sessionId` and counter.
- A function's `console.*` output does not appear on the backend's own output; developers see it through
  `logs`, `dev` and the dashboard.

## 3. How bunvex does it

### 3.1 Server (PR 1)

- `packages/server/src/function-log.ts`: `FunctionLog`, the ring of 1000 parts with the strictly increasing
  ms cursor, `stream` and `streamParts` with waiters, and the JSON of §1.3.
- `logs.ts` keeps lines structured (`{level, messages, isTruncated, timestamp}`) and renders the strings
  clients already get from them. An invocation's execution tree gains an **owner**: the logged execution
  a line belongs to. A function an action calls is its own logged execution; its lines still nest in the
  action's lines returned to the client, as STUDY-20 decided.
- `Functions` wraps every non-system execution (HTTP API, sync, scheduler, crons, HTTP actions, and what
  an action calls) in `logged(...)`: execution id, request id, caller, start, end, error, cache hit,
  usage from the transaction, OCC attempts (an engine hook called from its retry loop).
- WebSocket mutations and actions get Convex's request id (SHA-256 of `"<sessionId>|<counter>"`), so
  `ctx.meta` and the logs agree with Convex and the `sessionId` filter works.
- The routes of §1.2, behind `ViewLogs`, long poll 60 s.

**As built (PR 1).** Every item above. Scheduled and cron runs' lines are now captured too (they were
not: DV-141 resolved). Measured on an M-series laptop, in-process (`collectLogs` around `Functions`, 20 000
calls, four rounds): a cached query goes from about 1.0 µs to 2.3 µs per call with the log on (an execution
id, two clock reads, the completion object, one more async-context frame); a mutation that inserts stays
within noise (18–24 µs either way). Sabotage checks: not stripping an action's lines from its Completion,
counting a nested execution's lines as the action's, dropping the OCC hook, random WebSocket request ids,
not flagging cache hits, the nested caller, an unbounded ring and missing query usage each fail a test.

### 3.2 CLI (PR 2)

- `bunvex logs` with `--history [n]`, `--success`, `--jsonl` (and `--tail` as the deprecated alias), the
  formatting of §1.4 with `BUNVEX` in place of `CONVEX` (rule 5).
- `bunvex dev --tail-logs` defaults to `pause-on-deploy` (DV-184 closes).
- The server stops printing captured lines to its own output (DV-77, DV-141 close).

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| L1 | `returnBytes` is the value's size as bunvex counts it for limits (Convex's `ConvexValue::size`), not Rust's `heap_size` | `heap_size` measures Rust memory; there is no equivalent in JS. **Not possible.** The number is close but not equal | DV-250, pending |
| L2 | `usageStats`: `databaseIoReadBytes`/`databaseIoWriteBytes` equal the read and written bytes; index rows, storage, vector, text, egress and memory are 0 | bunvex does not meter them yet. **Not done yet** | DV-251, pending |
| L3 | `userExecutionTime` equals `executionTime` | bunvex runs user code in-process; it does not split user time from system time in the log yet. **Not done yet** | DV-252, pending |
| L4 | No `Tester` caller: the dashboard's function runner runs through `/api/function` and logs as `HttpApi` | Convex's runner calls `/api/run_test_function`, which bunvex has not built. **Not done yet** | DV-253, pending |
| L5 | `environment` is always `"isolate"` | bunvex has no Node runtime for `"use node"` actions (DV recorded elsewhere). **Not possible** in one process | DV-254, pending |

Everything else matches Convex.

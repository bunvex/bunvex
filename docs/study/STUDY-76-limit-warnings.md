# STUDY-76 — Approaching-limit warnings

- **Status:** implemented. Owner decisions (2026-10-04):
  - system functions warn as Convex's;
  - an HTTP action's response-size warning came in the next PR, which logs the run once its body is sent
    (DV-323, resolved).
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-03
- **Related:**
  - [STUDY-41](STUDY-41-nested-calls-and-execution-limit.md) (the time budget);
  - [STUDY-47](STUDY-47-log-streaming.md) (log lines and the function log);
  - [STUDY-59](STUDY-59-log-streams.md) (`console` events);
  - [STUDY-71](STUDY-71-usage-metering.md) (what the read and write counts are).

## 1. How Convex does it

Sources: `crates/udf/src/warnings.rs`, `crates/isolate/src/environment/udf/mod.rs` (`add_warnings_to_log_lines`,
1374–1538), `crates/isolate/src/environment/action/mod.rs` (1228–1330), `crates/isolate/src/environment/action/task.rs`
(`name_when_dangling`), `crates/common/src/log_lines.rs`, `crates/common/src/knobs.rs`.

### 1.1 The rule and the message

- **The ratio.** `FUNCTION_LIMIT_WARNING_RATIO` defaults to 0.8. A limit warns when
  `actual > floor(ratio × limit)` and `actual <= limit`; past the limit, the error applies instead.
- **The message:** `{message} (actual: {actual}{unit}, limit: {limit}{unit}).` and then ` {suffix}` if there
  is one. The unit is ` bytes`, ` levels` or nothing.
  - The read limits' suffix is `OVER_LIMIT_HELP` ("Consider using smaller limits in your queries, …").
- **The line:** a WARN system line (`SystemLogMetadata { code: "warning:<code>" }`), never truncated, appended
  after the function's own lines.
- **Durations:** `Function execution took a long time. (maximum duration: {limit:?}, actual duration: {actual:?}).`,
  with Rust's `Duration` Debug form and the user time (pauses excluded).

### 1.2 Queries and mutations, in order

| # | Code | What is measured | Limit |
|---|---|---|---|
| 1 | `TooLargeFunctionArguments` | the arguments' size | 16 MiB |
| 2 | `TooManyDocumentsRead` | documents read | 32 000 |
| 3 | `TooManyReads` | read-set intervals | 4096 |
| 4 | `TooManyBytesRead` | bytes read | 16 MiB |
| 5 | `TooManyWrites` | documents written | 16 000 |
| 6 | `TooManyBytesWritten` | bytes written | 16 MiB |
| 7 | `TooManyFunctionsScheduled` | functions scheduled | 1000 |
| 8 | `ScheduledFunctionsArgumentsTooLarge` | total scheduled arguments | 16 MiB |
| 9 | `ScheduledFunctionsArgumentsTooLarge` | one scheduled function's arguments | 4 MiB |
| 10 | `ValueTooLargeError` | the largest written document, by id | 1 MiB |
| 11 | `TooNested` | the most nested written document, by id | 16 levels |
| 12 | `TooLargeFunctionResult` | the result, on success only | 16 MiB |
| 13 | `UserTimeout` | the user time | 1 s |

- Warning 9 has no upper bound (that limit is not enforced): over it, the message adds ". This will become a
  hard error in the future".
- **When:** they run when the function returns or throws a JS error; not on a system error.
- **Caching:** a cache hit replays the stored lines, warnings included.
- **Nested calls** get none of their own.
- **System functions** warn too: their clients get the lines, while the function log and log streams drop
  system paths.

### 1.3 Actions and HTTP actions

- **V8 actions:**
  1. `FunctionArgumentsTooLarge` ("Large size of the action arguments");
  2. the unawaited operations: "{n} unawaited operation{s}: [{names}]. Async operations should be awaited or
     they might not run. See https://docs.convex.dev/…", with code `UnawaitedOperations`. It lists the tasks
     still pending at return, by sorted name: `query`, `mutation`, `action`, `schedule`, `cancel_job`,
     `vectorSearch`, `getUserIdentity`, `storageGetUrl`, `storageGetMetadata`, `storageGenerateUploadUrl`,
     `storageDelete`, `storage.store`, `storage.get`, `fetch`;
  3. `UserTimeout` against 1800 s;
  4. `TooLargeFunctionResult` ("Large size of the action return value"), on success only.
- **Node actions:** none.
- **HTTP actions:**
  1. `HttpResponseTooLarge` (the bytes sent, against 20 MiB, once the body is sent);
  2. the unawaited operations;
  3. `UserTimeout`.

### 1.4 Where the lines go

- **The client:** over sync and the HTTP API, as `[WARN] …` strings, printed like any line.
- **The function log:** the Completion's lines. `systemMetadata` is always present and is `null` at these
  endpoints.
- **Log streams:** `console` events with `system_code: "warning:…"`.
- **Not app-visible:** `TRANSACTION_WARN_READ_SET_INTERVALS` (3072) only feeds a server trace.

## 2. What an app can observe

- A developer sees `[WARN] Many documents read …` and similar lines in the browser console, `bunvex logs` and
  log streams before a function hits a limit.
- A log stream can filter them by `system_code`.

## 3. How bunvex does it

- **`limit-warnings.ts`.** Convex's rule, messages, order and codes, with the ratio knob.
- **Measured from:**
  - the transaction's counts (`Tx.usage`: documents and bytes read as Convex counts them since STUDY-71, read
    intervals, writes, scheduling);
  - `Tx.scheduledMaxBytes`;
  - `Tx.biggestWrites()` (the final versions, measured when each write was checked against the limits);
  - the arguments and result sizes the limits already use;
  - the user timer (STUDY-41, STUDY-71).
- **Lines:** `logSystemLine` adds a line with `systemCode`. The line cap keeps system lines past the user's
  256. `console` events carry `system_code`, and the function log's structured lines carry
  `systemMetadata: null`.
- **Actions:** the context's operations count as pending until they settle (`trackedCtx`, Convex's names);
  `fetch` is counted through the core's fetch hook, which now also reports failures. Node actions get none.
- **HTTP actions** are logged once their response is sent, as Convex's (the PR after the first; DV-323
  resolved):
  - `runHttpAction` streams the body through `meteredBody` (`http-body.ts`), on demand as the client reads.
  - A chunk that would cross 20 MiB is dropped with Convex's `error:httpAction` line ("HttpResponseTooLarge:
    HTTP actions support responses up to 20 MiB"). Later chunks that fit still go, as Convex's streamer
    sends them; bunvex used to end the body there.
  - A body that fails is reported the same way.
  - When the body has ended, the run's lines get the response-size warning, the unawaited operations and
    the duration, and the run is logged. `logged`'s `settled` option defers it.
  - A HEAD request, a 408 or a client that goes away cancels the body, which settles it too.
  - Cost: about 5 µs per small response (95 → 100 µs); a 10 MiB response is unchanged (4.5 ms).
- **System functions** run under a timer that measures their user time but never fails them (they have no
  budget in bunvex), and warn as Convex's.
- **Measured:**
  - 1000 inserts: 15–16 ms before and after (sizes are reused from the write check; a first version that
    measured again cost 4–7 %);
  - a small query: 36 µs both.

## 4. Divergences

| # | Topic | Convex | bunvex | Why | Decision |
|---|---|---|---|---|---|
| W1 | Unawaited-operations message | ends with a docs link | no link | DV-04 | — |
| W2 | HTTP action response size | warns, and logs the 20 MiB error, in the run's lines once the body is sent | the same (the next PR) | Resolved | DV-323, owner, 2026-10-04 |
| W3 | System functions' duration | their user time against 1 s | the same, measured by a timer that never fails them | They have no budget in bunvex (not a divergence in the warning) | — |

## 5. Tests

`packages/server/test/limit-warnings.test.ts`:

- a query's read, argument and result warnings in Convex's words after its own lines, and their
  `system_code`;
- the threshold at 2048/2049 read intervals with a 0.5 ratio;
- a mutation's write, scheduling and biggest-document warnings by id;
- an app error still warns;
- warnings kept past 256 lines;
- the duration's form;
- an action's four warnings, with the unawaited `[fetch, query]`;
- a Node action has none;
- nothing at the default ratio;
- a system function's warnings.

Sabotage checks, each failing a test:

- the strict threshold;
- the default ratio;
- the help suffix;
- plural and sorted names;
- system lines past the cap;
- `system_code`;
- warnings on an app error;
- Node actions;
- the pending `fetch`;
- the nesting;
- system functions' warnings.

`packages/server/test/http-action-response-log.test.ts` (the next PR):

- the run is logged once its body is sent, its time covering the body;
- the size warning;
- a chunk past 20 MiB dropped with the error line while a later one still goes;
- a failing body;
- HEAD and an aborted client, also with a body that never ends.

Sabotage checks, each failing a test:

- deferred logging;
- later chunks;
- the overflow line, the stream-error line and its code;
- cancellation settling;
- HEAD cancelling;
- the size warning.

Pulling only on demand is not observable by these tests: it spares reading a body ahead of the client.

# STUDY-20 — Function errors, redaction and log lines

- **Status:** implemented; divergences D1–D8 decided by the owner (2026-09-30), D9 accepted (owner, 2026-10-04, DV-321), D8 built to match Convex (2026-10-03, §4.1); D3 and D6 resolved with protocol v1 (#50, v0 deleted in #94)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:**
  - [STUDY-11](STUDY-11-function-results-and-errors.md): the retroactive study of results and errors. This
    study settles its D1, D2, D3 and D7.
  - [STUDY-06](STUDY-06-transactions-and-occ.md): the OCC error, which is also a function error.
  - Owner decision: the app error class is `BunvexError` (Convex's `ConvexError`).

## 1. How Convex does it

### 1.1 `ConvexError`

`npm-packages/convex/src/values/errors.ts`:

- `class ConvexError<TData extends Value> extends Error`, with `name = "ConvexError"` and a `data` field.
- The constructor's message is `data` when it is a string, otherwise `stringifyValueForError(data)`.
- The class is tagged with `Symbol.for("ConvexError")` as an own property, so an error from another copy
  of the package is still recognised (no `instanceof`).

When a function throws, `invokeFunction` (`npm-packages/convex/src/server/impl/registration_impl.ts`,
`serializeConvexErrorData`) replaces a tagged error's `data` with `JSON.stringify(convexToJson(data ??
null))` and sets `ConvexErrorSymbol`. The isolate (`crates/isolate/src/error.rs`,
`extract_source_mapped_error`) then:

- builds the message from `error.name` and `error.message` with `format_uncaught_error`
  (`crates/isolate/src/helpers.rs`): `Uncaught <name>: <message>`, or `Uncaught <name>`, `Uncaught
  <message>`, `Uncaught`;
- reads the frames (source-mapped) and, for a tagged error, parses `data` back into a value
  (`deserialize_udf_custom_error`). If `data` is not a valid value, the error becomes `ConvexError with
  invalid data: <why>` and carries no data.

A thrown value that is not an `Error` falls back to V8's message (`Uncaught foo` for `throw "foo"`).

`JsError`'s display (`crates/common/src/errors.rs`) is the message, a newline, then one line per frame,
each ending with a newline.

### 1.2 Redaction

`crates/application/src/redaction.rs`, `RedactedJsError`:

- The client-facing message is `[Request ID: <id>] Server Error`, followed by `\n<JsError>` unless logs
  are blocked.
- `custom_data_if_any()` — the `ConvexError` data — is sent whatever the redaction.
- `RedactedLogLines::from_log_lines` returns **no lines** when logs are blocked.
- The request id is 16 hex characters (`RequestId::new`, `crates/common/src/execution_context.rs`), or a
  hash of session id and WebSocket request id for sync requests.

Whether to block comes from `LogVisibility`. The self-hosted backend uses `RedactLogsToClient`
(`crates/application/src/log_visibility.rs`), driven by `--redact-logs-to-client`
(`crates/local_backend/src/config.rs`, **default false**), which the Docker image sets from
`REDACT_LOGS_TO_CLIENT` (`self-hosted/docker-build/run_backend.sh`: any non-empty value enables it).
Convex's cloud redacts production deployments. So self-hosted Convex shows details by default.

### 1.3 The HTTP API

`crates/local_backend/src/public_api.rs`:

- `UdfResponse` is tagged by `status`:
  - `{"status":"success","value":…,"logLines":[…]}`
  - `{"status":"error","errorMessage":"…","errorData":…,"logLines":[…]}`

  `logLines` is omitted when empty, `errorData` when there is none. `errorMessage` is the
  `RedactedJsError` display.
- **A function error answers HTTP 200.** Every handler returns `Ok(Json(response))` for both variants.
  The npm client (`npm-packages/convex/src/browser/http_client.ts`) also accepts status **560**
  (`STATUS_CODE_UDF_FAILED`, "must match the constant of the same name in the backend"), but no such
  constant exists in the open-source backend. 560 is what the hosted service answers. The node executor
  (`npm-packages/node-executor/src/syscalls.ts`) treats 560 as "the function failed, do not retry" and
  other 5xx as transient.
- Request-level failures go through `HttpResponseError` (`crates/common/src/http/mod.rs`), with body
  `{"code": "...", "message": "..."}`. Examples: `BadJsonBody` (400, `crates/common/src/http/extract.rs`),
  and system failures (500, code `InternalServerError`, message "Your request couldn't be completed. Try
  again later." — `INTERNAL_SERVER_ERROR_MSG`, `crates/errors/src/lib.rs`).
- `args` is `UdfArgsJson`: an object, or an array holding one object. The npm client sends
  `args: [convexToJson(args)]`.

### 1.4 WebSocket

`crates/sync/src/worker.rs`:

- `MutationResponse { request_id, result: Ok(value) | Err(ErrorPayload), ts, log_lines }`, where
  `ErrorPayload` is `Message(msg)` or `ErrorData { message, data }` (`RedactedJsError::into_error_payload`).
- A system error (`?` on the execution) fails the worker, and the connection closes.
- `QueryFailed` carries `errorMessage`, `errorData` and `logLines`.

### 1.5 Log lines

- `console.*` in the isolate (`npm-packages/udf-runtime/src/02_console.ts`) renders each argument with
  `object-inspect` (`maxStringLength: 32768, indent: 2, customInspect: true`) and sends the level and the
  rendered strings to the backend (`crates/isolate/src/ops/console.rs`).
  - Levels: `debug` DEBUG, `error` ERROR, `info` INFO, `log` LOG, `warn` WARN.
  - `trace` logs at LOG level, with the frames after a newline.
  - `time` / `timeLog` / `timeEnd` log at INFO level: `<label>: <n>ms`. An unknown or duplicate label
    gives a WARN line: `Timer '<label>' does not exist` / `already exists`. Timers use the real clock.
- A line is `[LEVEL] msg1 msg2 …` (`LogLineStructured::to_pretty_string`, `crates/common/src/log_lines.rs`).
  Messages beyond `MAX_LOG_LINE_LENGTH` = 32768 bytes are cut, and the line gets the suffix
  ` (truncated due to length)`.
- At most `MAX_LOG_LINES` = 256 lines per execution (`crates/isolate/src/environment/helpers/mod.rs`).
  The 256th slot holds `[ERROR] Log overflow (maximum 256). Remaining log lines omitted.`, and everything
  after it is dropped (`emit_log_line`, `crates/isolate/src/environment/udf/mod.rs`).
- A function called from an action nests its lines in the action's (`LogLine::SubFunction`), flattened
  in order for the client.
- A mutation retried after an OCC conflict runs again in a fresh isolate. Only the attempt that
  committed produces the returned lines.
- The query cache stores an execution's lines with its result and returns them on a hit
  (`crates/application/src/cache/mod.rs`).

### 1.6 What `console.log` prints of an object the function holds

- object-inspect with `customInspect: true` and its defaults otherwise: depth 5 (deeper objects print as
  `[Object]` / `[Array]`), cycles as `[Circular]`, own enumerable keys (getters run), a class instance as
  `Name { … }` with its fields, an `Error` as `[Error: msg]` plus its own keys, `Map` / `Set` with their
  entries. `toJSON` is never called. An object with an `inspect()` method prints what it returns.
  object-inspect's `util.inspect.custom` hook is inert there: the isolate has no `util`
  (object-inspect's `browser` field maps `./util.inspect.js` to nothing).
- The cost is bounded by the line, not by the value: the whole value is rendered, then the backend cuts the
  line at 32 KiB (§1.5).
- What a function holds of the engine is a thin JS shell over syscalls
  (`npm-packages/convex/src/server/impl/database_impl.ts`, `query_impl.ts`): `ctx.db` is an object literal
  of closures (`{ get: [Function: get], query: [Function: query], … }`), `db.table(t)` a
  `TableReader { tableName, isSystem }`, a query a `QueryInitializerImpl { tableName }` or a
  `QueryImpl { state }` holding its own serialized description. The engine itself is in Rust, out of the
  isolate's reach: **nothing a function can log holds the database's state**.

## 2. What an app can observe

1. `throw new ConvexError(data)` reaches the caller with `data` intact: HTTP `errorData`, WebSocket
   `ErrorData`. The message is the data, stringified.
2. Any function error answers HTTP 200 with `status: "error"`, and `errorMessage` =
   `[Request ID: <16 hex>] Server Error` + `\nUncaught <Name>: <message>\n<frames>` unless redacted.
3. With redaction on, the message is only `[Request ID: …] Server Error`, `logLines` disappear, and
   `errorData` stays.
4. `console.*` output comes back as `logLines`, rendered by object-inspect, limited to 256 lines of
   32 KiB each. Logging `ctx`, `ctx.db` or a query shows its methods or its own description, never other
   data than the function's.
5. Request errors answer `{code, message}` with 4xx; system failures answer 500 with the fixed message.

## 3. How bunvex does it

- **`BunvexError`** (`packages/values/src/errors.ts`) has the same shape as `ConvexError`: `name`,
  `data`, a message derived from the data, and `Symbol.for("BunvexError")` as its tag. `isBunvexError`
  tests the tag.
- **Error formatting** (`packages/server/src/errors.ts`):
  - `describeUncaught` builds `Uncaught <Name>: <message>\n` plus the stack frames, one per line.
  - A `BunvexError`'s data becomes Convex JSON (`toJsonValue`). Invalid data gives `BunvexError with
    invalid data: …` with no data.
  - `clientError` applies redaction.
  - `withRequestId` prefixes `[Request ID: <16 hex>]`.
  - `CommitterStoppedError` (persistence failed) is the one **system error**: it answers 500 with Convex's
    fixed message.
- **Redaction** is the server option `redactLogsToClient`. It defaults to the `REDACT_LOGS_TO_CLIENT`
  environment variable, and is otherwise off, as in self-hosted Convex.
- **HTTP** (`packages/server/src/server.ts`):
  - A function error answers **200** `{status:"error", errorMessage, errorData?, logLines?}`, as
    Convex's backend does.
  - Request errors answer `{code, message}`: 400 `BadJsonBody`, 404 `NotFound`.
  - `args` may be an object or a one-element array.
- **WebSocket** (protocol v0 frames):
  - `res {id, v, l?}` / `res {id, e, d?, l?}`;
  - `err {k, e, d?}`.

  Subscription errors are deduplicated without the request id, as Convex's `deduplication_hash` excludes
  it. Core's `Subscriptions` now takes a `formatError` from the transport.
- **Log capture** (`packages/server/src/logs.ts`):
  - Convex gives each function its own isolate and console; bunvex shares one process. So the console
    methods are replaced once, and each call finds its invocation through an `AsyncLocalStorage` —
    the same technique as `determinism.ts`. Outside an invocation the methods are the originals.
  - Lines are rendered with the `object-inspect` package, the library Convex's runtime uses, so they
    render identically.
  - `collectLogs` wraps one invocation: an HTTP call or a WebSocket mutation.
  - `perAttempt` wraps a mutation body. The single hook in `functions.ts` makes a retry replace the
    aborted attempt's lines. Nested calls from an action keep their place in order.
  - `withoutLogs` detaches subscription runs. A re-run is triggered by some mutation's commit, inside
    that mutation's async context, and its lines must not land in that mutation's `logLines`.
  - Captured lines are still printed to the server's console, as before.
- **Engine objects print by name** (`packages/core/src/inspect.ts`, §4.2). bunvex's `ctx.db` *is* the
  transaction (`Tx`), and a query holds it: opened by object-inspect, `console.log(ctx.db)` printed the
  catalog, the store's state and other transactions' writes, ~32 KB a line, to the caller, the function log
  and the log streams. Every engine class an app can reach (`Tx`, `QueryImpl`, `SystemReader`,
  `ProjectedQuery`, `TableReader`/`TableWriter`, `Pipeline`, `ScanReads`) and the big ones behind them
  (`Engine`, `Catalog`, `Committer`, `QueryCache`, every `Persistence`, `Functions`, `FileStorage`) defines
  the `util.inspect.custom` hook, which object-inspect, `util.inspect` and `Bun.inspect` all honour, and
  prints `Name {…}`, the form DV-316 gives a non-plain object in an error message. The name is read from the
  prototype, so a Proxy over the transaction (a nested query's reader view) prints the same and runs no
  trap. App values — class instances, cycles, `Error`s, `Map`s — print exactly as before, which is Convex's.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| D1 | HTTP function errors answer **200**, as the open-source backend does. Convex's hosted service answers 560 | Both are accepted by Convex's clients. 200 is what the source we match does. Switching to 560 is a one-line change | already as Convex's open-source backend (owner, 2026-09-30; DV-58) |
| D2 | A cached query result carries no `logLines`; Convex returns the lines stored with the cache entry | The query cache lives in `core`, which knows nothing of logs. Fixing it means storing the lines in the engine's cache entry, in a follow-up | resolved: a cache hit answers the stored lines (owner, 2026-09-30; DV-74) |
| D3 | Subscription updates (`upd`/`err`) carry no log lines; Convex's `QueryUpdated`/`QueryFailed` do | Part of the protocol v1 work (Transition messages) | resolved with protocol v1 (#50; DV-75) |
| D4 | The frames are Bun's raw stack frames, including bunvex's own internal frames and absolute paths; Convex source-maps them and shows the user's modules | No bundling/source-map step exists yet. Frames only show when not redacted | later, with the deploy/bundle step (owner, 2026-09-30; DV-76) |
| D5 | Captured lines are also printed to the server's stdout; Convex's backend sends them to log streams only | bunvex has no log streaming or dashboard log view yet; stdout is where developers see them today | later, once log streaming exists (owner, 2026-09-30; DV-77) |
| D6 | A system error during a WebSocket mutation is sent as that mutation's error, with the fixed internal message; Convex fails the sync worker and the connection closes | bunvex's default `onFatal` exits the process anyway; revisit with protocol v1's `FatalError` | resolved with protocol v1: close 1011 (#50; DV-78) |
| D7 | `REDACT_LOGS_TO_CLIENT=false` or `0` leaves redaction off; Convex's Docker script enables it for any non-empty value | Avoids a surprising reading of `false` | resolved: any non-empty value, as Convex (owner, 2026-09-30; DV-79) |
| D9 | `console.log` of an engine object prints `Tx {…}`, `QueryImpl {…}`, `SystemReader {…}`, `TableReader {…}`; Convex prints its shells' closures and own fields (`{ get: [Function: get], … }`, `QueryInitializerImpl { tableName: 'items' }`) | The engine's objects are the ones the function holds; opened they print the database's state (a leak, §4.2). Same rule as an error message's `Name {…}` (DV-316) | accepted (owner, 2026-10-04); DV-321 |
| D8 | Only `CommitterStoppedError` is classified as a system error. Other internal failures (e.g. a driver error during a read) surface as function errors with their message | Convex tells them apart with `ErrorMetadata`; bunvex has no such tagging yet. The jepsen harness (#262) showed the cost: a resend whose record lookup failed was told "failed", and the first attempt then committed | **decided (owner, 2026-10-03): match Convex now** — see §4.1 (DV-80) |

### 4.1 D8 built: store failures are system errors

How Convex does it:

- A syscall's error that is not a deterministic user error is not turned into a JS exception: the isolate is
  terminated with `IsolateTerminationReason::SystemError` (`crates/isolate/src/request_scope.rs`,
  `environment/helpers/promise.rs`), so the function cannot catch it.
- The sync worker awaits the mutation with `?` (`crates/sync/src/worker.rs`): a system error fails the worker
  instead of becoming a `MutationResponse`. The WebSocket closes with `err.close_frame()`
  (`crates/local_backend/src/subs/mod.rs`): an untagged error is `CloseCode::Error` (1011) with reason
  `InternalServerError`; OCC, out of retention and overload are 1013 (`crates/errors/src/lib.rs`).
- The client reconnects and resends the mutations it got no answer for. With the same session and request id,
  `_session_requests` returns the recorded outcome when the first attempt committed.

What apps observe: a mutation is never reported failed when it may still commit. A store failure is never a
function error the app can catch or show; HTTP gets 500 with the fixed message.

How bunvex does it:

- `storeCall` (`packages/core/src/determinism.ts`), the one path from a function's `Tx` to the store, turns
  any failure into a `PersistenceReadError` and fails the execution with it (`failExecution`, as nested calls'
  system errors, STUDY-41 N6), so a `try`/`catch` in the function does not hide it.
- `isSystemError` (`packages/server/src/errors.ts`) includes it. The paths that already handled system
  errors then do Convex's: HTTP 500 `InternalServerError`; a sync mutation or action closes with 1011.
- A subscribed query whose run hits a system error closes the connection with 1011 too, instead of a
  `QueryFailed` (Convex's worker fails on it the same way); the client resubscribes on reconnect.
- Tests: `packages/server/test/system-errors.test.ts` (a resend whose lookup fails gets 1011, and the next
  resend gets the recorded outcome with one run; an uncatchable failure; a query; HTTP), and #262's jepsen
  regression "a mutation reported failed never takes effect". Sabotage: dropping `PersistenceReadError`
  from `isSystemError`, the `failExecution` call, or the query path's rethrow each fails a test.

Divergences: none left for store reads. Failures outside a function's `Tx` (the committer, the lease) were
already system errors.

Not changed here, and left to the functions rewrite: the "function not found" wording (STUDY-11 D6), the
value `format` (D4), and return-value validation before commit (D5).

### 4.2 D9: engine objects in log lines

- **The leak.** On main, `console.log(ctx.db)` in a query answered a 32 KB line (cut at the limit) holding
  the catalog with every table and index, the memory store's state and its commits, the documents another
  transaction wrote. Same for `ctx`, any query object (`query`, `withIndex`, `filter`, `order`,
  `fullTableScan`), `ctx.db.system` and a system query; in a mutation, an HTTP action's nested calls, the
  sync protocol and the function log alike. `ctx.auth`, `ctx.storage`, `ctx.scheduler` and an action's
  `ctx` were already plain objects of closures (and stay as Convex's).
- **Why a hook and not a thin `ctx.db`.** Wrapping the transaction in a Convex-like object of closures
  would print Convex's exact text, but it adds an allocation and an indirection to every database call
  for a log line's sake; the hook costs nothing outside `console.log` (it is a prototype property set once at
  load). The text of a logged engine object is not something an app can depend on in Convex either (it
  names Convex's internal classes).
- **Kept as Convex.** `IndexRangeBuilder` and `SearchFilterBuilder` (the `q` of `withIndex` /
  `withSearchIndex`) hold only the app's own arguments and print them, as Convex's builders do; errors print
  as object-inspect prints them.
- **Not a divergence.** object-inspect's `util.inspect.custom` path is live on Bun (it resolves `util`), dead
  in Convex's isolate; an app object that defines the hook prints what its hook returns on bunvex and its
  fields on Convex. Pre-existing, unchanged here; noted for completeness.

## 5. Tests

- `packages/values/test/errors.test.ts`: the class, the message derived from the data, recognition by
  the tag.
- `packages/server/test/errors.test.ts`:
  - HTTP status and body shape, and key order;
  - `errorData` in Convex JSON (bigint as `$integer`), string data, plain errors, non-`Error` throws,
    invalid data;
  - redaction (option and environment variable), with data kept and lines dropped;
  - rendering of every console level, and timers;
  - the 256-line cap and the 32 KiB cut;
  - retried mutations keep only the committed attempt's lines;
  - action nesting;
  - subscription re-runs don't leak into a mutation's lines;
  - WebSocket frames;
  - the 500 system error;
  - `{code, message}` request errors and array `args`.
- `packages/server/test/console-engine-leak.test.ts` (D9): `ctx`, `ctx.db`, `ctx.db.system`, a system
  query, `db.table()`, queries at every stage, a filter's `q`, `ctx.auth`, `ctx.storage`, `ctx.meta`,
  `ctx.scheduler`, an engine object nested in an object, a `Map` and an `Error`, in a query, a mutation,
  a nested query (the reader-view Proxy), an action and an HTTP action: no line holds the catalog, the
  store, its commits or another transaction's write; the same over the sync protocol and in the function
  log stream (`/api/stream_function_logs`, which feeds the dashboard, `bunvex logs` and the log sinks).
  App values still print as Convex's: a class instance opened, a cycle, depth 5, a ~120 KB array cut at 32 KiB.
- `packages/core/test/opaque-inspect.test.ts`: `Bun.inspect` / `util.inspect` of the engine, its store, a
  transaction, a query, `db.system`, a table scope; a Proxy's traps never run; and a scan of the files an
  app's objects come from fails on any new class that is not opaque.
- Sabotage (D9): making `opaqueToInspect` a no-op fails three server tests (the transaction's JSON is back in
  the lines); dropping only `QueryImpl` from it fails them too; adding an unmarked class to
  `system-reader.ts` fails the scan.
- Sabotage: disabling the per-attempt reset, the subscription detach, redaction, `errorData` or the
  overflow cap each fails its test.

## 6. Open questions

1. D1–D8 above.
2. Once `@bunvex/client` exists, it should rethrow `BunvexError` with `data` from `errorData`/`d`, as
   Convex's client does (`forwardErrorData`).

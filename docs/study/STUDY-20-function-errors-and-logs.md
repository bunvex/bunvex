# STUDY-20 — Function errors, redaction and log lines

- **Status:** implemented (this PR); divergences D1–D6 await the owner
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

## 2. What an app can observe

1. `throw new ConvexError(data)` reaches the caller with `data` intact: HTTP `errorData`, WebSocket
   `ErrorData`. The message is the data, stringified.
2. Any function error answers HTTP 200 with `status: "error"`, and `errorMessage` =
   `[Request ID: <16 hex>] Server Error` + `\nUncaught <Name>: <message>\n<frames>` unless redacted.
3. With redaction on, the message is only `[Request ID: …] Server Error`, `logLines` disappear, and
   `errorData` stays.
4. `console.*` output comes back as `logLines`, rendered by object-inspect, limited to 256 lines of
   32 KiB each.
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

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| D1 | HTTP function errors answer **200**, as the open-source backend does. Convex's hosted service answers 560 | Both are accepted by Convex's clients. 200 is what the source we match does. Switching to 560 is a one-line change | owner (recommendation: keep 200) |
| D2 | A cached query result carries no `logLines`; Convex returns the lines stored with the cache entry | The query cache lives in `core`, which knows nothing of logs. Fixing it means storing the lines in the engine's cache entry, in a follow-up | owner (recommendation: fix, follow-up) |
| D3 | Subscription updates (`upd`/`err`) carry no log lines; Convex's `QueryUpdated`/`QueryFailed` do | Part of the protocol v1 work (Transition messages) | owner (with protocol v1) |
| D4 | The frames are Bun's raw stack frames, including bunvex's own internal frames and absolute paths; Convex source-maps them and shows the user's modules | No bundling/source-map step exists yet. Frames only show when not redacted | owner |
| D5 | Captured lines are also printed to the server's stdout; Convex's backend sends them to log streams only | bunvex has no log streaming or dashboard log view yet; stdout is where developers see them today | owner (recommendation: keep until log streaming exists) |
| D6 | A system error during a WebSocket mutation is sent as that mutation's error, with the fixed internal message; Convex fails the sync worker and the connection closes | bunvex's default `onFatal` exits the process anyway; revisit with protocol v1's `FatalError` | owner |
| D7 | `REDACT_LOGS_TO_CLIENT=false` or `0` leaves redaction off; Convex's Docker script enables it for any non-empty value | Avoids a surprising reading of `false` | owner |
| D8 | Only `CommitterStoppedError` is classified as a system error. Other internal failures (e.g. a driver error during a read) surface as function errors with their message | Convex tells them apart with `ErrorMetadata`; bunvex has no such tagging yet | owner |

Not changed here, and left to the functions rewrite: the "function not found" wording (STUDY-11 D6), the
value `format` (D4), and return-value validation before commit (D5).

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
- Sabotage: disabling the per-attempt reset, the subscription detach, redaction, `errorData` or the
  overflow cap each fails its test.

## 6. Open questions

1. D1–D8 above.
2. Once `@bunvex/client` exists, it should rethrow `BunvexError` with `data` from `errorData`/`d`, as
   Convex's client does (`forwardErrorData`).

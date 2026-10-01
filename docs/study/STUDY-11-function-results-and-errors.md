# STUDY-11 — Function results and errors on the wire

- **Status:** draft (retroactive). The code in §3 was written before the study-first rule. D1, D2, D3 and D7
  are settled by [STUDY-20](STUDY-20-function-errors-and-logs.md), which also corrects §1.1: the backend
  answers function errors with 200, and 560 is the hosted service's status.
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **bunvex code read:** `main` at `f60e934`
- **Related:**
  - [STUDY-10](STUDY-10-documents-and-values.md): the value types.
  - [STUDY-08](STUDY-08-cache-and-subscriptions.md): the sync protocol.
  - [STUDY-06](STUDY-06-transactions-and-occ.md): the OCC error.

## 1. How Convex does it

### 1.1 The HTTP API

`crates/local_backend/src/public_api.rs`:

- The routes are `POST /api/query`, `/api/mutation`, `/api/action` and `/api/run/{path}`. The body is
  `{path, args, format?}`.
- **Arguments** are Convex-encoded JSON, decoded as `jsonToConvex` does: `{"$integer": …}` becomes a
  bigint, `{"$bytes": …}` an `ArrayBuffer`, `{"$float": …}` a special float.
- **The response** is `UdfResponse`, tagged by `status`:
  - `{"status":"success","value":…,"logLines":[…]}`
  - `{"status":"error","errorMessage":"…","errorData":…,"logLines":[…]}`

  `logLines` is omitted when empty. `errorData` is present only for a `ConvexError`.
- **A function error is returned with HTTP 200** (`Ok(Json(response))`). Only request-level failures
  (bad path syntax, auth, system errors) use 4xx/5xx through `HttpResponseError`.
- **The value format** (`crates/value/src/export.rs`, `ValueFormat`, `ClientVersion::default_format`
  in `crates/common/src/version.rs`):
  - `json` (`ConvexCleanJSON`) is the default for current and unrecognised clients. It is lossy:
    int64 → a decimal **string**, NaN/±Infinity → `"NaN"`/`"Infinity"`/`"-Infinity"`, bytes →
    a base64 **string**.
  - `convex_encoded_json` is lossless: `$integer`, `$float`, `$bytes`. The WebSocket protocol uses
    it, and so do old npm clients.
  - `/api/run/{path}` defaults to clean JSON when no format is given. The other routes use the
    client-version default.

### 1.2 Error messages

- A thrown JS error becomes `Uncaught <Name>: <message>` (`crates/isolate/src/helpers.rs`), with its
  stack trace.
- On the way out, `RedactedJsError`'s `Display` (`crates/application/src/redaction.rs`) prefixes
  `[Request ID: <id>] Server Error`. It appends the message and stack only when the deployment does
  not redact (`block_logging` false). A redacted (production) error is just
  `[Request ID: …] Server Error`.
- **`ConvexError`** (`npm-packages/convex/src/values/errors.ts`) carries `data`. It is never
  redacted and travels as `errorData`. The client rebuilds `new ConvexError(data)`
  (`npm-packages/convex/src/browser/sync/client.ts`).
- **A missing function** gives "Could not find public function for 'mod:fn'." as a function error
  (`crates/udf/src/validation.rs`), or 404 `FunctionPathNotFound` behind a knob.
- **OCC** errors, read limits and the like reach the app as function errors with Convex's messages
  (STUDY-06).

### 1.3 Return values

- Return values go through `convexToJson`. A value that is not a Convex value (a `Date`, a `Map`, a
  class instance, an out-of-range bigint) **fails the call**.
- `undefined` becomes `null`.
- Returns can also be checked against the function's `returns` validator.

### 1.4 WebSocket

`crates/convex/sync_types/src/types/mod.rs`:

- `MutationResponse { request_id, result: Ok(value) | Err(ErrorPayload), ts, log_lines }`.
- `ErrorPayload` is either `Message(String)` or `ErrorData { message, data }`.
- `QueryFailed` carries `error_data` too.

## 2. What an app can observe

1. **HTTP:** a failing function answers **200** with `status: "error"`.
2. **Messages:** errors look like `[Request ID: …] Server Error` plus `Uncaught Error: …` when not
   redacted.
3. **`ConvexError`** keeps its `data` end to end: HTTP `errorData`, WS `ErrorData`, and a
   `ConvexError` instance on the client.
4. **Encoding:** bigint, bytes and special floats are encoded in both directions (clean JSON over
   HTTP by default, encoded JSON over WS).
5. **Invalid returns:** returning a non-Convex value is an error, not a coerced value.
6. **Log lines** come back with the result.

## 3. How bunvex does it today

`packages/server/src/server.ts`:

- `/api/{query,mutation,action}` read `{path, args}` and return `{status:"success", value: value ??
  null}`.
- On any thrown error: `{status:"error", errorMessage: String(e.message)}` with **HTTP 500**.
  - An unknown route gives 404 `{errorMessage:"not found"}`; invalid JSON gives 400.
  - A missing or internal function gives the error "function not found: mod:fn", also with 500.
- `format` is ignored. Arguments are passed as raw JSON (`$integer` objects reach the handler as
  plain objects).
- Values are `JSON.stringify`'d, so `Date` becomes a string, `Map` becomes `{}`, and bigint throws a
  `TypeError`, which becomes a 500 error.

WebSocket:

- `res{id, v}` or `res{id, e: message}`; `err{k, e: message}`.
- There is no error data, no request id, no log lines and no commit ts.

`packages/server/src/functions.ts`: no argument or return validation (the `Args = any` placeholder).

## 4. Divergences

| # | Divergence | Class | Why / impact | Decision |
|---|---|---|---|---|
| D1 | A function error returns HTTP 500; Convex returns 200 with `status: "error"` | OBSERVABLE | HTTP clients, proxies and monitoring treat app errors as server failures, and retries may trigger | owner |
| D2 | `ConvexError` data is lost: only `String(e.message)` is sent (HTTP and WS); there is no `errorData` | OBSERVABLE | Apps that branch on `err.data` (the documented way to return app errors) break | owner |
| D3 | Error message shape: the bare message vs `[Request ID: …] Server Error\nUncaught Error: …`, with no redaction mode | OBSERVABLE | Tests and UI that show or match messages differ. There is also no production redaction: internal messages always leak to clients | owner |
| D4 | No `$integer`/`$bytes`/`$float` decoding of arguments, no `format`, no clean/encoded output | OBSERVABLE | bigint and bytes cannot cross the wire, and special floats are lost (STUDY-10 D1/D2) | owner |
| D5 | Non-Convex return values are coerced (`Date` → string, `Map` → `{}`) or throw an untyped error (bigint) | OBSERVABLE | Convex fails the call with a clear error | resolved in #21 (DV-70) |
| D6 | Function-not-found text: "function not found: x" (500) vs "Could not find public function for 'x'." | OBSERVABLE | Message differs | resolved: Convex's messages (owner, 2026-09-30; DV-71) |
| D7 | No `logLines` in responses | OBSERVABLE | `console.log` in functions does not reach the client/CLI (ARCHITECTURE "logs", M) | owner |
| D8 | WS `res` has no commit `ts` and no request/session identity | OBSERVABLE | The client cannot wait for its queries to catch up (STUDY-08 D5), and a mutation cannot be deduplicated after a reconnect (STUDY-06 D7) | owner |

## 5. Tests

- **Wire fixtures:** for each case — success with every value type, a thrown `Error`, a thrown
  `ConvexError({code: 1})`, a missing function, an OCC exhaustion — record Convex's HTTP status and
  JSON body (and WS frames), then assert that bunvex produces the same shape. Request ids and stacks
  are normalised.
- **Client round trip:** the official `convex` npm client's `ConvexHttpClient` against bunvex: a
  thrown `ConvexError` arrives as `ConvexError` with `.data` intact.

## 6. Open questions

1. Should bunvex speak Convex's wire protocol exactly (so the official `convex` client works
   unmodified), or only its semantics through `@bunvex/client`? That decides how literal D1–D8 must
   be.
2. Should errors be redacted by default in production, as Convex does?

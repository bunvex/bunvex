# STUDY-67 — The HTTP function API (`/api/query`, `/api/mutation`, `/api/action`, `/api/function`, `/api/run`, …)

- **Status:** studied; fixes in follow-up PRs (§4)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend; observed against Convex's
  precompiled local backend `precompiled-2026-10-02-c449d75` (§5)
- **Related:** [STUDY-20](STUDY-20-function-errors-and-logs.md) (function errors, `logLines`, redaction),
  [STUDY-26](STUDY-26-sync-client.md) §9 (the HTTP client), [STUDY-34](STUDY-34-admin-keys.md) (admin keys,
  `/api/function`), [STUDY-37](STUDY-37-cli-and-environment-variables.md) (`bunvex run`), [STUDY-60](STUDY-60-streaming-export.md)
  (the `format` names, DV-307), DV-58 (the 560 status)

This study audits the public HTTP function API end to end: every route, status code, body and header that a
client other than bunvex's own can see (curl, other SDKs, the official `ConvexHttpClient`).

## 1. How Convex does it

### 1.1 The routes (`crates/local_backend/src/public_api.rs`, `router.rs`)

`public_api_router` mounts, under `/api`:

| Route | Body / query | Runs |
|---|---|---|
| `GET /api/query` | query string `path`, `args`, `format` (`UdfArgsQuery`) | `execute_public_query` at the latest ts |
| `POST /api/query` | `{path, args, format?}` (`UdfPostRequest`) | `execute_public_query` |
| `POST /api/query_ts` | none | `latest_timestamp`: `{ts}` (base64 of the u64, little-endian) |
| `POST /api/query_at_ts` | `{path, args, ts, format?}` | `execute_public_query` at `ts` |
| `POST /api/query_batch` | `{queries: [{path, args, format?}]}` | every query at one latest ts, `{results: [UdfResponse]}` |
| `POST /api/mutation` | `{path, args, format?}` | `execute_public_mutation` |
| `POST /api/action` | `{path, args, format?}` | `execute_public_action` |
| `POST /api/function` | `{path, args, format?, componentPath?}` (`args_structs.rs` `UdfPostRequestWithComponent`) | `execute_any_function`: any kind, internal ones too |
| `POST /api/run/{*functionIdentifier}` | `{args, format?}` | `execute_any_function` on the root component |

Each handler, in order:

1. Axum's extractors, in argument order: the host, the request id, the request metadata,
   `ExtractAuthenticationToken`, `ExtractClientVersion`, then `Json` (or `Query`) for the body.
2. The path: `parse_export_path` (`parse.rs`) for query/mutation/action/query_at_ts/query_batch,
   `parse_udf_path` for `/api/function` and `/api/run`.
3. `authenticate` (the identity from the token).
4. `/api/function` only: `component_path(&identity)` calls `must_be_admin` first.
5. The run; then the `format` is parsed (`ValueFormat::from_str`) and the result exported.

The whole `/api` router is wrapped in `cors()` (`router.rs`); `/http/` (HTTP actions) is not.

### 1.2 The response (`UdfResponse`)

```
{"status":"success","value":<value>,"logLines":[…]}
{"status":"error","errorMessage":"…","errorData":<value>,"logLines":[…]}
```

- Always **HTTP 200**, success or function error: the handlers return `Ok(Json(response))`. No crate in
  the open-source backend answers 560. `STATUS_CODE_UDF_FAILED = 560` exists only in the npm client
  (`browser/http_client.ts`), which accepts 200 *and* 560 — the status of Convex's hosted service, already
  recorded as DV-58.
- `logLines` is omitted when empty (`skip_serializing_if`); `errorData` only for a `ConvexError`.
- `errorMessage` is the `RedactedJsError`'s display: `[Request ID: <id>] Server Error`, then (unless
  redacted) a newline, the message and its frames.

### 1.3 `format` and the client version (`crates/value/src/export.rs`, `crates/common/src/version.rs`)

- `format` values: `convex_encoded_json` (alias `convex_json`) → encoded; `json` (alias
  `convex_clean_json`) → clean; `export_json` → export. Anything else: **400 `BadFormat`**, "format param
  must be one of [`json`]. Got <s>". The format is parsed after the run, so a bad format still runs the
  function (a mutation commits) and then answers 400.
- No `format`: `client_version.default_format()`. Encoded only for an `npm`/`npm-cli`/`actions` client
  ≤ 1.4.1 or a `python` client ≤ 0.5.0; **clean for everyone else, including a request with no
  `Convex-Client` header** (`ClientVersion::unknown()`), i.e. curl.
- `/api/run/…` defaults to clean whatever the client.
- The format applies to `value` **and** to `errorData`.
- Clean JSON: int64 as a decimal string, bytes as plain base64, NaN/±Infinity as strings; export JSON:
  int64 as a number, bytes and special floats tagged.
- The `Convex-Client` header is parsed: no `-` is **400 `InvalidClientVersion`**; an unsupported version
  (e.g. `npm-abc`) is **400 `ClientVersionUnsupported`** with `x-convex-deprecation-state` and
  `x-convex-deprecation-message` headers.

### 1.4 Request errors (`crates/common/src/http/extract.rs`, `parse.rs`, `errors`)

All are `{code, message}` bodies (`HttpResponseError`), status from `ErrorMetadata`:

| Case | Status | Code | Message |
|---|---|---|---|
| no `Content-Type: application/json` (`application/*+json` and parameters accepted) | 400 | `BadJsonBody` | "Expected request with \`Content-Type: application/json\`" |
| body not JSON | 400 | `BadJsonBody` | "Failed to parse the request body as JSON: <serde error> at line L column C" |
| missing / mistyped field (`path`, `args`, `ts`, `format` not a string) | 400 | `BadJsonBody` | "Failed to deserialize the JSON body into the target type: missing field \`args\` at line 1 column 15" |
| bad path (`m:ok:x`, `""`, `m/o-k`) | 400 | `BadConvexFunctionIdentifier` | "<path> is not a valid path to a Convex function. <why>" |
| bad `format` | 400 | `BadFormat` | above |
| `Authorization` shorter than 7 bytes | 400 | `InvalidHeaderFailure` | "Invalid authentication header" |
| `Authorization` neither `Convex ` nor `Bearer ` | 400 | `InvalidAdminKey` | "Invalid admin key" |
| bad admin key | 401 | `BadAdminKey` | |
| bad JWT | 401 | `InvalidAuthHeader` | |
| `/api/function` without an admin key | 403 | `BadDeployKey` | "The provided deploy key was invalid for this deployment. …" |
| `/api/run/x` (fewer than two segments) | 400 | `MissingIdentifier` | "Path or function name not provided in path, e.g. /api/run/messages/list" |
| wrong method on a known route | 405 | (empty body) | `allow: POST` |
| `query_at_ts` with a malformed or future `ts` | **500** | `InternalServerError` | (no metadata on the error) |
| `/api/function` with an unknown `componentPath` | **500** | `InternalServerError` | |
| store / system failure (#273) | 500 / 503 | `InternalServerError` | |

### 1.5 Function errors (HTTP 200, `status: "error"`)

- Unknown or internal function: "Could not find public function for 'm:nope'." (query/mutation/action);
  "Could not find function for 'm:nope'. Did you forget to run \`npx convex dev\`?" (`/api/function`,
  `/api/run`).
- Wrong kind: "Trying to execute m.js:mut as Query, but it is defined as Mutation."
- Arguments (`crates/model/src/modules/function_validators.rs` `check_args`, for a function with an `args`
  validator), as a `JsError` from Rust — **no `Uncaught`, no frames**:
  - `args` is an array: each element is one argument; more than one is "ArgumentValidationError: Expected
    to receive a single object as the function's argument. Instead received 2 arguments: [{}, {}]";
  - not an object (`5`, `null`): "ArgumentValidationError: Expected to receive an object as the function's
    argument. Instead received: 5.0";
  - a validator miss: "ArgumentValidationError: Value does not match validator.\nPath: .x\n…".
  Each display ends with an extra newline (the message ends with one, the `JsError` adds one).

### 1.6 CORS (`router.rs` `cors()`)

On every `/api/*` route (not `/http/`):

- `access-control-allow-credentials: true` on every response;
- `access-control-allow-origin: <the request's Origin>` when the request has one;
- a preflight (`OPTIONS` with `Access-Control-Request-Method`) answers 200, no body, with
  `access-control-allow-methods: GET,POST,OPTIONS,PATCH,DELETE,PUT`, `access-control-max-age: 86400`, the
  requested headers mirrored in `access-control-allow-headers`, and `allow` with the route's methods.

### 1.7 `GET /api/query`

`UdfArgsQuery.args` is a `UdfArgsJson` (a JSON value), which `serde_urlencoded` cannot deserialize from a
query string: every request with `args` answers **400 `BadQueryArgs`**, "Failed to deserialize query
string: args: invalid type: newtype struct, expected any valid JSON value"; without `args`, "missing field
\`args\`". The route is in Convex's OpenAPI spec, but no request can succeed on it.

## 2. What an app can observe

- A function error is a 200 with `status: "error"` from every route; bunvex must not answer 560 (Convex's
  backend does not; DV-58).
- Results and `errorData` in the requested `format`, clean JSON by default for clients that are not
  Convex's (old) npm/python clients.
- The request-level errors of §1.4, with their status and code.
- Browsers: a page on another origin can call the API (CORS, preflight).
- `/api/run/<module path>/<name>` and `/api/query_batch` exist; `/api/function` needs an admin key.

## 3. How bunvex does it

Observed with the probe of §5 against a bunvex server on `main` (`packages/server/src/server.ts`).

| Area | bunvex on `main` | Matches? |
|---|---|---|
| Function error status | 200 `{status:"error"}` | yes (the trigger of this study was a false alarm: see §1.2) |
| `value`, `errorData`, `logLines` | encoded JSON always | no: `format` is ignored (`json`, `export_json`, a bad format, the client default) |
| Content-Type | anything accepted | no |
| Missing `args` | accepted as `{}` | no (Convex: 400) |
| Body error messages | "invalid JSON body: <Bun's message>", "missing field \`path\`" | no (structure differs) |
| Bad path | function error "Could not find public function for 'm:ok:x'." | no (Convex: 400 `BadConvexFunctionIdentifier`) |
| `args` array of 2, `null` | the first element / `{}` | no (Convex: argument errors) |
| Argument errors | "Uncaught Error: ArgumentValidationError: …" with frames; "Arguments must be an object, got 5.0." | no |
| `/api/function` without a key | runs public functions | no (Convex: 403 `BadDeployKey`) |
| `/api/function` `componentPath` | ignored | no |
| `/api/run/…` | 404 | missing |
| `/api/query_batch` | 404 | missing |
| `GET /api/query` | 404 | missing (Convex's never succeeds, §1.7) |
| Wrong method on a route | 404 `NotFound` | no (Convex: 405 + `allow`) |
| CORS on `/api/*` | none (only `/api/storage/*`) | **no: a browser page on another origin cannot use the HTTP API** |
| `query_at_ts` bad / future ts | 400 `BadJsonBody` / 400 `InvalidTimestamp` | no (Convex: 500) |
| Client version header | not validated | no |
| Auth errors (header, admin key, JWT) | as Convex | yes |
| System failures | 500 / 503 `InternalServerError` | yes (#273) |
| Stack frames in `errorMessage` | Bun's raw frames | known, DV-76 |

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| H1 | The API answers 200, not 560, for a function error | Convex's backend answers 200 too; 560 is the hosted service's | DV-58 (already decided): nothing to do |
| H2 | No CORS on `/api/*` | gap | fix to match (#292) |
| H3 | `format` ignored; encoded JSON always | gap | fix to match (#293) |
| H4 | Content-Type not required; `args` optional; body error messages | gap | fix to match (#295) |
| H5 | `/api/function` open to non-admins; `componentPath` ignored; 404 for a wrong method | gap | fix to match (#295) |
| H6 | Argument errors rendered as an uncaught JS error, other messages, extra args accepted | gap | fix to match (#298) |
| H7 | A bad path is a function error, not 400 `BadConvexFunctionIdentifier` | the code holds "Convex" (rule 5) | **pending owner** (DV-312, draft #302): recommended, a wire-name exception as DV-307 |
| H8 | `/api/run/{path}` missing | gap | add (#299) |
| H9 | `/api/query_batch` missing | gap | add (#301) |
| H10 | `GET /api/query` missing; Convex's cannot succeed | Convex bug | **pending owner** (DV-313, draft #303): recommended, a working route (args as JSON text) |
| H11 | `query_at_ts` with a bad or future `ts` answers 400 | bunvex chose clearer errors; Convex answers 500 | **pending owner** (DV-314, draft #300): recommended, keep 400 |
| H12 | The client header is not validated (`InvalidClientVersion`, `ClientVersionUnsupported`, deprecation headers) | the deprecation headers' names hold "convex" | **owner, 2026-10-03: option A** (DV-315, #300): validate as Convex (400s), deprecation headers as `x-bunvex-*`; built in #319 (§7) |
| H13 | Error frames | source maps | DV-76 (decided: later) |

## 5. Tests

- The probe: two scripts of ~130 raw `fetch` cases (every row of §1.4, §1.5, the formats, CORS) run
  against Convex's precompiled local backend (`convex-local-backend`, pushed with the official CLI) and
  against a bunvex server with the same functions; the diff drove §3. The Convex answers quoted here are
  from that run.
- Each fix PR adds raw `fetch` assertions on status, headers and body, with a sabotage check, and where the
  official client can see the difference, an oracle test with `ConvexHttpClient` (`packages/sync-e2e`).

## 6. Open questions

- `_system/x:y` without a key: Convex answers "Operation query not permitted"; bunvex "Could not find public
  function for '_system/x:y'.". Minor; left for the system-functions study (STUDY-34).
- A number result renders `1.0` in Convex (`serde_json`'s float) and `1` in bunvex: the same JSON number,
  nothing to do.

## 7. The client version check (H12, as built: #319)

The owner chose option A for DV-315 (2026-10-03): validate as Convex, with the deprecation headers named
`x-bunvex-*`.

**Convex** (`crates/common/src/http/mod.rs` `ExtractClientVersion`, `client_version_state_middleware`;
`crates/common/src/version.rs`; `crates/common/deprecation.json`). The middleware is a layer of
`ConvexHttpService`, so it runs on every request of the backend and of the site proxy, outside the router's
own layers (CORS):

- **Which version.** The `Convex-Client` header (`ClientVersion::from_str`): split on `-`, and the longest
  suffix that parses as semver is the version. Without such a suffix, the first part is the client and the
  rest an unrecognised version. The client name is lower-cased: `npm`, `npm-cli`, `actions`, `python` (also
  `python-convex`), `rust`, and others with no threshold. Without the header, the version in
  `/{client_version}/sync`, percent-decoded, as an npm client (`from_path_param`). Otherwise the client is
  unknown.
- **400 `InvalidClientVersion`.**
  - A header with no `-`: "Failed to parse client version string: '<s>'. Expected format is
    {client_name}-{semver}, e.g. my-esolang-client-0.0.1".
  - A sync URL version that is not semver: "Failed to parse client version: <reason>". The reason is the
    `semver` crate's, e.g. "unexpected end of input while parsing minor version number".
- **`current_state`**, against the thresholds:
  - **Unsupported** at or below `unsupported`: npm, npm-cli and actions 0.19.1; python 0.0.2; rust 0.0.1.
    An unrecognised version always counts as below. This is a **400 `ClientVersionUnsupported`** with the
    message, plus `x-convex-deprecation-state: Unsupported` and `x-convex-deprecation-message`.
  - **UpgradeRequired** at or below `upgradeRequired` (npm 0.19.1, so never for npm; python 0.2.0; rust
    0.0.1). The request runs, and its answer carries the two headers with `UpgradeRequired`.
  - Comparisons follow the `semver` crate's order: a pre-release sorts before its release, and build
    metadata sorts after none, so `npm-0.19.1+b` is supported.

**Probe.** 69 cases were sent to Convex's local backend (`Convex-Client`) and to bunvex (`Bunvex-Client`):
headers, sync URL versions, percent-encoding, invalid UTF-8. Convex's wording mapped to bunvex's, every
status, body and deprecation header is the same, except `python-convex-0.0.1`. Neither server puts CORS
headers on these 400s. The cases are in `packages/server/test/client-version.test.ts`.

**bunvex** (`packages/server/src/client-version.ts`) wraps the API server's `fetch` outside CORS, and also
the site server's. Verdicts are cached per distinct header in a bounded map.

- **Header names.** It reads `Bunvex-Client` and answers with `x-bunvex-deprecation-state` and
  `x-bunvex-deprecation-message` (rule 5).
- **Messages.** They keep Convex's structure without naming a product: "The npm package at version abc is
  no longer supported. Update your npm package with \`npm update\`."
- **`python-convex`.** It is an unknown client (rule 5). Convex's python client sends `Convex-Client`,
  never this header.
- **The CLI** sent `npm-cli-0.1.0-alpha.0`, which this check refuses. It now announces the Convex npm
  version it follows, as the client does (DV-225, `VERSION` 1.46.0).

**Cost.** 80 ns per request without a header, 120–130 ns with one (cached); an uncached parse costs about
1.1 µs. HTTP query throughput (32 requests in flight, memory store) is unchanged within noise: about
20.3k req/s with and without the check.

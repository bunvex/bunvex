# STUDY-67 — The HTTP function API (`/api/query`, `/api/mutation`, `/api/action`, `/api/function`, `/api/run`, …)

- **Status:** studied; fixes in follow-up PRs (§4)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend; observed against Convex's
  precompiled local backend `precompiled-2026-10-02-c449d75` (§5); §9 at `d8bdde0`, against the pinned binary
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
| H3 | `format` ignored; encoded JSON always | gap | fixed (#293); the format names are bunvex's (`encoded_json`, `clean_json`; Convex's `convex_*` are `BadFormat`): DV-307, owner, 2026-10-03, revisited: B (as DV-312) |
| H4 | Content-Type not required; `args` optional; body error messages | gap | fix to match (#295) |
| H5 | `/api/function` open to non-admins; `componentPath` ignored; 404 for a wrong method | gap | fix to match (#295) |
| H6 | Argument errors rendered as an uncaught JS error, other messages, extra args accepted | gap | fix to match (#298) |
| H7 | A bad path is a function error, not 400 `BadConvexFunctionIdentifier` | the code holds "Convex" (rule 5) | **owner, 2026-10-03: option B** (DV-312, #302): a 400 with bunvex's code `BadBunvexFunctionIdentifier` ("the client used has to be bunvex's"), Convex's reasons, the sentence in bunvex's words |
| H8 | `/api/run/{path}` missing | gap | add (#299) |
| H9 | `/api/query_batch` missing | gap | add (#301) |
| H10 | `GET /api/query` missing; Convex's cannot succeed | Convex bug | **owner, 2026-10-03: option A** (DV-313, #303): a working route, `args` as the arguments' JSON text; its path checked as H7's, after the query string's fields and before authentication, as `public_query_get` (#302 and #303 were built in parallel; the check joined the GET route in a follow-up) |
| H11 | `query_at_ts` with a bad or future `ts` answers 400 | bunvex chose clearer errors; Convex answers 500 | **owner, 2026-10-03: option A** (DV-314, #300): keep the 400s |
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

## 8. The admin routes' query strings and bodies (2026-10-11)

H4's reader (`json-body.ts`) now serves every admin route that takes a JSON body, and `query-args.ts` reads
query strings as Convex's `Query` extractor does. Both are checked against Convex's binary in
`packages/differential/test/parse-errors.test.ts`.

Bodies:
- The reader knows more of serde's types: integers with their ranges (`u64`, `u16`, `usize`, `i64`), booleans,
  `Option`, `Vec`, unit enums, `#[serde(default)]`, nested structs, flattened structs (map only) and internally
  tagged enums.
- The function routes keep `JSON.parse`'s fast path (`fast`).
- Every other body is read byte by byte, so a field given twice is serde's `duplicate field`.

Query strings: serde_urlencoded's messages behind "Failed to deserialize query string: ", including Rust's
integer parse errors and `duplicate field`.

Order: as Convex's extractors, the query string or body is read before the route's operation check. So a bad
argument without a key is the 400, not `BadDeployKey`.

The routes covered:
- `cancel_job`, `cancel_all_jobs`, `delete_tables`, `delete_scheduled_functions_table`;
- `update_canonical_url`, `update_environment_variables` (both paths);
- `export/set_expiration` (its nanoseconds read exactly);
- `import` (query), `import/upload_part` (query), `import/finish_upload`, `perform_import`, `cancel_import`;
- `create_log_stream`, `update_log_stream`: the tag first, then each variant's fields as serde gives them
  (no path, no position, since the variant's content is buffered), before Convex's own checks of their values;
- `create_usage_limit`, `update_usage_limit`: the metrics listed in Convex's declaration order;
- `v1/list_audit_log_events`: its cursor refused as Convex refuses it, 400 `InvalidCursor` "Failed to parse
  cursor";
- `list_snapshot`, `document_deltas`: GET and POST; `SelectionArg` is an untagged enum, so arguments that make
  no selection select everything, and a table name that is not one is an internal error;
- `json_schemas`;
- `v1/data/sync`, `data_sync_cursor_from_deltas`, `v1/list_active_syncs`.

Covered by #559: the app metrics and push routes.

Not matched:
- a log stream body written as an array: serde's per-variant struct length message;
- the inside of a data sync's `selection`: serde's messages for `Selection`'s own fields;
- `shapes2`'s `component`: bunvex has no components.

## 9. The dashboard's routes from another origin (2026-10-14)

**The bug.** The dashboard is served on its own origin on every real install (the image on 6791, `bunvex dashboard
serve`, `bunvex dev`'s local dashboard on 6790) and its deployment on another (3210). Every admin request carries
`Authorization` and `Bunvex-Client`, which are not simple headers, so Chrome sends a preflight first. `getDeployment`
read `/version` (the preflight answered 405, no `Access-Control-Allow-Origin`) and `/stats` (403: the admin check
ran on the `OPTIONS`, no layer at all), so in the browser it always failed and the header said "Deployment
unavailable" in red. The same-process tests (`fetch` has no CORS) and `app.e2e.ts` (it checked only the name, which
the sign-in gives) did not see it.

**Convex** (commit `d8bdde0`, `crates/local_backend/src/router.rs`):

- `cors()` (`router.rs:618-632`): origin and request headers mirrored (`AllowOrigin::mirror_request`,
  `AllowHeaders::mirror_request`), credentials allowed, `GET,POST,OPTIONS,PATCH,DELETE,PUT`, max age 86 400 s.
  tower-http answers any `OPTIONS` with `Access-Control-Request-Method` as a 200 preflight with no body, before
  the route (so before any auth), and adds `vary: origin, access-control-request-method,
  access-control-request-headers` and the origin to every other answer.
- The layer is not global. `router()` (`router.rs:383-431`) puts it on the `/api` routes (`.nest("/api",
  api_routes)` and the `migrated` router's own `.layer(cors())`, `router.rs:410-412`) and on
  `health_check_routes` (`router.rs:541-563`: `/instance_name`, `/instance_version`, `/`, `/echo`; their own `.layer(cors())` at
  `router.rs:562`, and the outer one at `router.rs:428`). `/http/` is nested after the layer (HTTP actions answer CORS
  themselves).
- The meta routes `/version` and `/metrics` (`crates/common/src/http/mod.rs:568-573`) are merged by
  `ConvexHttpService::serve` after the router is built (`mod.rs:575-584`): no layer. An `OPTIONS /version` is axum's
  405 (a GET-only route) and a cross-origin `GET /version` has no `Access-Control-Allow-Origin`: a page on another
  origin cannot read it. `/version` and `/instance_version` carry the same `SERVER_VERSION_STR` (STUDY-112).
- The CLI's routes (`router.rs:320-356`: `push_config`, `prepare_schema`, `deploy2/*`, `run_test_function`,
  `get_config`, `get_config_hashes`, `schema_state/{id}`, `stream_udf_execution`, `stream_function_logs` and the import
  routes) have their own `cli_cors()` (`common/src/http/mod.rs:1335-1348`) under the router's. The outer layer answers
  their preflights (the router's methods); their other answers, like the health routes', carry the `vary` list twice,
  once per layer.
- Convex's self-hosted dashboard reads a deployment cross-origin only through `/api/*` (`deploymentFetch`,
  `dashboard-common/src/lib/appMetrics.ts`, …) and `/instance_name` (`dashboard-common/src/lib/deploymentContext.tsx:797`),
  all behind the layer. It never reads `/version`; it has no `/stats`.

**bunvex.** `/version` matched Convex already (outside the layer, DV-373's version); the dashboard was the one reading
the wrong route. Fixed as Convex is built, at the layer and in the source, not per route:

- `@bunvex/dashboard-source` reads the version from `/instance_version`, the health route that carries it under the
  layer (`server-source.ts` `getDeployment`).
- `/stats` (bunvex's counters, DV-162: no Convex counterpart) is behind the layer (`packages/server/src/cors.ts`
  `hasApiCors`), as the `/api` routes the dashboard reads: its preflight is answered before the admin check, and its
  answers, a 403 included, carry the origin. Not a divergence (Convex has no such route); the route was decided by
  the owner (DV-162), and the dashboard the owner chose to ship on its own origin (DV-475) reads it.
- The `vary` list twice on the health and CLI routes' answers, as Convex's two layers give it (found by the oracle
  below; harmless either way, matched because it is free).
- Every route `@bunvex/dashboard-source` calls is under `/api/` (or is `/instance_name`, `/instance_version`,
  `/stats`), so the layer covers them, `/api/debug/*` (AD-25, and the topology route AD-04 adds) included; the sync
  socket is a WebSocket upgrade (no CORS).

Found with it: the Overview's "Calls per minute" asked `topFunctions` for `k = 50`, which Convex's top-k routes refuse
(`k must be between 1 and 25`, `local_backend/src/app_metrics.rs:336`; bunvex's the same), so the indicator never
loaded on a deployment (the mock takes any `k`). It asks 25 now; the contract says so.

No divergence remains: no DV.

**Tests.**

- `packages/server/test/cors.test.ts`: for each route the dashboard calls (22, from `server-source.ts`,
  `credentials.ts`, `metrics.ts`, `logs.ts`, `settings.ts`, `tables.ts`, `writes.ts`, `deployment.ts`,
  `functions.ts`, and `/api/debug/subscriptions`), the preflight with `authorization,bunvex-client,content-type`
  asked (200, no body, the layer's headers, those three allowed) and the request with the key from another origin
  (the origin mirrored, credentials, `vary` once or twice); what the header reads (name, version equal to `/version`'s,
  persistence; `/stats` without a key a 403 the page can read); `/version` still outside the layer (405 preflight).
- `packages/differential/test/dashboard-cors.test.ts` (the oracle, Convex's binary): the same preflight on 25 routes
  both serve (the dashboard's, the health and meta routes, four CLI routes), compared whole (status, body, every
  `access-control-*` and `vary`; the asked headers name each one's own client header); each request from another
  origin, its CORS headers compared; `/instance_version` from another origin readable on both, equal to `/version`.
- `packages/sync-e2e/dashboard/cross-origin.e2e.ts` (Chromium, in `bun run e2e`): the app as a release ships it,
  served by `bunvex dashboard serve` on one port, signed in by hand to a server on another. The header shows the
  name, `memory` and the version (not "Deployment unavailable"); the Overview's "Calls per minute" (app metrics),
  "Live subscriptions" (`/stats`), the Engine's commit clock and the "Function calls" chart load; no request to the
  deployment fails in the browser, no CORS console error.
- `app.e2e.ts` (already cross-origin, through its proxy) now also checks that the header shows the name and not
  "Deployment unavailable"; its name check had matched the phone's hidden line, which only the failed header left
  as the first match.

**Sabotage** (each restored, `git diff` clean after):

| Broken | Caught by |
|---|---|
| `/stats` outside the layer (the bug) | `cors.test.ts` (3 tests), the Chromium e2e |
| the dashboard reads `/version` again (the bug) | the Chromium e2e (the header's version never shows) |
| the Overview asks `k = 50` again | the Chromium e2e ("Calls per minute" never shows) |
| `vary` once on every route | the oracle, `cors.test.ts` |
| the preflight without the asked headers | the oracle, `cors.test.ts` (2 tests) |
| `/version` put behind the layer (diverging from Convex) | the oracle (2 tests), `cors.test.ts` (2 tests) |

**Measured** (the layer runs on every `/api` answer): `apiCors` around a trivial handler, 200 000 `POST /api/query`
from another origin, twice each: 0.585–0.588 µs a request before, 0.637–0.651 µs after (the CLI routes' pattern),
against a request's tens of µs. A short run, as the Mac is shared.

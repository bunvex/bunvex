# STUDY-31 — HTTP actions (`httpRouter`, `httpAction`)

- **Status:** accepted: H1–H5 as recommended (owner, 2026-10-01)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend; §7–§10 at `d8bdde0`
- **Related:** server-api.md §16, platform.md §8; STUDY-30 S1 (registration at start); STUDY-27 (auth); STUDY-20
  (errors, redaction). HTTP actions come before file storage in the roadmap (owner, 2026-10-01); built-in
  auth (STUDY-28) needs them for OAuth callbacks, email links and JWKS.

## 1. How Convex does it

### 1.1 The router (`npm-packages/convex/src/server/router.ts`)

- **Constructor.** `httpRouter()` returns an `HttpRouter` with `exactRoutes`, `prefixRoutes` and
  `isRouter: true` (L47, L143-145).
- **Methods.** `GET POST PUT DELETE OPTIONS PATCH` (L14-21). HEAD cannot be registered: it runs the GET
  route, and the body is stripped. CONNECT and TRACE are never supported.
- **`route(spec)` checks, in this order** (L161-220):
  - `route requires handler`
  - `route requires method`
  - `'${method}' is not an allowed HTTP method (like GET, POST, PUT etc.)`
  - With `path`:
    - `Invalid httpRouter route: cannot contain both 'path' and 'pathPrefix'`
    - `path '${path}' does not start with a /`
    - `path '${path}' is reserved` (for `/.files` and `/.files/…`)
    - `Path '${path}' for method ${method} already in use`
  - With `pathPrefix`:
    - `pathPrefix '${p}' does not start with a /`
    - `pathPrefix ${p} must end with a /` (no quotes)
    - `pathPrefix '${p}' is reserved` (for `/.files/…`)
    - `${method} pathPrefix ${p} is already defined`
  - With neither: `Invalid httpRouter route entry: must contain either field 'path' or 'pathPrefix'`
  - Exact paths and prefixes may overlap; no cross-type check.
- **`lookup(path, method)`** (L275-293):
  - HEAD becomes GET.
  - An exact path first, then the longest matching prefix for that method (plain `startsWith`).
  - It returns `[handler, method, routePath]`, where `routePath` is the path or `${prefix}*`, or `null`.
  - `/profile` does not match `/profile/`; `/profile/` matches `/profile/a/b`.
- **`getRoutes()`** (L229-257) lists the routes, exact ones first, for the dashboard.
- **The export.** `convex/http.ts` exports the router as default. At push, analyze requires it
  (`crates/isolate/src/environment/analyze.rs` L761-993):
  - `` `convex/http.js` must have a default export of a Router. ``
  - `` The default export of `convex/http.js` is not a Router. `` (`isRouter` must be strictly `true`)
  - the `getRoutes()` shape errors.

### 1.2 `httpAction(handler)` (`impl/registration_impl.ts` L681-753)

- **The handler** is `async (ctx, request) => Response`. It takes no args validator; calling it directly
  only warns.
- **`ctx`:**
  - `runQuery`, `runMutation`, `runAction`;
  - `auth`, `storage` (the action writer), `scheduler`, `vectorSearch`, `meta`;
  - no `db`.
- **The result must be a `Response`:** otherwise `HTTP actions must return a Response`
  (`udf-runtime/src/23_response.ts` L297-300). The response streams: head first, then the body's chunks.
  `content-length` is set when known.
- **The `Request`:**
  - **URL:** `${scheme}://${Host}${uri}` (`crates/local_backend/src/http_actions.rs` L101-129). The
    scheme comes from `X-Forwarded-Proto`, then `Forwarded: proto=`, else `http`. The host is the request's
    `Host` header, and the path is the one after the `/http` prefix is stripped.
  - **Headers:** passed through, plus a generated `convex-request-id` when the client sent none.
  - **Body:** **GET, HEAD and OPTIONS get none**, even if one was sent (L131-140). Other methods get the
    body as a stream.
  - **`request.signal`** aborts when the client disconnects.
- **Auth:** the `Authorization` header goes through the same verification as the HTTP API
  (`authentication.rs` L137-166).
  - **A failure never rejects the request:** the identity becomes `Unknown(error)` (`http_actions.rs`
    L165-169). `ctx.auth.getUserIdentity()` then **throws** that error (`task_executor.rs` L205-223).
  - With no header, it returns null.

### 1.3 Serving (`crates/local_backend`)

- **Two entry points:**
  - the main port (3210) under `/http/…`, with the prefix stripped (`router.rs` L417, L494-499);
  - a site port (3211, `--site-proxy-port`) that forwards every path to `/http` + path (`proxy.rs`
    L34-66). `CONVEX_SITE_URL` defaults to `http://127.0.0.1:3211`.
  - On the site port, `/version` and `/metrics` are served before user routes. Everything else (`/api/…`,
    `/.well-known/…`, `/`) goes to the router.
- **No automatic CORS:** the `/http` nest sits after the CORS layer (`router.rs` L411-417). Apps answer
  OPTIONS themselves.
- **Unmatched requests:**
  - **404** `text/plain; charset=utf-8` `No matching routes found` (`action/mod.rs` L481-494);
  - with no router at all: `This Convex deployment does not have HTTP actions enabled.` (`http_routing.rs`
    L90-99);
  - TRACE and CONNECT get 405.
- **A thrown error (or a non-Response) before the head:** **500** `application/json`
  `{"code":"[Request ID: <id>] Server Error: <message>","trace":"<message and stack>","data":<BunvexError data>}`
  (`application/src/redaction.rs` L143-160, `lib.rs` L1506-1514).
  - Redacted (`--redact-logs-to-client`): `code` is `[Request ID: <id>] Server Error`, with no `trace`,
    and `data` still sent.
  - The request id there is a *new* one, not the request's (L1509).
  - No request-id header on the response.
  - **After the head was sent,** an error is only logged and the body ends early.
- **Limits:**
  - **Response:** 100 MiB (`HTTP_ACTION_RESPONSE_BODY_LIMIT`, since 82e5c50; 20 MiB before). Past that, the
    rest of the body is dropped and `HttpResponseTooLarge: HTTP actions support responses up to 100 MiB` is
    logged once, with no size warning; the status stays (STUDY-137).
  - **Request:** the code enforces no limit (the body stream is read raw; `DefaultBodyLimit` applies only to
    extractors, and 82e5c50 removed it from the router), and the limits table says "There is no specific limit
    on request size". The HTTP-actions page said 20 MB until 82e5c50. `formData()` is capped at 20 MiB.
  - **Time:** the server's `TimeoutLayer` (300 s) answers **408**, empty, if no head came by then. The
    action keeps running in the background, up to `V8_ACTION_USER_TIMEOUT` (1800 s):
    `Function execution timed out (maximum duration: 1800s)`.
  - **Concurrency:** HTTP actions share the action limiter, 64 at once (`APPLICATION_MAX_CONCURRENT_V8_ACTIONS`).
    A permit is waited for up to 10 s, then **429**
    `{"code":"TooManyConcurrentRequests","message":"Too many concurrent requests. Your backend is limited to 64 concurrent actions. …"}`.
    The site proxy also queues past 4 requests in flight.
  - **Not retried:** HTTP actions are never retried.
- **Logs:** each run is a function execution `HttpAction` named `"GET /path"` or `"GET /prefix/*"`. A
  client disconnect is logged at info.

## 2. What an app can observe

- The router API and every message of §1.1, the lookup order, HEAD → GET, and no body on GET, HEAD and
  OPTIONS.
- `ctx` without `db`.
- The `Request` URL and headers as described.
- The auth behaviour: never a 401 up front, but `getUserIdentity()` throws on a bad token.
- The two 404 bodies, the 500 JSON, the 408, the 429, and truncation at 20 MiB.
- Both ways in: `<origin>/http/…` on the API port, and every path on the site port.

## 3. How bunvex does it

### 3.1 API (`@bunvex/server`)

- **`httpRouter()` and `httpAction()`** with Convex's shapes and messages: exact routes, longest prefix,
  HEAD → GET, the `/.files` reservation, and `getRoutes()` / `lookup()`.
- **`ActionCtx`** gains `runAction`, which bunvex's actions lack today and Convex's have. `storage` and
  `vectorSearch` come with their features.
- **Registration (H1):** `createServer({ http })`, checked at start (`isRouter === true`, the routes'
  shapes), as the crons are (STUDY-30 S1). With the CLI, the default export of `http.ts` is discovered.

### 3.2 Serving

- **Both of Convex's ways in:**
  - `/http/*` on the API port, with the prefix stripped;
  - a site port: `sitePort`, default the API port + 1 (3211 next to 3210), or random with port 0 in tests.
    It serves every path, plus `/version` before user routes.
  - `siteUrl` defaults to `http://127.0.0.1:<sitePort>`.
- **The `Request`:**
  - **URL:** rebuilt from `Host` / `X-Forwarded-Proto` / `Forwarded` as Convex does.
  - **Body:** none for GET, HEAD and OPTIONS.
  - **Request-id header:** added when missing (H2 names it).
  - **`signal`:** Bun's own.
  - HEAD runs GET, and its body is dropped from the response.
- **Responses** stream through Bun.
  - Past 20 MiB, the stream is cut and the error logged, as Convex.
  - Errors before the head give Convex's 500 JSON, with a fresh request id and the existing redaction
    setting (`redactLogsToClient`).
  - No CORS is added.
- **Auth:** the STUDY-27 verifier.
  - A failure is kept and thrown by `getUserIdentity()`.
  - Queries and mutations run through `ctx` see no identity when the token was bad, and the user's
    identity when it was good.
- **Concurrency:** a limiter shared by every action, 64 at once, waiting up to 10 s, then Convex's 429.
  Today only the sync protocol caps actions; this brings the HTTP API's `/api/action` and HTTP actions under
  Convex's limit.
- **Time:**
  - Bun's `idleTimeout` (120 s) would close long HTTP-action requests, so those requests get Bun's
    per-request timeout turned off.
  - Convex's 300 s → 408 (empty) is then applied by bunvex.
  - The 1800 s hard stop is H4.
- **Logs:** run log lines go to the server's output (STUDY-30 S3 applies), and the execution is named
  `"GET /path"`: its lines by the request, its Completion by the route that matched once it ran to the end (§7).

### 3.3 PRs

1. **The router and `httpAction`:** API, checks, `ActionCtx.runAction`, unit tests of every message and
   of lookup.
2. **Serving:**
   - `/http/*` and the site port;
   - Request and Response conversion and streaming;
   - errors, limits, timeouts, auth, the shared action limiter.

   End-to-end tests over real HTTP: Convex's documented examples and CORS preflight written by the app.
3. **System functions** for the dashboard (the route list, as Convex's `modules` entries with HTTP routes)
   can follow with the Functions screen.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| H1 | The router is passed to `createServer({ http })` and checked at start, not discovered in `convex/http.ts` at push | no push until the CLI (same as STUDY-30 S1); the API is Convex's | **accepted** (owner, 2026-10-01) |
| H2 | The generated request-id header is `bunvex-request-id`, not `convex-request-id` | owner rule: no "convex" in shipped names (as DV-97's `Bunvex <key>`) | **accepted** (owner, 2026-10-01) |
| H3 | Request bodies: Convex's code enforces no limit (one docs page says 20 MB). Bun needs a ceiling for the whole server (`maxRequestBodySize`, 128 MiB by default) | recommended: keep Bun's 128 MiB, configurable (`maxRequestBodySize`) | **accepted** (owner, 2026-10-01) |
| H4 | No hard stop at 1800 s: a running action cannot be killed in-process (Convex terminates its isolate); the client still gets the 408 at 300 s and the action keeps running, as in Convex | one process, no isolate per function (DV-02's reason) | **accepted** (owner, 2026-10-01) |
| H5 | The site port's `/version` answers what the API port does (`bunvex`), not `unknown` | the same meta route on both ports; Convex's `unknown` is a placeholder service name | **accepted** (owner, 2026-10-01) |

Rows go in [docs/parity/divergences.md](../parity/divergences.md) as DV-143–DV-147 (decided).

## 5. Tests

- **Router:**
  - every message of §1.1;
  - lookup: exact before prefix, the longest prefix, `/profile` vs `/profile/`, HEAD → GET, the
    `routePath` strings;
  - `getRoutes()` order.
- **Serving, over real HTTP on both ports:**
  - GET, POST and the other methods; HEAD (GET's headers, no body); a GET with a body (dropped);
  - TRACE → 405;
  - unknown route → 404 `No matching routes found`; no router → the "not enabled" 404;
  - the URL a handler sees (Host, `X-Forwarded-Proto`, the `/http` prefix stripped);
  - the request-id header added when missing;
  - a streamed request and a streamed response;
  - 20 MiB truncation;
  - thrown error and non-Response → the 500 JSON, redacted and not, with `BunvexError` data;
  - error after the head → the stream is cut;
  - client disconnect → `request.signal` aborted.
- **Auth:** none → null; good → identity, also inside `ctx.runQuery`; bad → the request runs and
  `getUserIdentity()` throws Convex's message.
- **Limits:** 64 concurrent with a 10 s wait, then 429 with Convex's body; the 408 at 300 s (with a test
  knob).
- **Sabotage** of the body drop, the longest-prefix rule, truncation and the identity error.
- **Performance:** requests per second for a trivial `GET` handler on the site port vs a `/api/query`
  call.

## 6. Open questions

- `defineApp({ httpPrefix })` and component `http_mounts` wait for components (Phase 4).

## 7. The log name: the request or the route (follow-up, 2026-10-14)

Found by STUDY-149 PR 6 (#638): bunvex logged every HTTP action under the request's path (`GET /files/abc`), where
Convex names an execution by the route that matched (`GET /files/*` for a `pathPrefix` route). Read again at
Convex's reference commit `d8bdde0`, and checked against its binary (`precompiled-2026-10-07-d8bdde0`).

### 7.1 How Convex names an HTTP action

- **The name** is an `HttpActionRoute` (`crates/common/src/types/actions.rs:134`): a `RoutableMethod` and a path,
  printed `"<METHOD> <path>"`, plus whether the router matched it. `RoutableMethod` reads `HEAD` as `Get` (`:96`).
- **Two sources** for it:
  - *the request*: `HttpActionRequestHead::route_for_failure` (`crates/udf/src/http_action.rs:56`), the request URL's
    path (no query; percent-encoding kept), `matched: false`;
  - *the route*: the isolate calls the app's `router.lookup(path, method)` and keeps its `[_, method, path]`
    (`crates/isolate/src/environment/action/mod.rs:479-505`, `lookup_route` `:876`), `matched: true`. A prefix
    route's path is the prefix plus `*` (`npm-packages/convex/src/server/router.ts` `lookup`).
- **Progress entries** (the lines an HTTP action prints as it runs): always the request's name
  (`application_function_runner/http_routing.rs:117`, `:154`, `function_log.rs:1232`). So are the log streams'
  `console` events, which come from them.
- **The Completion** (the function log, `/api/stream_function_logs` `identifier`, the log streams'
  `function_execution` event): the outcome's route, which is the matched route only when the isolate run returned an
  outcome (`udf/src/action_outcome.rs:173` falls back to the request). It does not when:
  - *no route matched*: the isolate answers 404 "No matching routes found" itself (`action/mod.rs:487-497`) and the
    run is logged with status 404;
  - *the handler failed before the head* (a throw, a non-Response): the promise `runRequest` returned is rejected
    with no JS handler, so the run loop terminates the isolate as an unhandled rejection (`action/mod.rs:1071`) and
    the inner result, with its route, is lost; the termination override keeps a route only from an `Ok` inner
    result (`:406`). The same for a run past the action timeout, and for a body stream that fails after the head;
  - *the client left* (before or after the head): `http_routing.rs:195-260` logs an outcome built with no route.
- **App metrics** are recorded only for a matched outcome (`function_log.rs:1228`), under `UdfIdentifier::Http`,
  whose name is the route's *path* alone (`common/src/types/functions.rs:180`): `GET` and `POST /files/*` share
  `/files/*`. The dashboard asks with `udfType=HttpAction&path=GET /files/*`, parsed back to that path
  (`local_backend/src/app_metrics.rs:266`). A failed run or an unmatched request is not measured: invocations nor
  errors.
- **Usage** (`function_log.rs:1164`): the matched route's path, or `[unmatched]`; the call is tracked either way
  (`usage_tracking/src/lib.rs:248`).
- **The dashboard** names each log row by its entry's `identifier` (`dashboard-common/src/lib/useLogs.ts:153`
  `processLogs`), so a prefix route's lines show under the request (`GET /files/abc`) and its outcome rows under the
  route (`GET /files/*`); filtering on the function keeps the outcome rows.
- **No router** (no `http.js`): 404 "This … deployment does not have HTTP actions enabled.", nothing logged
  (`http_routing.rs:88-100`).

Seen on the binary (the oracle below): `GET /files/abc` → lines `GET /files/abc`, Completion `GET /files/*`;
`HEAD /files/abc` → both as `GET`; `GET /fail/z` (throws) → Completion `GET /fail/z` with the error, not measured;
`GET /nope` and `PUT /hello` (no route for that method) → Completion `GET /nope` / `PUT /hello`, status 404, no
lines, not measured; `PATCH /files/q?x=1` → `PATCH /files/q`.

### 7.2 What bunvex does now

- `http-actions.ts`: a request no route matches runs too, as a handler answering Convex's 404, so it is logged
  (status 404, caller `HttpEndpoint`) and takes an action permit as Convex's isolate run does.
- `Functions.runHttpAction` names the run by the request (`<METHOD> <path>`, HEAD as GET), which its Progress
  entries and `console` events keep. When the handler returned a Response under a matched route, its outcome carries
  the route (`Outcome.route`: `GET /files/*`, metrics name `/files/*`); the Completion, its `function_execution`
  and `exception` events take that name, and the app metrics record it. A body that fails or loses its client after
  the head drops the route, as Convex's. Without a route, the app metrics skip the run.
- The usage meter has no per-function names (STUDY-61), so the `[unmatched]` name has no counterpart; an unmatched
  request counts as a function call, as Convex's tracked call.
- The trace span (AD-26) keeps the request's name.

The hot path: one more template string per request; an unmatched request now runs the action machinery. A short run
(16 concurrent clients, 4000 requests per round, three rounds, on the shared Mac; req/s): exact route 14.9k, 13.7k,
14.0k before and 13.2k, 15.7k, 15.4k after; prefix route 12.9k, 15.4k, 15.0k before and 13.2k, 15.8k, 14.6k after
(no change beyond the noise); unmatched 29.7k, 37.8k, 38.6k before (no run) and 13.6k, 15.4k, 15.3k after, the cost
of a matched route, as Convex runs its isolate for one.

### 7.3 Divergences

None. Found on the way, not about the name and left for their own change: a handler's non-Response is logged with
no error (Convex: "Uncaught Error: HTTP actions must return a Response"); a `new Response("text")` answers with no
`content-type` (Convex: `text/plain;charset=UTF-8`); a body that errors after the head ends the response cleanly
on Convex and aborts it on bunvex. Convex sometimes logs a `HEAD` request no route matches with an extra "Client
disconnected" line (its 404 body sent to a HEAD client), a race not matched.

### 7.4 Tests

- `packages/server/test/http-action-log-route.test.ts`: prefix and exact routes (Progress by the request,
  Completion and `function_execution` by the route, HEAD as GET, metrics by the route's path across methods);
  unmatched requests (logged with 404, not measured); a throwing handler (by the request, not measured); a client
  that leaves mid-body (by the request, not measured). `http-action-response-log.test.ts` now expects HEAD as GET.
- `packages/differential/test/http-action-log-route.test.ts` (the app of `http-routes-app/`): fifteen requests on
  Convex's binary and bunvex's (exact, prefix, a longer prefix, HEAD, a query string, a throw, a throw after an
  await, a run past a 3 s action timeout, unmatched paths and methods, a percent-encoded path): the answers, every
  log entry's kind, name, lines, status and error line, and the app metrics of ten names compared.
- `packages/sync-e2e/dashboard/server-source-functions.test.ts` (live, through `@bunvex/dashboard-source`): a prefix
  route listed as `GET /files/*`; `watchLogs({ function: "GET /files/*" })` gets its outcome row, the Logs screen its
  line under `GET /files/a/b.txt`; its calls read under the route. Fails when the Completion is named by the request.
- Sabotage (each restored, `git diff` clean after): the Completion named by the request (unit and oracle fail);
  HEAD kept as HEAD (unit fails); the route kept after a body that lost its client (unit fails); unmatched requests
  not logged (unit and oracle fail); runs measured under their request path (unit fails) or every run under a route
  (oracle fails); `function_execution` named by the request (unit fails).

## 8. A response's implicit headers (follow-up, 2026-10-14)

Found by §7 (#639): a `new Response("text")` reached the client with no `content-type`. Read at Convex's reference
commit `d8bdde0` (its runtime's Request and Response were rewritten for spec compliance in 6f2ea45, after the
`4577b9031` this study first read), and checked against its binary (`precompiled-2026-10-07-d8bdde0`).

### 8.1 How Convex builds the head

- **The body, converted first** (`npm-packages/udf-runtime/src/22_body.ts` `convertBodyInit`, L18-27): a FormData,
  a URLSearchParams and a ReadableStream are kept; a Blob, an ArrayBuffer and a view are kept; any other value
  becomes a string (`09_file.ts` `convertBlobPart`, L163-181: `` `${value}` ``, a TypeError for a symbol or a
  SharedArrayBuffer). `null` and `undefined` are no body.
- **What a body brings** (`22_body.ts` `extractBody`, L30-57, the Fetch standard's "extract a body"): a stream, a
  type and a length.

  | Body | Type | Length |
  |---|---|---|
  | string (and any value made one) | `text/plain;charset=UTF-8` (L47-49) | its UTF-8 bytes |
  | URLSearchParams | `application/x-www-form-urlencoded;charset=UTF-8` (L44-46) | its serialization's bytes |
  | FormData | `multipart/form-data; boundary=<two Math.random()>` (L41-43; `21_formdata.ts` L202, L237) | its encoding's |
  | Blob | its type, if not empty (L50-52; the File API's, lower-cased, `09_file.ts` `_normalizeType` L368) | its size |
  | ArrayBuffer, typed array, DataView | none (L53-55) | its bytes |
  | ReadableStream | none (L36-38) | none |

- **The constructor** (`23_response.ts` L66-119): a `content-length` in the init is read as the response's
  `[[contentLength]]` (L103-105); the body's type goes in the headers only when they have no `content-type`
  (L109-111, `get(...) === null`: an explicit empty one is kept), and its length replaces `[[contentLength]]`
  (L112-114). So the type is in `response.headers` as soon as the response is built; the length is not.
- **`Response.json`** (L39-64): `JSON.stringify` (a TypeError "The data is not JSON serializable" for `undefined`
  or a throw), a Response of that string, then `headers.set("content-type", "application/json")` (L62): over an
  explicit type too, and with no charset.
- **The head** (`npm-packages/convex/src/server/router.ts` `runRequest`, L320-331, through the
  `convexJsonFromResponse` syscall, `23_response.ts` L270-288): the headers as they are, plus
  `content-length: [[contentLength]]` when they have none (L276-281). An explicit `content-length` is sent as the
  app gave it.
- **The Rust side** sends the pairs unchanged: `crates/isolate/src/http.rs` `HttpResponseV8::into_response`
  (L131-153) appends each to a `HeaderMap`; `environment/action/mod.rs` `stream_http_result` (L595-) sends the head,
  then the body's chunks over an unbounded channel; `crates/local_backend/src/http_actions.rs` reads the
  `content-length` (L191-200) and hands axum the headers and `Body::from_stream` (`HttpActionResponse`, L274-281,
  `stream_with_content_length` L284-). hyper frames the body by that `content-length`, or chunked without one; a
  HEAD answer keeps the head (`content-length` included, `0` when there is none) and drops the body.
- **When the body is handed over** (`application_function_runner/http_routing.rs` L118-122,
  `forward_http_action_stream` L292-330): every channel between the isolate and axum is unbounded, so a body the
  isolate has whole (all but a stream) is handed over at once and the run ends with the isolate, not with the
  client's reading.

Seen on the binary (the oracle below), by GET and by HEAD: every row of the table, with its length (`content-length`
framing) except a stream and no body, which go chunked; an explicit type wins over every body's but
`Response.json`'s; an explicit `content-length: 5` on a 5-byte string is kept. Inside the handler,
`new Response("x").headers.get("content-type")` is `text/plain;charset=UTF-8` and `content-length` is null.

### 8.2 What bunvex did

Functions got Bun's `Response`. It keeps a string's type out of `headers` and writes it (`text/plain;charset=utf-8`)
only when it sends the string itself; it types a Blob by its MIME table (`text/html;charset=utf-8`, as DV-441 found
for `Blob`); its `Response.json` is `application/json;charset=utf-8` and keeps an explicit type. URLSearchParams and
FormData matched. Then `Functions.runHttpAction` re-streamed every body through its meter (`http-body.ts`), so the
string's type never reached the wire, and Bun sent a length only for a body it had whole before the head (one small
chunk): a body past its first chunk (16 KiB for a string) went chunked. A HEAD answer had neither type nor length.

### 8.3 What bunvex does now

- **`web-response.ts`**: `SpecResponse`, the functions' `Response` in V8 modules (`code-version.ts`, beside
  DV-441's `SpecBlob`; a `"use node"` action keeps the host's). It converts the body as `convertBodyInit`, puts the
  body's type in the headers unless the init has one (a FormData's boundary is Bun's, matching its encoding), and
  `Response.json` sets `application/json` over any type, with Convex's TypeError. It records whether the body has a
  known length (not a stream): its size for bytes and a Blob, to be encoded for the others. `instanceof Response` holds
  for every Response, `fetch`'s too.
- **`Functions.runHttpAction`**: a body of known length that has a type is read whole (`blob()`), given its
  `content-length` unless the app set one, and handed to Bun whole, which frames it by that length; its run is
  logged at once, with its size for the response-size warning, as Convex's isolate hands such a body over at once.
  Untyped bytes (no type, explicit or the body's) stay streamed: Bun types a whole body it sends
  (`application/octet-stream`), so they keep Convex's "no type" and get Bun's framing (DV-483); a HEAD answer gets
  their length. A stream is streamed and metered as before. A body of known length past 100 MiB is streamed and cut
  as before.
- **HEAD** answers GET's head, `content-type` and `content-length` included, as Convex's.
- Embedded servers (`createServer({ functions })`, DV-167) run handlers in the host's realm, with Bun's own
  `Response`, as they have Bun's `Blob` (DV-441) and the host's `process.env` (DV-180): unchanged.

The hot path: a short run (16 concurrent clients, 4000 requests per round, three rounds, on the shared Mac; req/s),
before → after: a string 13.7k–15.3k → 18.6k–20.7k and `Response.json` 16.3k–16.8k → 19.2k–21.8k (sent whole, no
stream to pump); 5 untyped bytes 16.6k–17.4k → 16.4k–16.8k (the constructor's bookkeeping, ~2 %); a stream
19.0k–20.0k → 18.9k–19.8k (unchanged).

### 8.4 Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| DV-483 | The framing Bun picks. Convex sends a stream and no body chunked, and untyped bytes with their `content-length`. Bun sends a stream that ended before the head (one small chunk) with its length, no body with `content-length: 0`, and untyped bytes past its first chunk chunked | Bun picks the framing of what it sends: it ignores an explicit `content-length` or `transfer-encoding` on a stream (DV-324), and types every whole body. For untyped bytes the choice is (a) streamed: Convex's "no type", no length past ~16 KiB (built), or (b) whole: the length, plus `content-type: application/octet-stream` | owner, 2026-10-14: accept, (a) (as recommended) |

Not divergences: a FormData's boundary is random on both, and its encoding is each runtime's own (the parts read
back are equal; each `content-length` is right for its bytes). An explicit `content-length` on a stream is the case
DV-324 already records for downloads.

### 8.5 Tests

- `packages/server/test/http-action-content-type.test.ts` (pushed code, the wire read raw): every body type's type
  and length; an explicit type over each but `Response.json`'s; an explicit length kept; a 1 MiB string with its
  length; a stream chunked; untyped bytes past Bun's first chunk chunked (DV-483, pinned); HEAD with GET's type and
  length (bytes included; `0` for a stream); what the handler sees in `headers`; a body sent whole logged with its
  size (the response-size warning).
- `packages/differential/test/http-content-type.test.ts` (the app of `http-headers-app/`): the same bodies on
  Convex's binary and bunvex's, by GET and HEAD, read off a raw socket: status, type (a boundary's value left out),
  length and body compared; the multipart parts read back; the framing asserted per backend (DV-483); the headers
  the handler sees, compared.
- Sabotage (each restored, `git diff` clean after): the functions' `Response` left as Bun's (unit and oracle fail); a string's type
  left out (unit and oracle fail); a Blob typed by Bun's MIME table (unit and oracle fail); `Response.json` keeping an
  explicit type (unit and oracle fail); no body sent whole (the 1 MiB string goes chunked; unit and oracle fail); a
  body sent whole logged as 0 bytes (unit fails); no length for untyped bytes on HEAD (unit and oracle fail); an
  explicit type overwritten by the body's (unit and oracle fail).

### 8.6 Found on the way

Not built here (left to their own change, as in §7.3): a handler's non-Response is logged with no error (since §9, as
Convex's); a body that errors after the head aborts the response where Convex ends it cleanly (since §10, as
Convex's). A body sent whole (§8.3) can no longer fail
after the head.

## 9. A handler's non-Response (follow-up, 2026-10-14)

Found by §7 (#639): a handler that returned something other than a Response was answered with Convex's 500, but its
run was logged as if nothing failed. Read at Convex's reference commit `d8bdde0`, and checked against its binary
(`precompiled-2026-10-07-d8bdde0`).

### 9.1 How Convex checks the result

- **The check** is the router's, in the app's bundle: `runRequest` (`npm-packages/convex/src/server/router.ts`
  L304-331) awaits the handler, then hands its result to the `convexJsonFromResponse` syscall to build the head
  (L328-330). The syscall (`npm-packages/udf-runtime/src/23_response.ts` L270-273) throws
  `new Error("HTTP actions must return a Response")` for anything that is not an `instanceof Response`: an object
  shaped like one, `undefined`, `null`, a string, a number.
- **So it is a failure before the head**: `runRequest`'s promise rejects, as for a handler that throws, and the run
  is lost to the isolate's termination (§7.1): `HttpActionResult::Error`, the 500 JSON with the error
  (`Server Error: Uncaught Error: HTTP actions must return a Response`), and a Completion with that error, under the
  request's name, not measured. The error has one frame, in the `convex` library bundled with the app
  (`../node_modules/convex/src/server/router.ts:330:4`).

Seen on the binary (the oracle below), for an object, `undefined`, `null`, a string, a number and a Response-like
object: the 500 with that `code` and `trace`, the handler's line as a Progress entry, a Completion with
`success: null` and that error under `GET /result/<kind>`; the app metrics of the route count only the run that
returned a Response.

### 9.2 What bunvex did, and does now

- **Did:** `Functions.runHttpAction` resolved with the value, so the run was logged as a success with no status, and
  `http-actions.ts` answered the 500 itself.
- **Does:** `runHttpAction` throws `Error("HTTP actions must return a Response")` there, the way a throwing handler
  fails: the Completion, its `function_execution` and `exception` events carry the error, under the request's name
  (no route, not measured, §7.2), and the server answers it with its 500 as for any error before the head. The
  server's own check went with it: `runHttpAction` now resolves with a Response or fails.
- No hot-path cost: the check was there already.

### 9.3 Divergences

None new. The error has no frame (the server's are left out, STUDY-95), where Convex's shows one in its library
bundled with the app: the class DV-501 decided (bunvex's library runs in the server, with no frame of the app's to
show).

### 9.4 Tests

- `packages/server/test/http-action-result.test.ts`: an object, `undefined`, `null`, a string and a Response-like
  object answer the 500 with Convex's `code` and `trace`; each Completion and `function_execution` event carries the
  error under the request's name; only the run that returned a Response is measured.
- `packages/differential/test/http-action-result.test.ts` (the app of `http-results-app/`): the same, a number
  included, on Convex's binary and bunvex's: the answers, every log entry's kind, name, lines, status and error line,
  and the route's app metrics compared.
- Sabotage (each restored, `git diff` clean after): the value resolved again, the server answering the 500 (unit and
  oracle fail); another message (unit and oracle fail); a `TypeError` (unit and oracle fail); a Response-like object
  accepted (unit and oracle fail).

## 10. A body that fails (follow-up, 2026-10-14)

Found by §7 (#639): a streamed body that failed after the head aborted the response on bunvex, where Convex ends it
cleanly. Read at Convex's reference commit `d8bdde0`, and checked against its binary (`precompiled-2026-10-07-d8bdde0`).
Since §8 only a stream can fail: a body of known length is sent whole.

### 10.1 How Convex handles it

- **A body's error is uncaught in the isolate.** The runtime reads the response's stream into Rust as soon as the
  handler returns it (`convexJsonFromResponse`, `23_response.ts` L270-288, `constructStreamId`). A stream that errors
  rejects a promise nothing handles, and the run loop (`crates/isolate/src/environment/action/mod.rs` `run_inner`,
  L1059-1088) terminates the isolate on the first unhandled rejection it finds, with the error's traceback
  (`Uncaught <Name>: <message>` and its frames; `Uncaught <value>` for one that is no Error).
- **Before the head or after decides the outcome** (`run_http_action`, L398-414): the loop drains the microtask
  queue, looks for unhandled rejections, and only then, once JS is blocked, polls the result stream that sends the
  head (L1062-1088, L1123-1131, the `select_biased!` from L1164).
  - *In the handler's turn* (the stream's start errors it, or its first pull throws before it awaits anything
    outside the isolate): the head has not gone, so the run fails with the error: `HttpActionResult::Error`, the 500
    JSON with it, and a Completion with it under the request's name, not measured (§7.1). A chunk enqueued before
    the error is not sent.
  - *After the head*: `handle_http_streamed_part(Err(e))` (L661-667) adds an `ERROR` line of the error with the
    `error:httpAction` system code; the run ends there and is logged as streamed, with the head's status, under the
    request's name. The response streamer is dropped with the isolate, so the client gets the chunks sent so far and
    a clean end (hyper's chunked terminator).

Seen on the binary (the oracle below): a start that enqueues a chunk and errors (`Uncaught Error: body boom`), a
first pull that throws at once or after five awaits, and a string (`Uncaught a string`) all answer the 500 with that
error; two chunks a timer apart and then an Error, a string, or a start that errors two timers in, answer 200 with the
two chunks and a clean end, with `[ERROR] Uncaught TypeError: late body boom` and its frame (`Uncaught a late string`
for the string) as a Progress line, and a Completion with status 200 and no error.

### 10.2 What bunvex did

`meteredBody` (`http-body.ts`) passed the error on to Bun's stream (`controller.error`), and Bun reset the
connection: the client lost the chunks it had not read, and `fetch` failed ("The socket connection was closed
unexpectedly"). The run got an `error:httpAction` line of the error's message alone (`[ERROR] Error: body boom`),
whenever the body failed, so a stream that failed in the handler's turn was logged as a success.

### 10.3 What bunvex does now

- **After the head**, `meteredBody` closes Bun's stream instead: the client gets what was sent and a clean end. The
  line is Convex's: the error as an uncaught one (`describeUncaught`: `Uncaught TypeError: late body boom` and the
  app's frames, `Uncaught a late string`). The run is logged with the head's status, under the request's name (§7.2).
- **In the handler's turn**, `runHttpAction` looks at a stream (only a stream, not the untyped bytes §8 streams) for
  an error before it returns the response: `failedEarly` lets 32 microtask turns pass, watching the reader's `closed`
  promise. An error there fails the run as a throw: the 500, the Completion with the error, not measured.
- **The turn**: Convex drains the microtask queue; Bun has no way to know the queue is empty short of a macrotask.
  Waiting for `setImmediate` costs a streamed response ~45 % of its requests per second (below), so bunvex counts
  turns: a start that errors needs one, a pull that throws after `k` awaits `k + 3`, so up to ~29 awaits are caught.
  A pull that throws after more microtask-only awaits ends the response cleanly with the line where Convex answers
  the 500; and work that is a syscall in Convex but settles in microtasks in bunvex can fall inside the turn here
  and not there. This is DV-485.

The hot path (16 concurrent clients in a separate process, 4000 requests per round, three rounds, on the shared Mac;
req/s, a one-chunk stream): before 19.3k–21.4k; with the 32 turns 20.5k–21.5k (no change beyond the noise); with
`setImmediate` instead 11.4k–12.2k.

### 10.4 Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| DV-485 | When a streamed body's error counts as before the head. Convex: any error before JS blocks on something outside the isolate (the microtask queue drained). bunvex: an error within 32 microtask turns of the handler's return | Bun cannot see the microtask queue drained without a macrotask, and a macrotask (`setImmediate`) per streamed response costs ~45 % of its requests per second. Options: (a) 32 microtask turns (built); (b) `setImmediate`, exact for microtask-only work, at that cost; (c) no check, every body error ends the response cleanly with the line (Convex's 500 lost) | pending (owner); recommended: accept, with (a) |

### 10.5 Tests

- `packages/server/test/http-action-response-log.test.ts`: a body that fails after the head (two chunks, then an
  Error; a chunk, then a string) ends cleanly with what was sent (`arrayBuffer` resolves), the run logged with status
  200 and no error, and one `error:httpAction` line each, Convex's text with the app's frame; a body that fails in
  the handler's turn (a start that errors, a pull that throws at once or after five awaits) answers the 500 with the
  error, its Completion carries it, and no line is added.
- `packages/differential/test/http-body-error.test.ts` (the app of `http-body-errors-app/`): eight streams on Convex's
  binary and bunvex's, read off a raw socket: the status, the body, a clean end, the 500's `code` and `trace` line,
  every log entry (name, the first line of each line, status, error line) and the route's app metrics compared.
- Sabotage (each restored, `git diff` clean after): the stream errored again, not closed (unit and oracle fail); no
  check in the handler's turn (unit and oracle fail); the line as the error's message alone (unit and oracle fail);
  one microtask turn instead of 32 (unit and oracle fail); waiting 50 ms instead of the turn (unit and oracle fail).

### 10.6 Found on the way

A chunk that is not bytes (a string enqueued in the stream) is sent as text by Bun; Convex's runtime fails the body
with `Uncaught Error: serde_v8 error: invalid type; expected: buffer, got: string` (the 500 in the handler's turn).
Left as a gap.

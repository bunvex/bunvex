# STUDY-31 — HTTP actions (`httpRouter`, `httpAction`)

- **Status:** accepted: H1–H5 as recommended (owner, 2026-10-01)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
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

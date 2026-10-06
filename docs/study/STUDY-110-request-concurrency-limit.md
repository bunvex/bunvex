# STUDY-110 — The HTTP server's concurrent request limit

- **Status:** implemented; DV-364, DV-365 and DV-366 decided (owner, 2026-10-05)
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-05
- **Related:** [STUDY-31](STUDY-31-http-actions.md) and [STUDY-68](STUDY-68-function-limits.md) (the function
  limiters, which are a separate layer)

## 1. How Convex does it

### 1.1 The limit and its value

`ConvexHttpService::new` (`crates/common/src/http/mod.rs:509-559`) builds one `tokio::sync::Semaphore` per
service, of `max_concurrency` permits, and wraps the router in a `GlobalConcurrencyLimitLayer` over it.

- The knob `HTTP_SERVER_MAX_CONCURRENT_REQUESTS` defaults to 1024 (`crates/common/src/knobs.rs:384-388`).
- The self-hosted backend does not read that knob. `local_backend/src/main.rs:174-181` passes the constant
  `MAX_CONCURRENT_REQUESTS = 128` (`local_backend/src/lib.rs:119`). So a self-hosted deployment serves 128
  requests at once, and setting the variable changes nothing.
- A gauge, `<service>_http_service_concurrent_requests`, reports the permits in use. It is not part of this
  study.

### 1.2 What happens past it

tower's `GlobalConcurrencyLimit` makes a request **wait** for a permit:

- Tokio's semaphore is fair, so the wait is first come, first served.
- There is no rejection, no 503 and no message. The request is only later.

A request takes its permit when it reaches the layer. It releases it when the inner service's future resolves,
that is when the handler returns its `Response`: the **response head**. A streamed body (an HTTP action's
`ReadableStream`, a streaming export) is sent after the permit is back.

### 1.3 Layer order

The layers, from the outside in (`http/mod.rs:535-551`):

1. instrumentation;
2. log;
3. stats;
4. `client_version_state_middleware`;
5. **the limit**;
6. cookies;
7. the timeout's error handler;
8. `TimeoutLayer(HTTP_SERVER_TIMEOUT_DURATION)`, 300 s.

So:

- the client version check runs before the wait;
- the 300 s timeout is **inside** the limit, so the time a request waits for its permit does not count toward
  its 300 s.

The meta routes (`/version`, `/metrics`) are merged into the router **after** the layers (`serve`,
`http/mod.rs:578-584`), so they skip the limit.

### 1.4 WebSockets

The sync endpoint (`local_backend/src/subs/mod.rs:424-457`) answers with `ws.on_upgrade(…)`. The handler returns
the 101 response at once and the socket runs in its own task, so a session holds no permit. The upgrade request
itself does go through the layer: while all 128 permits are taken, the handshake waits for one, and holds it only
until the 101.

### 1.5 The site port

Self-hosted Convex serves the site URL (HTTP actions) with `dev_site_proxy` (`local_backend/src/proxy.rs:23-73`).
It is a separate `ConvexHttpService` whose router forwards each request to the backend's port, under the site
prefix:

- The proxy's own service is built with `max_concurrency = 4` (`proxy.rs:59-66`). At most 4 site requests are
  being forwarded at once; the rest wait.
- Each forwarded request then takes a permit of the backend's 128, like any API request.

So site requests share the backend's 128 with the API, **and** are capped at 4 in flight by the proxy.

### 1.6 `APPLICATION_MAX_CONCURRENT_UPLOADS`

The knob is 4 (`knobs.rs:1151-1154`). Its only use is `Application::upload_packages`
(`crates/application/src/lib.rs:2330`), a semaphore over the source packages one push uploads: the root's and
each component's. bunvex has no components (STUDY-62) and uploads one bundle per push, so there is nothing for
it to limit until components exist.

## 2. What an app can observe

- At most 128 requests are handled at once. Past that, a request is slower, not refused: no 503, no error.
- The wait does not eat into the 300 s timeout.
- A long streamed response does not keep others waiting once its head is sent.
- WebSocket sessions, once open, are not counted.

## 3. How bunvex does it

`packages/server/src/request-limit.ts`:

- **`RequestLimit`** is a FIFO counting semaphore. A free permit runs the handler synchronously (no promise). A
  freed permit goes straight to the oldest waiter, so no newcomer can take it in between. The queue is an array
  with a head index, so there is no `shift` copying.
- **`withRequestLimit(options, limit)`** wraps a `Bun.serve` `fetch`. The permit is held until what the handler
  returns settles, that is until the `Response` (its head) is ready, as in Convex.
- **`requestLimitFromEnv`**: `HTTP_SERVER_MAX_CONCURRENT_REQUESTS`, else 128.

In `createServer`:

- **One** `RequestLimit` serves both `Bun.serve` instances, the API and the site. In Convex too, site requests
  end up under the backend's 128.
- It sits inside `withClientVersionCheck`, as Convex's layer order.
- The HTTP action's 300 s head timeout runs inside the handler, so it starts once the permit is held, as in
  Convex.
- `ServerOptions.maxConcurrentRequests` sets the limit for tests.

Exempt:

- a request with `Upgrade: websocket` (DV-365);
- `/version`, as Convex's meta route.

**Measurement.** The wrapper as Bun calls it, on a ready `Request`, without the network, 2 M calls, 2 rounds:

| Handler | Plain | Limited | Overhead |
|---|---|---|---|
| synchronous | 45 ns | 113 ns | ≈ 70 ns |
| `async` | 46 ns | 150–158 ns | ≈ 110 ns |

That is about 0.1 µs a request, against roughly 17 µs for a trivial request through `Bun.serve` and `fetch` on
the same machine (about 0.6 %). The end-to-end throughput bench (64 concurrent fetch loops against a trivial
server) did not separate the two: run to run, its noise was ±15 % on a shared machine.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| L1 | `HTTP_SERVER_MAX_CONCURRENT_REQUESTS` sets the limit; self-hosted Convex ignores it and always uses 128 | Owner: the same default as self-hosted Convex, with Convex's knob name to change it | owner, 2026-10-05 (DV-364) |
| L2 | A WebSocket upgrade is exempt. In Convex the handshake takes a permit until its 101, so while the limit is full a new session waits | Owner: upgrades are exempt; a session never holds a permit in either | owner, 2026-10-05 (DV-365) |
| L3 | The site port has no limit of its own. Convex's `dev_site_proxy` is a service with `max_concurrency = 4`, so at most 4 site requests (HTTP actions) are forwarded at once, under the backend's 128 | Convex's 4 is the dev proxy's default, not a designed limit. Matching it (a second `RequestLimit(4)` on the site) would cap HTTP actions at 4 in flight | owner, 2026-10-05: do not match (DV-366) |

Matching Convex (no divergence):

- the default of 128;
- waiting, never refusing;
- first come, first served;
- the release at the response head;
- the 300 s timeout not counting the wait;
- one limit for the API and the site;
- the client version check outside the limit;
- `/version` exempt.

## 4b. Additions (beyond Convex)

None.

## 5. Tests

`packages/server/test/request-limit.test.ts`:

- with a limit of 2, the third slow request (an action over `/api/action`) starts only after one of the first two
  finishes, and all three succeed;
- waiting requests start in arrival order;
- the wait does not count toward the HTTP action's head timeout: a request that waits 400 ms, with a 150 ms
  timeout, answers 200;
- the API and the site share one limit;
- a streamed body does not hold the permit;
- a WebSocket session connects and syncs, and `/version` answers, while the limit is full;
- the default of 128 and the knob, including a bad value;
- `RequestLimit` alone: the synchronous fast path, a throw or a rejection releases the permit, and the FIFO order.

**Sabotage checks.** Each was applied alone, and the code restored after each one (`git diff` clean):

| Sabotage | Failed |
|---|---|
| one permit too many (`inUse < max + 1`) | 6 (limit of 2, order, timeout, shared, exempt, unit) |
| WebSocket upgrades not exempt | the exempt test (it times out) |
| the site gets a limit of its own | 3 (shared, stream, exempt) |
| LIFO instead of FIFO | 6 (order first) |
| default 1024 instead of 128 | the knob test |

## 6. Open questions

None. DV-366 (the site proxy's limit of 4) was decided: not matched (owner, 2026-10-05).

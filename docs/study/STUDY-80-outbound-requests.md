# STUDY-80 — Outbound requests: what an action's `fetch` may reach, and the SSRF proxy

- **Status:** PR 1 (schemes and Bun's options, #377) and PR 2 (the proxy) implemented, as Convex. P1
  (screening without a proxy, beyond Convex) pending (owner).
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-04. Oracle: Convex's
  `convex-local-backend` (a local build, `--disable-beacon`) with a screening proxy and local targets
  (§1.4).
- **Related:** [STUDY-27](STUDY-27-auth.md) (OIDC and JWKS), [STUDY-59](STUDY-59-log-streams.md) and
  [STUDY-70](STUDY-70-provider-sinks.md) (log stream sinks), [STUDY-71](STUDY-71-usage-metering.md) (fetch
  egress), [STUDY-40](STUDY-40-local-backend-and-local-deployments.md) (the backend's flags),
  [STUDY-66](STUDY-66-server-api-gaps.md) §4 (`fetch` refused in queries and mutations)

## 1. How Convex does it

### 1.1 What an action's `fetch` accepts

- The isolate's `fetch` (`npm-packages/udf-runtime/src/26_fetch.ts`) builds a `Request`
  (`23_request.ts`). Its constructor checks the URL (`validateURL`): any scheme but `http:` and `https:` is
  `TypeError: Unsupported URL scheme -- http and https are supported (scheme was <scheme>)`. So `file:`,
  `data:`, `blob:`, `ftp:` and the rest never leave the isolate.
- `RequestInit` is the web's: `method`, `headers`, `body`, `redirect`, `signal`. Any other key is ignored.
- Redirects are followed in JS (`26_fetch.ts`, at most 20): the backend's client never follows one
  (`reqwest::redirect::Policy::none()`), so every hop is a new request through the same client, and its
  `Location` goes through `new Request` again.
- A `"use node"` action runs in Node (`crates/node_executor`): Node's `fetch`, which takes `http:`, `https:`
  and `data:`; `file:` fails with `TypeError: fetch failed` (cause `not implemented... yet...`), another
  scheme with the cause `unknown scheme`.

### 1.2 The proxy: `--convex-http-proxy`

- `crates/local_backend/src/config.rs`: `--convex-http-proxy <URL>`, optional, a flag only (no environment
  variable). Its help: "Optional proxy for Actions fetches — i.e. if doing `await fetch(request)` within an
  action, you can send the request through this proxy to screen it for SSRF attacks."
- `crates/local_backend/src/lib.rs` builds two clients with it:
  - `ProxiedFetchClient` (redirects not followed), for actions' `fetch` and the log stream sinks;
  - `CachedHttpClient` (`crates/http_client`, redirects followed), for OIDC discovery and JWKS.
- In a release build without the flag it logs a warning at start: "Running without a proxy in release
  mode -- UDF `fetch` requests are unrestricted!".
- `build_proxied_reqwest_client` (`crates/common/src/http/fetch.rs`):
  - `Proxy::all(url)`: `http:` targets as absolute-form requests to the proxy, `https:` targets through a
    `CONNECT` tunnel;
  - `custom_http_auth(<instance name>)`: every proxied request, and every `CONNECT`, carries
    `Proxy-Authorization: <instance name>` (the raw name, no scheme), which Convex's Smokescreen uses to know
    the deployment;
  - `User-Agent: Convex/1.0` on every request without one (proxied or not).
- **The proxy's refusal.** Smokescreen answers a refused request with `407 Proxy Authentication Required`.
  Both clients turn a 407 response into an error, `Request to <url> forbidden`, without the response
  (`fetch.rs`: "Don't send back the raw HTTP response as it leaks internal implementation details in the
  response headers"). The check is on the status alone: a 407 from the target itself, or with no proxy, is
  the same error.
  - A refused `CONNECT` (an `https:` target) is not a response but a tunnel error from `reqwest`:
    `error sending request for url (<url>): client error (Connect): tunnel error: proxy authorization
    required`.
- **Without the flag** `reqwest` uses the system's proxy: `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and
  `NO_PROXY` (a proxy passed with `.proxy()` turns that off). No `Proxy-Authorization` is sent then.
- **What goes through it** (every user of the two clients):

  | Request | Client | Proxied |
  |---|---|---|
  | An isolate action's `fetch`, an HTTP action's | `ProxiedFetchClient` | yes |
  | Log stream sinks: webhook, Datadog, Axiom, PostHog Logs, PostHog Error Tracking | `ProxiedFetchClient` | yes |
  | OIDC discovery (`/.well-known/openid-configuration`) and JWKS (OIDC and `customJwt`) | `CachedHttpClient` | yes |
  | The Sentry sink | the `sentry` crate's own transport (`DefaultTransportFactory`) | no |
  | A `"use node"` action's `fetch` | Node's, in the local Node process | no |
  | Health checks, Fivetran, `big_brain_client` (Convex's own services) | plain `reqwest::Client` | no |

### 1.3 No screening of its own

Convex filters nothing itself: no private-range list, no check of loopback, link-local
(`169.254.169.254`, cloud metadata), or DNS answers. The screening is entirely the proxy's (Convex runs
Smokescreen in its cloud). The self-hosted Docker image (`self-hosted/docker-build/run_backend.sh`,
`self-hosted/docker/docker-compose.yml`) sets no proxy and ships none; its `exec … "$@"` lets an operator
add the flag. The self-hosted docs do not mention it.

### 1.4 The oracle

Convex's local backend with `--convex-http-proxy` pointing at a small proxy that answers 407 for some hosts
(as Smokescreen), tunnels `CONNECT` and logs each request; an action returning what `fetch` gave:

| Case | The proxy saw | The action got |
|---|---|---|
| `http://127.0.0.1:…/ok?tok=1` (allowed) | `GET http://127.0.0.1:…/ok?tok=1`, `Proxy-Authorization: oracle-inst`, `User-Agent: Convex/1.0` | 200 |
| `http://127.0.0.2:…/blocked?tok=secret` (refused) | the same shape | `TypeError: Request to http://127.0.0.2:…/blocked forbidden` (the query string dropped by `26_fetch.ts`) |
| `https://denied.test/x?tok=s` (refused `CONNECT`) | `CONNECT denied.test:443`, with the name | `TypeError: error sending request for url (https://denied.test/x): client error (Connect): tunnel error: proxy authorization required` |
| A redirect from an allowed host to a refused one | both hops | `TypeError: Request to http://127.0.0.2:…/after forbidden` |
| The same with `redirect: "manual"` | the first hop | the 302 |
| An HTTP action fetching a refused URL | the request | `TypeError: Request to … forbidden` |
| A target that itself answers 407, no proxy | — | `TypeError: Request to … forbidden` |
| No flag, `HTTP_PROXY` / `HTTPS_PROXY` set | every request, no `Proxy-Authorization` | as above |
| No flag, no variables: `127.0.0.2`, `169.254.169.254` | — | a connect attempt (timed out): nothing is filtered |
| `file:`, `data:`, `s3:`, `ftp:`, `blob:`, `localhost:3000/x` | — | `TypeError: Unsupported URL scheme -- http and https are supported (scheme was file)` (…) |
| A `customJwt` provider whose JWKS is refused | `GET …/jwks.json` | 401 `InvalidAuthHeader` "Could not fetch JWKS from URL '…': Request to … forbidden. Check that the URL is correct and accessible." |
| An OIDC provider whose discovery is refused | `GET …/.well-known/openid-configuration` | 400 `AuthProviderDiscoveryFailed` "Auth provider discovery of … failed" |

## 2. What an app can observe

- An action's `fetch` to a scheme other than `http:` / `https:` rejects with Convex's `TypeError`; a Node
  action's as Node's.
- Through a proxy: a refused request is a `TypeError` naming the URL without its query string (`Request to …
  forbidden`, or the tunnel error for `https:`); nothing of the proxy's response. A 407 from anywhere is the
  same error.
- A JWT whose provider's discovery or JWKS is refused fails as any unreachable provider, with the cause in
  the JWKS message.
- The operator sees the proxy's log: each request with the instance name, and the warning at start without
  a proxy. A log stream whose endpoint is refused fails as an unreachable one.

## 3. How bunvex does it

### 3.1 PR 1: what an action's `fetch` may reach

bunvex runs actions in its own process with Bun's `fetch`, which goes further than the web's:

- `file:` reads local files, `s3:` reads S3 with the process's own credentials;
- `RequestInit` takes `unix` (a Unix socket: a mounted Docker socket is a container escape), `proxy` (any
  proxy, around the operator's), `tls` (`rejectUnauthorized: false`) and `s3`.

So an action could read the server's files or reach its sockets, which Convex's never can. bunvex now sends
an action's request through a check (`packages/server/src/action-fetch.ts`), chosen per running action by a
hook in the determinism layer (`setFetchSender`, beside STUDY-71's `setFetchMeter`):

- an isolate action (and an HTTP action): `http:` and `https:` only, with Convex's `TypeError`; `unix`,
  `proxy`, `tls` and `s3` dropped, as Convex ignores what `RequestInit` lacks (a `Request` object does not
  carry them);
- a `"use node"` action: Node's schemes (`data:` too), Node's error otherwise;
- outside an action (an embedded server's host code), `fetch` is untouched.

Redirects: Bun follows them itself and refuses one to another scheme (`UnsupportedRedirectProtocol`), so a
`Location: file:///…` cannot get around the check.

**Cost** (`packages/server/bench/action-fetch.ts`, M-series Mac): the check is ~0.12 µs per call (157 vs
40 ns around a `fetch` that answers at once); an action's fetch to a local server is ~58–64 µs either way,
within noise.

### 3.2 PR 2: the proxy

- **The option.** `bunvex-local-backend --http-proxy <url>` (Convex's `--convex-http-proxy`; rule 5, as
  DV-197's other flags), a flag only, as Convex's; checked at start as clap checks a `Url` ("invalid value
  'x' for '--http-proxy <HTTP_PROXY>': relative URL without a base"), and only `http:` / `https:` (Bun's
  `fetch` has no SOCKS proxy, which `reqwest` has). `createServer({ httpProxy })`, default
  `BUNVEX_HTTP_PROXY` (as `localLogSink` / `BUNVEX_LOCAL_LOG_SINK`), for embedded servers. The Docker entry
  script passes the arguments it is given, as Convex's.
- **What goes through it** — exactly Convex's list (§1.2): isolate and HTTP actions' `fetch`; OIDC discovery
  and JWKS; the webhook, Datadog, Axiom and both PostHog sinks. Not the Sentry sink, not a `"use node"`
  action.
- **How.** Bun's `fetch` takes a proxy per request (`proxy: { url, headers }`): `http:` targets as
  absolute-form requests, `https:` through `CONNECT`, the headers on both — so `Proxy-Authorization:
  <instance name>` as Convex's. Bun follows redirects through the same proxy, each hop a new proxied request
  (as Convex's JS loop does).
- **The refusal.** A 407 response, from any request of those clients, is an error naming the request's URL:
  `Request to <url> forbidden`, or Convex's tunnel message when the proxy refused a `CONNECT` (an `https:`
  target through the operator's proxy: Bun returns that 407 as a response). In an action, a `TypeError`
  without the URL's query string, as Convex's `26_fetch.ts`.
- **Without a proxy.** Bun's `fetch` honours `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` as `reqwest` does,
  without `Proxy-Authorization`; an explicit `proxy` replaces them. At start, without a proxy, the backend
  logs Convex's warning in its own words: "Running without a proxy -- actions' `fetch` requests are
  unrestricted! (--http-proxy screens them)".
- **Where.** `packages/server/src/http-proxy.ts` (`proxiedFetch`); `Functions.httpProxy` gives each isolate
  action's run (`Running.send`) its deployment's sender, so two servers in one process keep their own proxy
  and name; the auth verifier and the log manager wrap their own `fetch`.

**Cost** (`packages/server/bench/action-fetch.ts`, 3 runs): the scheme check and the 407 check together are
~0.25 µs per call (290 vs 40 ns around a `fetch` that answers at once; ~310 ns with the proxy's init); an
action's fetch to a local server is 58–63 µs as served and unchecked alike. Through the test's local proxy
(a new connection per request) it is ~270 µs: the hop is the operator's choice.

### 3.3 Left as they are (separate gaps)

- A failed `fetch` in an action is Bun's error, not Convex's `TypeError: fetch to <url> failed: <cause>`
  (`26_fetch.ts`); and its default `User-Agent` is Bun's (`Bun/1.x`), where Convex's is `Convex/1.0`. Both
  apart from the proxy; listed in the parity rows.
- Log sinks follow redirects (Convex's fetch client does not); each hop still goes through the proxy.
- A `new Request("file:///…")` built in an action does not throw (Convex's constructor does); `fetch` with
  it does (PR 1).

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| — | `--http-proxy` for Convex's `--convex-http-proxy`; `BUNVEX_HTTP_PROXY` for embedded servers | rule 5 (DV-197) | as DV-197 |
| — | Only `http:` / `https:` proxies (Convex's `reqwest` also takes `socks5:`) | Bun's `fetch` has no SOCKS proxy | a platform limit, refused at start with a message |
| P1 | Screening without a proxy: refuse private, loopback, link-local and metadata addresses when no proxy is set (beyond Convex, which only warns) | self-hosted operators rarely run a proxy | **pending (owner)**: draft PR |

## 5. Tests

- `packages/server/test/action-fetch.test.ts` (PR 1): every scheme Convex refuses, a `Request` naming one, an
  HTTP action, a Node action (Node's errors), Bun's options ignored (`unix` against a real Unix socket server,
  `proxy` to a closed port, `tls`), and the host's own `fetch` untouched.
- `packages/server/test/http-proxy.test.ts` (PR 2), against a local screening proxy
  (`test/screening-proxy.ts`: absolute-form and `CONNECT`, 407 for refused hosts) and local targets: the
  cases of §1.4 with the oracle's messages (allowed, refused with its query dropped, a refused `CONNECT`, a
  redirect to a refused host naming the hop, `redirect: "manual"`, an HTTP action, a 407 without a proxy);
  `Proxy-Authorization: <instance name>` on each; a `"use node"` action not proxied; OIDC discovery and JWKS
  through the proxy, and refused with Convex's messages; the webhook and Datadog sinks proxied, Sentry's not;
  the flag's checks.
- **Sabotage:** the proxy ignored (5 tests fail), the 407 check removed (5), Sentry proxied (1), the hop not
  named (1).

## 6. Open questions

- P1 (§4).

# STUDY-142 — A failed `fetch` in an action, redirects and the default `User-Agent`
<!-- index: A failed `fetch` in an action: reqwest's causes, `fetch to <url> failed: …`, the query string dropped; Convex's redirect loop; the default `User-Agent` (`Bunvex/1.0`); no idle timeout; the screen's failures, early closes and addresses; §8: a fetched response returned as it came | implemented; DV-456 decided (rule 5); DV-457 accepted, DV-458 the spec's behaviour (owner, 2026-10-11); egress per redirect hop, OIDC's User-Agent -->

- **Status:** implemented; DV-456 decided (rule 5); DV-457 accepted and DV-458 the spec's behaviour kept (owner, 2026-10-11).
- **Convex source read:** the reference `d8bdde0` (`precompiled-2026-10-07-d8bdde0`, `docs/parity/upstream.md`):
  `npm-packages/udf-runtime/src/26_fetch.ts`, `23_response.ts` and `06_streams.ts` read at that commit on
  GitHub (the local clone, `4577b90`, has an older `fetchWithoutRedirect` without credentials or body
  failures); the same code read back out of the binary's bundled runtime. `crates/common/src/http/fetch.rs`,
  `crates/isolate/src/environment/action/{fetch.rs,stream.rs}` from the local clone (unchanged in
  `4577b90..d8bdde0`, STUDY-137). reqwest 0.13.4's `error.rs` (Convex's `Cargo.lock`).
- **Related:** [STUDY-80](STUDY-80-outbound-requests.md) (schemes, the proxy, the screen: DV-325),
  [STUDY-77](STUDY-77-action-timeout.md) (the action's signal), [STUDY-71](STUDY-71-usage-metering.md) (egress).

## 1. How Convex does it

### 1.1 The runtime's `fetch` (`udf-runtime/src/26_fetch.ts`)

- `fetch(resource, options)` builds Convex's `Request` (`23_request.ts`: `http:` / `https:` only), sends it with
  `fetchWithoutRedirect`, and follows redirects itself (`:14-75`):
  - `redirect: "manual"` returns the first response as it is;
  - a status outside 301, 302, 303, 307, 308 ends the loop; so does a redirect without `Location`;
  - `redirect: "error"` throws `TypeError("fetch attempted redirect")`;
  - at most 20 hops: the counter goes up before each new request, and the loop ends once it is 20, so a 20th
    redirect's answer is never looked at: 19 redirects then a 200 succeed, 20 throw
    `TypeError("fetch too many redirects")`;
  - a `ReadableStream` body cannot be sent again: a 303 drops it, any other redirect throws
    `TypeError("fetch cannot redirect with streamed body")`;
  - 301/302 after a `POST`, and 303 after anything but `GET`/`HEAD`, become a `GET` with no body, without
    `Content-Encoding`, `Content-Language`, `Content-Location`, `Content-Type`;
  - another origin (`origin` or `port`) drops `Authorization`;
  - the redirect's `Referrer-Policy` response header is copied onto the next *request*;
  - every later request is built from the caller's `options` object (mutated: `method`, `body`, `headers`) and
    the previous request's headers; a `Request` passed without `options` loses its method and body after a
    redirect (`new Request(url, {})`);
  - the response of a followed redirect has `redirected` set; its `url` is that hop's.
- `fetchWithoutRedirect` (`:77-110`) catches the backend's rejection and rethrows `fetchFailure(request.url, e)`;
  the response's body stream gets the same mapping for its read failures (`responseFromConvexObject(…, mapBodyError)`
  → `extractStream`, `06_streams.ts`).
- `fetchFailure(url, e)`:
  - an `AbortError` passes through;
  - `target = origin + pathname`; the cause is `String(e.message ?? e)` with every `url` (the request's full
    URL) and every `target + search + hash` replaced by `target` — the query string, fragment and credentials
    are where a token would be ("reqwest reports the URL without credentials, so replace that form too");
  - the result is `TypeError(cause)` when it names `target`, else `TypeError("fetch to <target> failed: <cause>")`.

### 1.2 The backend side

- `run_fetch` (`isolate/src/environment/action/fetch.rs:32-82`): `FetchAborted` becomes a `DOMException`
  `AbortError` ("The signal has been aborted"); any other error is `ErrorMetadata::bad_request("FetchFailed",
  format!("{e:#}"))`, i.e. reqwest's error and its sources joined by `: `.
- `ProxiedFetchClient::fetch` (`common/src/http/fetch.rs:121-170`): a 407 is
  `anyhow::bail!("Request to {} forbidden", request.url)` (STUDY-80, DV-325's refusal).
- The client (`build_proxied_reqwest_client`, `:80-105`): `.user_agent("Convex/1.0")`, the proxy if any, a
  redirect policy (`none` for the fetch syscall), and **no timeout**: a request waits until it answers, or the
  action's own time runs out.
- Body read failures (`stream.rs:36-63`): `ErrorMetadata::bad_request("StreamFailed", e.to_string())` — reqwest's
  error alone, which for a response body is "error decoding response body" (no URL; the runtime prefixes it).
- reqwest 0.13.4's `Display` is `<kind> for url (<url>)` ("error sending request for url (…)"); with `{e:#}` hyper
  and the system add their part: `client error (Connect): tcp connect error: Connection refused (os error 61)`,
  `client error (Connect): dns error: failed to lookup address information: <gai_strerror>`,
  `client error (SendRequest): connection closed before message completed`, rustls's words for TLS.

### 1.3 Measured on the oracle (`precompiled-2026-10-07-d8bdde0`, macOS arm64)

| Case | Convex |
|---|---|
| port closed, `…/p/a?token=secret#frag` | `error sending request for url (http://127.0.0.1:P/p/a): client error (Connect): tcp connect error: Connection refused (os error 61)` |
| name that does not resolve | `… (Connect): dns error: failed to lookup address information: nodename nor servname provided, or not known` |
| target closes at once | `… client error (SendRequest): connection closed before message completed` |
| target answers `NOT HTTP` | `… client error (SendRequest): invalid HTTP version parsed` |
| body stops short of `content-length` | `fetch to http://127.0.0.1:P/x failed: error decoding response body` (from `text()`) |
| 407, and a redirect to a 407 | `Request to http://127.0.0.1:P/407 forbidden` (the hop's URL, no query) |
| `https:` to a plain HTTP port | `… client error (Connect): received corrupt message of type InvalidContentType` |
| self-signed / untrusted root (badssl.com) | `… (Connect): invalid peer certificate: Other(OtherError("“*.badssl.com” certificate is not trusted: -67843"))` (macOS's verifier) |
| wrong host / expired | `… invalid peer certificate: NotValidForName` / `… Connection reset by peer (os error 54)` |
| abort while waiting, while reading | `DOMException` `AbortError` "The signal has been aborted" |
| a signal aborted *before* the call | **not** honoured: the request is sent and answers (see Q2) |
| default `User-Agent`; app's own | `Convex/1.0`; the app's wins |
| loops, `redirect: "error"`, no `Location`, `manual` | as §1.1 |
| credentials, encoded path, no path | the URL without credentials, `%20` / `%C3%A9` encoded, `/` added |

## 2. What an app can observe

- The error class and message of every failure above (an app logs them, matches on them, or shows them).
- No query string, fragment or credentials in any of them.
- `User-Agent: Convex/1.0` unless set — what servers see, and what some refuse (some APIs require a UA).
- Redirects: the limit, the three messages, the method and body each status keeps, `Authorization` dropped
  across origins, `redirected` and `url` on the response.
- Requests that wait as long as the action may: a slow upstream (an LLM stream idle for minutes) is not cut.

## 3. How bunvex does it

`packages/server/src/action-fetch.ts` (`isolateFetch`, for isolate and HTTP actions; `"use node"` actions keep
Node's `fetch`, as Convex's Node executor):

- **Redirects:** Convex's loop, written anew: each hop is one request with Bun's `redirect: "manual"`, so each
  goes through the proxy or screen and a 407 names that hop (`proxiedFetch` lost its `hop` flag, which read
  Bun's final URL). `redirected` comes from the loop (a prototype getter), `url` from Bun (the hop's).
- **Failures:** `failed()` → `fetchFailure(url, requestFailure(e, reqwestUrl))`:
  - `requestFailure` writes reqwest's message from Bun's error code: `ConnectionRefused` / `ECONNREFUSED`,
    `ETIMEDOUT`, `EHOSTUNREACH`, `ENETUNREACH` as `tcp connect error: <strerror> (os error N)` with the
    platform's text and number (macOS, else Linux), `ENOTFOUND` / `EAI_AGAIN` as the DNS error with
    `gai_strerror`'s text, `ECONNRESET` (Bun's code for a connection closed before the answer) as hyper's
    "connection closed before message completed";
  - certificate and TLS codes keep reqwest's frame with Bun's (BoringSSL's) words, and anything else is
    `error sending request for url (<url>): <Bun's message>` without Bun's "For more information, pass
    `verbose: true`…" and the URL it repeats (Q1);
  - `fetchFailure` is Convex's, character for character in behaviour (the replacements, the prefix);
  - a 407 (`RefusedRequest`) is already Convex's message; an abort is Convex's `DOMException`; the action's own
    timeout (STUDY-77) passes through as it is.
- **Body failures:** the response keeps Bun's native object (its fast `text()` / `json()`); its prototype is
  swapped for one whose reads and `body` stream map a network failure (an error with a `code`) to `fetch to
  <url> failed: error decoding response body`, an abort to Convex's, and leave a parser's `SyntaxError` alone.
  Its `body` is one stream however often it is read (one wrapper per response, §8).
- **`User-Agent`:** `Bunvex/1.0` (Convex's `Convex/1.0` in bunvex's words, rule 5, DV-456; the log sinks
  already send it, DV-304) when the app sets none.
- **No timeout:** Bun's idle timeout (5 min by default) is turned off for the request (`timeout: false`); Bun's
  own options an app passes (`timeout`, `maxRedirects`, `verbose`, `decompress`, `compress`, `protocol`, besides
  STUDY-80's `unix`, `proxy`, `tls`, `s3`) are dropped, as Convex ignores what `RequestInit` lacks.
- **The screen (DV-325):** the in-process screening proxy used to close the client's connection when it could
  not reach a target (and to keep it open forever when the target closed before answering). It now:
  - answers a failed connection with a `502` carrying `bunvex-screen-failure: <secret> <code>`, which
    `proxiedFetch` (holding the secret, `HttpProxy.failureToken`) turns into the error Bun gives without a
    proxy (`screenFailure`) — so the default deployment fails with "Connection refused" as Convex does; an
    upstream cannot forge it (another token is a plain `502`);
  - closes the client's connection when the target closes before its head is complete;
  - tries a name's addresses in order (`localhost` is `::1` first; a dev server often listens on `127.0.0.1`
    only), as reqwest does — it used to try the first only. A name that does not resolve is still the
    screen's 407 (DV-325, STUDY-80 §4.1).
- **Egress metering** (`core/src/determinism.ts`): a streamed body is counted as it goes out (a
  `TransformStream`) instead of being read into a `Request` first, so the sender still sees the app's
  `options` (the streamed-body redirect rule needs them); form data is counted by its encoded size.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| DV-456 | Default `User-Agent: Bunvex/1.0` | Rule 5 (as DV-304's sinks) | decided (rule 5) |
| Q1 / DV-457 | TLS and malformed-response causes keep reqwest's frame with Bun's words: `… client error (Connect): self signed certificate` where Convex says rustls's (`invalid peer certificate: UnknownIssuer` on Linux, macOS's verifier text on a Mac); `… : Malformed_HTTP_Response` for hyper's `invalid HTTP version parsed` (or header, status…); a TLS handshake against a plain HTTP port through the screen is "Connection refused" (Bun's code) | Não dá pra fazer exactly: Bun verifies with BoringSSL and reports one code for every malformed answer; rustls's and the platform verifier's words are not available | owner, 2026-10-11: accepted (A) |
| Q2 / DV-458 | A signal already aborted when `fetch` is called rejects with Convex's `AbortError`; Convex sends the request anyway and answers | Convex's runtime only watches the signal for a later abort (a bug, by the fetch spec) | owner, 2026-10-11: keep the spec's behaviour (B); to be reported upstream |

### Q1 — causes bunvex cannot word as Convex (DV-457)

- **Convex:** every failure is reqwest/hyper/rustls's text: for TLS, rustls-platform-verifier's (on Linux
  webpki's `invalid peer certificate: UnknownIssuer`, `NotValidForName`, …; on macOS Security.framework's
  `Other(OtherError("… is not trusted: -67843"))`); for a malformed answer, hyper's exact parse error.
- **bunvex:** the same frame (`error sending request for url (<url>): client error (Connect): …`), Bun's words
  inside (`self signed certificate`, `certificate has expired`, `unable to get local issuer certificate`;
  `Malformed_HTTP_Response`).
- **Same?** No, for these causes only; refused, unreachable, DNS, closed connections, bodies, 407s, redirects
  and aborts match (tested against the binary).
- **Why:** "Não dá pra fazer" exactly. Bun's TLS is BoringSSL and exposes OpenSSL-style codes; it reports
  every malformed response as one code. A table from BoringSSL codes to webpki's names (self-signed /
  untrusted → `UnknownIssuer`, `CERT_HAS_EXPIRED` → `Expired`, alt-name → `NotValidForName`) is possible, but
  Convex's words differ by platform and rustls version (recent rustls words an expiry with the times), and
  the oracle here is the macOS binary.
- **App impact:** low. An app that matches on a certificate or protocol error's text (rare; such failures are
  operational) sees different words in the same frame.
- **Decision (owner, 2026-10-11):** A — accept: reqwest's frame, Bun's words. (B was: map the common certificate codes to
  webpki's Linux names, as Convex's cloud and Docker image run on Linux; unverified against a Linux oracle.)

### Q2 — a signal aborted before the call (DV-458)

- **Convex:** `fetch(url, { signal })` with `signal.aborted` already true sends the request and returns its
  response (measured; the backend only selects on the signal's future abort).
- **bunvex:** rejects at once with Convex's `AbortError` ("The signal has been aborted"), as the fetch spec and
  Node do.
- **Same?** No.
- **Why:** "Ainda não fizemos" — bunvex could skip an aborted signal on purpose; it reads as a Convex bug.
- **App impact:** very low: an app that aborts before fetching expects the spec's rejection; on Convex it gets
  a response.
- **Decision (owner, 2026-10-11):** B — keep the spec's behaviour; to be reported upstream. (A was to match Convex.)

## 5. Tests

- `packages/differential/test/action-fetch.test.ts` (the oracle, local only): every case of §1.3 that does not
  need the network or a platform verifier, on Convex's binary and bunvex's, answers compared after DV-456's
  rewrite; DNS asserted per backend (DV-325). App: `packages/differential/fetch-app/fetch.ts`.
- `packages/server/test/action-fetch.test.ts`: the causes by code (`requestFailure`, both platforms' texts by
  `process.platform`), `fetchFailure`'s replacements and prefix, credentials and fragment dropped, a closed
  connection, a short body, a `SyntaxError` left alone, the `User-Agent` and an app's own, Bun's options
  ignored (`timeout: 1`, `maxRedirects: 0`), Convex's redirect loop (19 vs 20, `error`, `manual`, each status's
  method/body/headers, `Authorization` across origins, `Referrer-Policy`, a streamed body on 307 and 303), an
  abort.
- `packages/server/test/address-screen.test.ts`: a closed port and an early close through the screen equal
  the direct answers (no token in them); a forged failure header is a plain 502; `localhost` reaches an
  IPv4-only server.
- Existing: `http-proxy.test.ts` (407s, hops), `action-timeout.test.ts`, `usage-egress-storage.test.ts`.

### Sabotage

Each break below made at least one of the tests above fail (and was restored; `git diff` clean):

| Break | Failing |
|---|---|
| S1 `fetchFailure` keeps `?query#hash` | 2 (`action-fetch`) |
| S2 no default `User-Agent` | 2 |
| S3 21 hops instead of 20 | 1 |
| S4 the screen's failure token wrong | 1 (`address-screen`) |
| S5 every body error mapped (no `code` check) | 1 (the `SyntaxError` case) |
| S6 the screen tries the first address only | 1 |
| S7 a 302 keeps a `POST` | 1 |
| S8 an abort left as Bun's | 1 |
| S9 the screen ignores an early close | 1 |

### Measurements

`bun packages/server/bench/action-fetch.ts` with `N=5000` (macOS arm64, the machine shared), main → this branch:

| | main | branch |
|---|---|---|
| checked fetch (instant `fetch`, per call) | 302 ns | 839 ns |
| checked + 407 check, no proxy | 422 ns | 1 028 ns |
| action fetch to a local server, no screen | 68.9 µs | 63.5 µs |
| through bunvex's screen | 275.7 µs | 269.5 µs |
| unchecked (no sender) | 61.4 µs | 60.4 µs |

About +0.6 µs per call (a `Request` per hop, the response's prototype); within noise end to end. A first
version that wrapped every body in a new `ReadableStream` cost ~10 µs per call: replaced by the prototype swap.

## 6. Open questions

None. Q1 and Q2 were decided (§4). The two gaps the first version left were closed at the owner's request
(2026-10-11, §7).

## 7. Follow-up: per-hop egress and OIDC's `User-Agent`

- **Egress per hop:** Convex meters every fetch op's request body (`track_fetch_egress`), so a 307 or 308 that
  sends the body again is metered again, and a redirect that turns into a `GET` is not. bunvex's first request
  is metered around `fetch` (`core/src/determinism.ts`). Each later hop that goes out with a body is now
  reported by `isolateFetch` (its `resent` callback) and added to the action's `networkEgressBytes`
  (`functions.ts`, `resentEgress`). A hop that fails is not charged, as Convex charges 0 for a failed op.
  Test: `usage-egress-storage.test.ts` (307, 308, 302 after a `POST`, 303 after a `PUT`).
- **OIDC's `User-Agent`:** Convex's OIDC discovery and JWKS client is built by the same
  `build_proxied_reqwest_client` (`Convex/1.0`). bunvex's verifier fetch now sends `Bunvex/1.0` when the
  request has none (`withDefaultUserAgent`, `server.ts`), as DV-456. Test: `http-proxy.test.ts`.
- **Sabotage:**
  - S10, a resent body not metered: 1 failing test;
  - S11, OIDC without the `User-Agent`: 1 failing test.

## 8. A fetched response returned as it came (owner, 2026-10-21)

Found by the function sandbox's HTTP parity work (STUDY-171 §14, PR #812, its owner question Q-PR6-2): under `vm`, an
HTTP action returning its `fetch`'s response as it came (a proxy route, `return fetch(url)`) failed with a 500
"Uncaught TypeError: Invalid state: ReadableStream is locked"; under `process` it was sent.

- **Convex** (`npm-packages/udf-runtime/src/23_response.ts` `convexJsonFromResponse`, at `72ce13c`): the fetched
  response is an HTTP action's response like any other: its status, its headers (the target's, `content-length`
  among them) and its body, streamed (checked against Convex's binary: a body of known length goes with its length,
  a streamed one chunked).
- **The bug:** the server reads the response's `body` twice (`runHttpAction`: whether there is one, then the stream
  it meters), and the action's response's `body` getter (`actionResponse`, `action-fetch.ts`) made a new stream that
  maps the native one's failures at each read: the second wrapper's reader found the native stream locked by the
  first's.
- **The fix:** the getter makes the wrapper once per response and keeps it on the response (Bun's own getter returns
  the same native stream each time), so `r.body === r.body`, as on any `Response`. The server is unchanged. A response the
  function sandbox's child makes from its host's (`asActionResponse`) shares the getter.
- **Tests:** `packages/server/test/action-fetch.test.ts` (+1: a proxy route of a whole body and of a stream, and
  `body` read twice inside an HTTP action); `packages/differential/test/http-proxy.test.ts` (7, against Convex's
  binary `precompiled-2026-10-10-72ce13c`, the app in `http-proxy-app/`: text, JSON, bytes, a 204, a 404, a stream
  and a followed redirect, compared off a raw socket: the status, the type, the target's own header,
  `content-length` or `transfer-encoding`, the body). Sabotage: the wrapper made anew at each read (`main`'s getter)
  fails the server test and 6 of the 7 oracle cases (all but the 204, which has no body).
- **Measurement** (the test VPS, 2 vCPUs, Bun 1.4.3, idle: `ps` checked first; ABAB, 2000 sequential requests per line
  after 200, the server and the fetch target in a process of their own; `bench/results/http-fetch-response/`, the
  final code's rounds in `final/`). p50 µs of six rounds each:

  | Line | `main` | this change |
  |---|---|---|
  | `fetch`, 1 KiB read whole (`arrayBuffer`) | 1957, 1003, 916, 944, 1031, 959 | 1005, 954, 948, 909, 1094, 947 |
  | `fetch`, 1 KiB read from its `body` stream | 1193, 907, 865, 872, 1486, 835 | 846, 828, 1032, 844, 967, 820 |
  | `fetch` returned as it came (a proxy) | a 500 | 977, 1023, 1025, 1006, 986, 986 |

  No cost shows (the `body` line's median 889 µs on `main`, 845 here). A first version kept the wrappers in a `WeakMap`
  by the native stream; its ten rounds (in `weakmap/`) put the `body` line's median ~75 µs above `main`'s, within the
  noise of a line that moves by ±50 % between rounds but in one direction, so the wrapper is kept on the response
  instead, which reads as `main` does.

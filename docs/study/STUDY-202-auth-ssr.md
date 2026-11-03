# STUDY-202 — Built-in auth under server rendering, and Next.js
<!-- index: built-in auth under server rendering (STUDY-191 §3.4 step 7): Convex Auth v2's `./ssr` (the refresh token in an httpOnly cookie; refresh, sign-out and the allowlisted sign-in proxy as WHATWG handlers; the Origin check) and `./ssr/nextjs` (the proxy, the Server Component token, the providers); written from convex/convex-auth `reboot` at db15c82e | no divergence of its own; `./ssr` built, `./ssr/nextjs` next (§3.4) -->

- **Status:** no divergence of its own, so nothing for the owner to decide. `./ssr` built; `./ssr/nextjs` and the
  example next (§3.4). The names and the cookie names follow C-4 (DV-577, rule 5), the proxy's
  wire names DV-307 and DV-315 (§4).
- **Scope:** STUDY-191 §3.4 step 7, "SSR and Next.js", taken before steps 4–6 (email, OAuth, passkeys) at the
  owner's request (2026-11-03). Everything the core of [STUDY-201](STUDY-201-auth-core.md) left out: `./ssr` and
  `./ssr/nextjs`, and an example app. The client side, `AuthClient` in its `"ssr"` model, was built with the core
  (STUDY-201 §1.12, 5a).
- **Convex source read:** convex/convex-auth `origin/reboot` at **`db15c82e`**, STUDY-201's pin. The branch tip on
  2026-11-03 is two commits ahead (`0c99276e` the 100-session cap, `07911f86` the refresh token's expiry), neither in
  `ssr/`. Paths are relative to `packages/core/src/` unless they say otherwise.
- **Dependencies inspected:** `cookie` 1.1.1 (`parse`, `serialize`) and `jose`'s `decodeJwt`, the two libraries
  `ssr/` imports; `next` 16 (`next/headers` `cookies`, `next/server` `connection`, `NextRequest`, `NextResponse`).
- **bunvex source:** `main` at `31da95da` (2026-11-03).
- **Related:** [STUDY-191](STUDY-191-convex-auth-v2.md) §1.7 and §3.4; [STUDY-201](STUDY-201-auth-core.md) (the core,
  C-4, C-5); [STUDY-46](STUDY-46-nextjs.md) (`@bunvex/nextjs`, `preloadQuery`); [STUDY-67](STUDY-67-http-function-api.md)
  (the HTTP function API the proxy forwards to).

## 1. How Convex does it

### 1.1 The model

In a single-page app the browser keeps both tokens (STUDY-201 §1.12). Under server rendering the **refresh token
never reaches the page's JavaScript**:

- the app's own server (the "SSR host": Next.js, or any framework that speaks WHATWG `Request`/`Response`) keeps it in
  an httpOnly cookie, with the access token in a second cookie;
- the page gets the access token alone, a "slim" bundle (`makeSlimBundle`, `lib/types.ts`: the bundle without
  `refreshToken`);
- three routes on the SSR host do what the SPA's client does against the deployment: **refresh**, **sign-out**, and
  **sign-in**, the last a proxy that forwards a sign-in function's call and moves the minted refresh token into the
  cookie on the way back.

The browser side is `AuthClient` in mode `"ssr"` (`browser/sessionManager.ts`), already in bunvex: it posts to the
refresh and sign-out routes and refuses a full bundle (`[convex-auth] Received a refresh token in an SSR response`).

The package exports two entry points (`package.json:77-90`):

| Entry | Source | Exports |
|---|---|---|
| `./ssr` | `ssr/index.ts` | `AUTH_JWT_COOKIE`, `AUTH_REFRESH_COOKIE`, `writeAuthCookies`, `clearAuthCookies`, `httpCookies`, `serializeCookie`, `isTrustedOrigin`, `refreshHandler`, `signOutHandler`, `setupConvexAuthServer`, `convexProxyHandler`, `decodeAccessToken`, `isTokenExpiring`, `ServerAuthSession`, `createServerAuthChecker`, `makeSlimBundle`; types `AuthCookieOptions`, `CookieDeleteOptions`, `CookieOptions`, `CookieStore`, `HttpCookies`, `RefreshHandlerConfig`, `RequestHandler`, `SignOutHandlerConfig`, `ConvexAuthServerConfig`, `ConvexProxyConfig`, `ExposedSignInFn`, `DecodedAccessToken`, `RefreshSession`, `ServerAuthSessionConfig`, `ServerAuthChecker`, `ServerAuthCheckerConfig`, and the shared types of `lib/types.ts` (`AuthSessionResponse`, `ClientView`, `ConvexAuthApi`, `IsAuthenticatedFn`, `RefreshSessionFn`, `SignInComplete`, `SignInEnvelope`, `SignInError`, `SignInStatus`, `SignOutFn`, `SlimTokenBundle`, `TokenBundle`) |
| `./ssr/nextjs` | `ssr/nextjs/index.tsx`, `client.tsx` | `setupConvexAuthNextjs`; types `ConvexAuthNextjsConfig`, `ConvexAuthNextjsProxyCtx`, `ConvexAuthNextjsProxyHandler`. `client.tsx` (`"use client"`, `ConvexAuthNextjsProvider`) is reached through the server provider's dynamic import |

`next` (`^16.0.0`) and `react` are optional peer dependencies; `cookie` and `jose` are dependencies.

### 1.2 Cookies (`ssr/cookies.ts`, `ssr/httpCookies.ts`)

- **Names:** the browser storage keys, without the namespace: `AUTH_JWT_COOKIE = JWT_STORAGE_KEY`,
  `AUTH_REFRESH_COOKIE = REFRESH_TOKEN_STORAGE_KEY` (`cookies.ts:24-29`). In bunvex they are already `__bunvexAuthJWT`
  and `__bunvexAuthRefreshToken` (C-4, DV-577).
- **Attributes**, the same for both cookies (`authCookieOptions`, `cookies.ts:96-112`): `httpOnly: true`,
  `sameSite: "lax"`, `path` (default `/`), `domain` if given, `secure` (required in `AuthCookieOptions`), and
  `expires` at the **refresh token's** expiry (`refreshTokenExpiresAt`). The fields are picked one by one so a wider
  object from untyped JavaScript cannot turn `httpOnly` off. The access-token cookie outlives its token on purpose:
  an expired one is what tells the host to refresh.
- **`CookieStore`**: `get`, `set`, `delete`, each possibly async, so a framework's store fits (Next's `cookies()`).
  `writeAuthCookies` sets the JWT then the refresh token; `clearAuthCookies` deletes both with the same `path`/`domain`
  (`path` defaulting to `/`, as the write does).
- **`httpCookies(request)`**: the store for a WHATWG request. It parses the `Cookie` header with `cookie.parse`, keeps
  an overlay so a read after a write in the same request sees the write, and queues `Set-Cookie` lines
  (`cookie.serialize`) that `applyTo(headers)` appends. A delete serializes an empty value with `Max-Age=0` and
  `Expires=Thu, 01 Jan 1970 00:00:00 GMT`.
- **`serializeCookie(name, value, options)`**: `path` defaults to `/`, `maxAge` is floored; the rest passes through.
  `cookie.serialize` throws a `TypeError` on a name or value outside RFC 6265's characters, and encodes the value
  with `encodeURIComponent`.

### 1.3 The token on the host (`ssr/jwt.ts`, `ssr/session.ts`)

- **`decodeAccessToken(token)`** → `{ exp, sub }`, each `null` when absent, of the wrong type, or when `jose`'s
  `decodeJwt` throws (not three base64url parts, a payload that is not a JSON object). **No signature check**: the
  host only schedules refreshes with it; authentication is the deployment's.
- **`isTokenExpiring(token, skewSeconds = 10, nowMs = Date.now())`**: `true` without `exp`, or when
  `exp * 1000 - now <= skew * 1000`.
- **`ServerAuthSession`** ({ `refreshSession`, `cookies`, `refreshSkewSeconds` = 10, `cookieOptions` }):
  - `getToken()`: the JWT cookie when it is not expiring within the skew; else `refresh()`, and the new access
    token if it rotated, else `null`;
  - `refresh()`: no refresh cookie → `{ kind: "noSession" }` without a call; else calls `refreshSession(token)`;
    `rotated` writes both cookies, `noSession` clears both; returns the result;
  - `setTokens(bundle)`: writes both cookies.
  An error from `refreshSession` (network, deployment down) propagates; the cookies are left as they were.

### 1.4 The handlers (`ssr/handlers.ts`, `ssr/origin.ts`, `ssr/setup.ts`)

Each is a `(Request) => Promise<Response>` built from a config with `convexUrl`, the mutation it calls, the cookie
options and `allowedOrigins`. Each builds one `ConvexHttpClient` when created, not per request.

- **The Origin check first** (`isTrustedOrigin`): no `Origin` header, or `"null"`, or one that is not a URL →
  refused. Trusted when the origin's host (with port) equals the request's `Host` header, or equals the host of one of
  `allowedOrigins` (an entry without `://` is compared as a host). Refused → **403** with `{"tokens":null}`, before
  any call or cookie.
- **`refreshHandler`**: `ServerAuthSession.refresh()` on the request's cookies. `noSession` → **401**
  `{"tokens":null}` (and both cookies cleared if there was a refresh cookie); `rotated` → **200**
  `{"tokens":<slim bundle>}` with both cookies set. A failing call is an unhandled rejection (the framework's 500).
- **`signOutHandler`**: with a refresh cookie, calls `signOut({ refreshToken })` and ignores any error; then clears
  both cookies; **200** `{"tokens":null}`.
- **`setupConvexAuthServer(config)`**: `{ convexUrl, refreshSession, signOut, signIn, cookieOptions,
  allowedOrigins? }` → `{ refreshHandler, signOutHandler, convexProxyHandler }`, all sharing the cookie options, so
  `secure` is decided once.

### 1.5 The sign-in proxy (`ssr/signInProxy.ts`)

Sign-in has no per-method route. The browser calls a method's usual hook; under SSR its calls go to a
`ConvexHttpClient` whose address is the sign-in route plus `?path=` (`ssr/nextjs/client.tsx`), so the client's
`<address>/api/mutation` becomes `/auth/signin?path=/api/mutation`: one static route serves every call, and arguments
and errors keep the HTTP client's encoding. `convexProxyHandler({ convexUrl, signIn, cookieOptions, allowedOrigins })`:

1. Origin check (403 as above).
2. `path` query parameter: exactly `/api/query`, `/api/mutation` or `/api/action`, else **404** text
   `Not an auth proxy endpoint.`
3. Body: an object with a string `path`, `format` exactly `convex_encoded_json`, `args` an array of one element;
   anything else, or a body that is not JSON → **400** text `Malformed Convex function call.`
4. `path` must be one of the allowlisted functions (`getFunctionName` of each `signIn` entry): else **403** text
   `<path> is not exposed through the auth proxy.` The allowlist is the proxy's whole surface.
5. Forwards `POST <convexUrl>/api/<kind>` with `content-type: application/json`, the `convex-client` and
   `authorization` headers if the request had them (a sign-in that links to the current user carries its token), and
   the same `{ path, format, args }`.
6. Upstream not OK and not **560** (a function's error) → its status and text, as text. Not `"success"` → the payload
   as JSON with the upstream status (the client rethrows the function's error as it would against the deployment).
7. A success whose value is not the shared envelope → **500** text `<path> did not return a sign-in result. The
   sign-in functions must return the shared envelope ({ status: "complete", tokens } or { status: "error",
   userError }).` The envelope: `status: "complete"` with a bundle whose `accessToken`, `refreshToken` and `userId`
   are strings and `refreshTokenExpiresAt` a number; or `status: "error"` without `tokens`.
8. `"error"` → forwarded as is. `"complete"` → both cookies written, `value.tokens` replaced by the slim bundle, the
   payload forwarded with `Set-Cookie`.

### 1.6 Checking a session on the host (`ssr/isAuthenticated.ts`)

`createServerAuthChecker({ convexUrl, isAuthenticated })` → `(accessToken) => Promise<boolean>`: `false` for `null` or
an expired token without a call; else a fresh `ConvexHttpClient` with `setAuth(token)` calls the app's
`isAuthenticated` query (STUDY-201: the live session, not just the signature), and any error is `false`. A forged or
revoked cookie therefore never passes.

### 1.7 Next.js (`ssr/nextjs/index.tsx`)

`setupConvexAuthNextjs({ convexUrl, refreshSession, isAuthenticated, cookieOptions? })`. `secure` defaults to
`process.env.NODE_ENV === "production"` (Next sets it for `next build`/`next start`), so cookies work over http on
`next dev`. It returns:

- **`convexAuthNextjsProxy(handler?)`**, for Next 16's `proxy.ts` (formerly middleware): per request, a
  `ProxyCookieStore` over `request.cookies` (an overlay plus an ordered list of set/delete operations),
  `session.getToken()` up front (refreshing if the access token expires within 10 s and rewriting both cookies),
  then the app's handler with `{ isAuthenticated, getToken }`. The handler's response, or `NextResponse.next()`,
  gets the cookie operations applied. So a page rendered after the proxy reads a fresh token.
- **`nextjsProxyRedirect(request, path)`**: `NextResponse.redirect(new URL(path, request.url))`.
- **`convexAuthNextjsAccessToken()`**, for Server Components and Server Actions: the JWT cookie through
  `next/headers`' `cookies()`, `null` if absent or expired (skew 0). It awaits `connection()` before reading the
  clock, because Next refuses `Date.now()` in a prerender with Cache Components until the render opts into request
  time. It never refreshes: a Server Component cannot set cookies; the proxy refreshed already.
- **`isAuthenticatedNextjs()`**: the checker on that token.
- **`ConvexAuthNextjsServerProvider`**, an async Server Component: reads the token as above and renders the client
  provider (dynamically imported, so the server module does not pull client code) with `convexUrl` and
  `initialToken`. A TODO says the routes cannot be configured from here yet: they are `/auth/signin`,
  `/auth/refresh`, `/auth/signout`.

### 1.8 Next.js, the client (`ssr/nextjs/client.tsx`)

`ConvexAuthNextjsProvider({ client?, convexUrl?, initialToken, refreshRoute = "/auth/refresh", signOutRoute =
"/auth/signout", signInRoute = "/auth/signin", storage?, ambientSignIns?, children })`, built once per
`client`/`convexUrl`:

- the backend client: `client`, or a new `ConvexReactClient(convexUrl ?? NEXT_PUBLIC_CONVEX_URL)`;
- the sign-in API: a `ConvexHttpClient(signInRoute + "?path=", { skipConvexDeploymentUrlCheck: true, logger })`,
  given the current access token before each call (`setAuth`/`clearAuth`);
- `AuthClient` in mode `"ssr"`: `refreshSession` posts `{}` to the refresh route and takes `tokens` (a body that is
  not JSON counts as `{ tokens: null }`); `signOut` posts to the sign-out route; `storageNamespace` is the backend
  client's URL; `initialAccessToken` the server's token; the ambient sign-ins (default `[oauth()]`) run their
  non-envelope calls on the backend client;
- `replaceUrl`, for an ambient sign-in stripping its callback parameters: `history.replaceState` now, then again with
  `null` state on the next tick, so Next's router (which keeps its own copy of the URL and patches `replaceState`
  after this code first runs) does not write the parameters back;
- renders `AuthProvider` and `ConvexProviderWithAuth`, as the SPA provider does.

### 1.9 The example (`examples/nextjs/`)

App Router, Next 16: `src/lib/serverAuth.ts` (`setupConvexAuthServer`, the allowlist: anonymous, username + password
sign-in and sign-up, GitHub's completion), `app/auth/{signin,refresh,signout}/route.ts` (each `export const POST =`
one handler), `src/lib/convexAuth.tsx` (`setupConvexAuthNextjs`), `proxy.ts` (redirect to `/signin` when signed out,
to `/` when signed in on an auth page; the matcher skips `/auth/*` and Next's assets), `app/layout.tsx` (the server
provider), `app/page.tsx` (`preloadQuery` of the signed-in user with the cookie's token, so the first paint is signed
in), sign-in and sign-up pages using the methods' ordinary hooks. It has no tests.

### 1.10 Upstream's tests

68 tests, vitest:

| File | Tests | What |
|---|---|---|
| `ssr/cookies.test.ts` | 4 | the attributes, the invariant ones not overridable, clearing |
| `ssr/httpCookies.test.ts` | 11 | parsing, the overlay, `Set-Cookie` lines, deletes |
| `ssr/session.test.ts` | 7 | `getToken`/`refresh` outcomes and the cookies they leave |
| `ssr/handlers.test.ts` | 9 | refresh 200/401, sign-out, the 403s |
| `ssr/origin.test.ts` | 9 | `isTrustedOrigin`'s cases |
| `ssr/isAuthenticated.test.ts` | 5 | the checker |
| `ssr/signInProxy.test.ts` | 20 | every status of §1.5, the forwarded headers, the slim bundle |
| `ssr/nextjs/oauth.test.tsx` | 3 | OAuth under the Next provider: start on the backend client, the callback through the proxy, the router-aware URL strip |

### 1.11 What is moving

Unmerged branches touch this code: `ssr-single-handler` (2026-10-23, one route instead of three),
`nicolas/ssr-gettoken-refresh-failure`, `nicolas/ssr-signin-proxy-errors`, `nicolas/ssr-refresh-result-docs`. They
come by the daily triage if they land (STUDY-191 §3.5). `nicolas/nextjs-connection-before-clock` is already in the
pin (§1.7).

## 2. What an app can observe

- **The API**: the two entry points and their exports (§1.1), in bunvex's names (§3.2).
- **The cookies**: two names, their attributes and lifetime, the order of the `Set-Cookie` lines, a delete's form.
- **The handlers' responses**: status, body (JSON or text, the messages of §1.5) and `Set-Cookie`, for each case of
  §1.4 and §1.5, including the 403 before any work.
- **Which calls reach the deployment**: none on a refused origin, path or function; the forwarded headers.
- **Next.js**: the proxy refreshing before the page renders; the token a Server Component reads; `secure` by
  `NODE_ENV`; the default routes; the client provider's behaviour through `AuthClient`.

## 3. How bunvex does it

### 3.1 Where

In `@bunvex/auth`, as v2: `./ssr` (`components/auth/src/ssr/`) and `./ssr/nextjs` (`src/ssr/nextjs/`), with `next`
an optional peer dependency (Next 16, as v2 and bunvex's Next.js examples). `./ssr/nextjs` takes the HTTP client from
`@bunvex/client` and the React pieces from `@bunvex/react`, as `@bunvex/nextjs` does (STUDY-46).

**This code runs in the SSR host, not in Bun:** `next dev`/`next start` run on Node (and `proxy.ts` may run on the
edge runtime). So `./ssr` uses only WHATWG and ECMAScript APIs: no `Bun.*`, no `node:*`, no `Buffer` (STUDY-201's
browser code has the same constraint).

**No `cookie` or `jose`.** The two uses are small: a JWT payload decode (base64url and `JSON.parse`, as
`@bunvex/client`'s `decodeJwtPayload`) and RFC 6265 cookie parsing and serializing. bunvex writes them, and the tests
check them byte for byte against `cookie@1.1.1`'s `parse`/`serialize` and `jose`'s `decodeJwt` as dev dependencies,
over the same cases plus a generated corpus (§5). What an app observes is unchanged, so this is not a divergence.

### 3.2 Names (C-4, rule 5)

Convex's names with "convex" made "bunvex" (STUDY-201 C-4, DV-243's rule):

| v2 | bunvex |
|---|---|
| `setupConvexAuthServer`, `ConvexAuthServerConfig` | `setupBunvexAuthServer`, `BunvexAuthServerConfig` |
| `convexProxyHandler`, `ConvexProxyConfig` | `bunvexProxyHandler`, `BunvexProxyConfig` |
| `setupConvexAuthNextjs`, `ConvexAuthNextjsConfig` | `setupBunvexAuthNextjs`, `BunvexAuthNextjsConfig` |
| `convexAuthNextjsProxy`, `ConvexAuthNextjsProxyCtx`, `ConvexAuthNextjsProxyHandler` | `bunvexAuthNextjsProxy`, `BunvexAuthNextjsProxyCtx`, `BunvexAuthNextjsProxyHandler` |
| `convexAuthNextjsAccessToken` | `bunvexAuthNextjsAccessToken` |
| `ConvexAuthNextjsServerProvider`, `ConvexAuthNextjsProvider` | `BunvexAuthNextjsServerProvider`, `BunvexAuthNextjsProvider` |
| the option `convexUrl` | `bunvexUrl` |
| `ConvexAuthApi` (type) | `AuthApi`, as the core already exports it (STUDY-201 4c) |
| `NEXT_PUBLIC_CONVEX_URL` | `NEXT_PUBLIC_BUNVEX_URL` (what `bunvex dev` writes, STUDY-40) |
| cookies `__convexAuthJWT`, `__convexAuthRefreshToken` | `__bunvexAuthJWT`, `__bunvexAuthRefreshToken` (the storage keys, DV-577) |
| `Malformed Convex function call.` | `Malformed function call.` |

The rest keeps v2's names (`refreshHandler`, `signOutHandler`, `isTrustedOrigin`, `ServerAuthSession`, …) and its
messages.

### 3.3 The proxy's wire

The proxy speaks the HTTP client's wire, and bunvex's is bunvex-named: the body's `format` is `encoded_json`
(DV-307) and the client header `Bunvex-Client` (DV-315). The proxy checks and forwards those, so
`BunvexHttpClient(signInRoute + "?path=", { skipDeploymentUrlCheck: true })` works unchanged: it already builds
`<address>/api/<kind>` and treats 560 as a function's error. No new divergence: the proxy follows the wire it fronts.

### 3.4 The build, in PRs

1. **This study.**
2. **`./ssr`**: cookies, `httpCookies`, the JWT helpers, `ServerAuthSession`, the handlers, the Origin check,
   `setupBunvexAuthServer`, the proxy, the checker. The 65 tests of §1.10 outside `nextjs/` ported; the cookie and
   JWT corpus against `cookie` and `jose`; the differential test (§5). Built: `components/auth/src/ssr/`;
   `test/ssr-cookies.test.ts` (the cookie tests and the corpus, 20 000 headers and 20 000 `Set-Cookie` lines each
   compared with `cookie@1.1.1`) and `test/ssr-routes.test.ts` (the rest, against a stand-in deployment over HTTP);
   `packages/differential/test/auth-ssr.test.ts` (25 steps through each side's routes with its own HTTP client: every
   status, body and `Set-Cookie` line the same, once named alike). The cookie names moved to `lib/storageKeys.ts`, so
   the server side names them without the browser's code.
3. **`./ssr/nextjs`** and the example `examples/auth-nextjs` (username + password and anonymous; GitHub waits for
   OAuth), with an end-to-end test that runs `next start` against a deployment (§5), and the examples checklist
   (the site's example count, the sandbox parity corpus, `examples/README.md`). Of `oauth.test.tsx`, the callback
   through the proxy and the router-aware URL strip are ported with the inert `oauth()` client (STUDY-201 C-5) and a
   pending flow seeded in storage; "start on the backend client" needs a provider's hook and comes with OAuth.

## 4. Divergences

None of its own.

| # | Divergence | Why | Decision |
|---|---|---|---|
| — | The names of §3.2 and the cookie names | rule 5 | C-4: DV-577, extended, and rule 5 (owner, 2026-11-01) |
| — | The proxy accepts and forwards `format: "encoded_json"` and `Bunvex-Client`, not `convex_encoded_json` and `convex-client` | the wire the proxy fronts is bunvex's | DV-307, DV-315 |

## 4b. Additions

None.

## 5. Tests

- **Ported:** the 68 tests of §1.10, with bunvex's names (one of `oauth.test.tsx` deferred to OAuth, §3.4).
- **Cookies and JWT, against the libraries:** `serializeCookie` and `httpCookies`' parsing against
  `cookie@1.1.1` over the upstream cases and a generated corpus (quoted values, `%` escapes, duplicates, empty and
  malformed pairs, characters outside RFC 6265, which must throw the same `TypeError`); `decodeAccessToken` against
  `jose`'s `decodeJwt` (wrong part counts, bad base64url, a payload that is not an object, `exp`/`sub` of the wrong
  type).
- **Differential, v2 against bunvex:** v2's `./ssr` handlers at the pin (built by `harness/convex-auth.ts`, as in
  `packages/differential/test/auth-*.test.ts`) against Convex's binary, and bunvex's against bunvex, both called
  with the same `Request`s: refresh with no cookie, a valid, a rotated-away and a garbage refresh cookie; sign-out with
  and without; the proxy with each refusal of §1.5, an allowlisted sign-up, a wrong password (the `"error"` envelope),
  a function that throws (560), a non-envelope result; the Origin cases. Compared: status, body (tokens replaced by
  their shape), and the `Set-Cookie` lines with the cookie names mapped and token values and dates masked.
- **End to end:** the example's Next server (`next build`, `next start` on a free port) against a bunvex deployment:
  sign up through `/auth/signin` with a `BunvexHttpClient` pointed at it; the response carries the slim bundle and
  both cookies (httpOnly, SameSite=Lax); `GET /` with the cookies renders the signed-in user in the HTML; `/` without
  them redirects to `/signin`; an access token about to expire is refreshed by `proxy.ts` (new `Set-Cookie`);
  `/auth/refresh` and `/auth/signout`; a request with a foreign `Origin` gets 403.
- **Sabotage:** drop the Origin check, let a non-allowlisted function through, leak the refresh token in the body,
  forget `httpOnly`: each must fail a test.

## 6. Open questions

None: no divergence needs the owner. Should a branch of §1.11 land upstream before PR 3 merges, it is triaged then.

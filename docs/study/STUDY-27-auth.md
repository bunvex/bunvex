# STUDY-27 — Authentication (`ctx.auth`, JWT / OIDC, the sync and client auth flow)

- **Status:** accepted: A1–A3 and A5 as recommended (owner, 2026-09-30)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:**
  - roadmap Phase 3 item 1;
  - DV-11 (only `None` accepted), DV-12 (identity in every execution key), DV-97 (admin auth scheme);
  - STUDY-08 D6 / B13 (identity in cache keys);
  - STUDY-23 §4.6, STUDY-26 C6 / R3 (client `setAuth`, React helpers).

## 1. How Convex does it

### 1.1 Configuration (`npm-packages/convex/src/server/authentication.ts`, `crates/isolate/src/environment/auth_config.rs`, `crates/common/src/auth.rs`)

- **The file.** An app declares its providers in `convex/auth.config.ts`, whose default export is
  `{ providers: AuthProvider[] }`. A provider is one of:
  - **OIDC:** `{ domain, applicationID }`, optionally `type: "oidc"`. `domain` is the issuer, and
    `applicationID` is the `aud` the tokens must carry.
  - **Custom JWT:** `{ type: "customJwt", issuer, jwks, algorithm: "RS256" | "ES256", applicationID? }`.
    `jwks` is a URL, and may be a `data:` URL.
- **Evaluation.** The file is evaluated at push time, in a restricted environment: it may read environment
  variables and nothing else (no `Date`, `Math.random`, imports or console). The result is stored in the
  deployment (`AuthInfoModel`).
- **Validation, with specific errors:**
  - `applicationID` must be spelled exactly so;
  - a `customJwt` may not have a `domain`, and an OIDC provider may not have an `issuer`;
  - an unknown `type` is an error;
  - a WorkOS issuer without an `applicationID` is refused as `InsecureConfiguration`, since the issuer is
    shared by many applications;
  - a missing default export is `AuthConfigMissingExportError`.

### 1.2 Verifying a token (`crates/authentication/src/lib.rs` `validate_id_token`)

- **Choosing the provider.** From the JWT's *unverified* payload, Convex reads `iss` (required) and `aud`
  (one or many). The first provider that matches wins:
  - the issuer is compared with `https://` added when missing, ignoring a trailing `/`;
  - `aud` must contain the provider's `applicationID` when the provider has one.

  No match is an `Unauthenticated` `NoAuthProvider` error, which lists the configured providers unless
  errors are redacted.
- **OIDC.**
  1. OpenID Connect discovery runs on the issuer.
  2. The token is verified against the provider's JWKS with algorithms RS256 or EdDSA (Ed25519).
  3. `iss` and `aud` must match, and the token must not be expired.

  Failures are `AuthProviderDiscoveryFailed`, `InvalidAuthHeader` and `Unauthenticated`, each with a
  message naming what to check.
- **Custom JWT.**
  1. The JWKS is fetched (`application/json` or `application/jwk-set+json`), or decoded from a `data:` URL.
  2. The token is decoded with the configured algorithm and the `kid`.
  3. `iss` and `aud` are checked again.
  4. The time claims are validated with **5 s** of leeway, and `exp` is required.
- **Caching.** Discovery and JWKS responses go through an HTTP client that caches by the responses'
  `Cache-Control` headers (`http_client` `CachedHttpClient`, `HttpCache` with `CacheMode::Default`).
- **The HTTP header** (`crates/local_backend/src/authentication.rs`):
  - `Authorization: Bearer <jwt>` is a user;
  - `Authorization: Convex <admin key>[:<base64 acting-as identity>]` is an admin;
  - `?adminKey=` also works for admins;
  - a malformed header is `HeaderParseFailure` or `InvalidAuthHeader`, as Unauthenticated (401) or
    BadRequest (400).

### 1.3 The identity a function sees (`crates/keybroker/src/broker.rs`, `crates/convex/sync_types/src/types/json.rs`)

- **`ctx.auth.getUserIdentity()`** returns `null`, or a `UserIdentity`:
  - **`tokenIdentifier`** = `"<issuer>|<subject>"`;
  - **`subject`**, **`issuer`**;
  - the standard OIDC claims as camelCase fields: `name`, `givenName`, `familyName`, `nickname`,
    `preferredUsername`, `profileUrl`, `pictureUrl`, `email`, `emailVerified`, `gender`, `birthday`,
    `timezone`, `language`, `phoneNumber`, `phoneNumberVerified`, `address`, `updatedAt`;
  - every other claim **at the top level** (custom claims).
- **Claims that vary across refreshes** are dropped so they do not bust the cache: `jti`, `nbf`, and
  `fva` (Clerk's factor verification age). So are the registered claims (`exp`, `iat`, `aud`, …).
- **Custom JWT quirk.** Nested objects in custom claims are flattened into dotted keys (`"a.b": value`),
  and the standard claims are custom claims there (same keys). OIDC keeps nested values as they are.
- **Actions** pass their identity to `ctx.runQuery` / `ctx.runMutation`.

### 1.4 Identity and caching (`crates/application/src/cache/mod.rs`)

- A query result is cached **with the identity only if the execution read it**
  (`outcome.observed_identity`, set by `getUserIdentity`). Otherwise the entry is stored without an
  identity and serves every user.
- A lookup tries the precise key (path, args, identity, journal), then the identity-free one.
- The identity part of the key is the user's **attributes**, not the token, so a refreshed token with the
  same claims hits the same entry.

### 1.5 The sync protocol (`crates/sync/src/worker.rs`, `state.rs`, `crates/local_backend/src/subs/mod.rs`)

- **`Authenticate {tokenType: "User", value, baseVersion}`:** the token is verified (§1.2), the session's
  identity is replaced, and the identity version is bumped. Every query then runs again.
- **A token that fails** is an `AuthUpdateFailed` error. The connection ends with
  `AuthError {error, baseVersion, authUpdateAttempted: true}` and no close frame.
- **Expiry.** Before using the identity, the worker checks it against the clock.
  - An expired user identity is `Unauthenticated "TokenExpired"`, and the connection ends with
    `AuthError {authUpdateAttempted: false}`.
  - An identity about to expire (admins) is revalidated.
- **`Admin` tokens** (`value`, `impersonating?`) are the dashboard's. They are verified as admin keys
  (roadmap Phase 3 item 6).

### 1.6 The client (`browser/sync/authentication_manager.ts`)

- **`setAuth(fetchToken, onChange, onRefreshChange?)`:**
  1. The socket is paused while the first token is fetched with `{forceRefreshToken: false}`, so no
     query runs unauthenticated first.
  2. The token is sent as `Authenticate`, and the socket resumes.
- **Confirmation.** The server confirms the token by a Transition whose `endVersion.identity` advanced.
  - For a cached token, the client then refetches a fresh one (`forceRefreshToken: true`), unless
    `initialAuthTokenReuse` is set.
  - For a fresh one, it calls `onChange(true)` once and schedules a refetch.
- **The scheduled refetch** happens at `exp − leeway`, where the leeway defaults to 10 s
  (`authRefreshTokenLeewaySeconds`).
  - The time uses `clientClockSkew` when known, and is capped at 20 days.
  - Tokens without `iat`/`exp`, or living ≤ 2 s, are not refetched (an error is logged).
- **On an `AuthError`:** the client stops the socket, force-refreshes the token, and reconnects.
  - After **2** failed confirmations of fresh tokens, or with no token at all, it clears auth, calls
    `onChange(false)`, and logs `Failed to authenticate: "<error>", check your server auth config`.
  - Stale AuthErrors (an older identity version) and token-expired errors received while waiting for a
    confirmation are ignored.
- **Races.** A config version guards them: a `setAuth` or `clearAuth` during a fetch discards that
  fetch's result. `clearAuth()` sends `Authenticate None`.
- **A quirk apps observe.** When a fresh token is confirmed, `onTransition` schedules the next refetch
  (which replaces the auth state) before it reads `hadAuth`, so `onChange(true)` runs again on every
  confirmed fresh token, refreshes included. `@bunvex/client` does the same; the differential test pins it.

### 1.7 React (`react/ConvexAuthState.tsx`, `react/auth_helpers.tsx`, `react-clerk/`, `react-auth0/`)

- **`ConvexProviderWithAuth({client, useAuth})`.** `useAuth()` returns
  `{isLoading, isAuthenticated, fetchAccessToken}` from the auth library.
  - While the library is authenticated, the provider calls `client.setAuth(fetchAccessToken, …)`.
  - When the library stops being authenticated, it calls `clearAuth()`.
- **`useConvexAuth()`** returns `{isLoading, isAuthenticated, isRefreshing}`. Outside the provider it
  throws "Could not find `ConvexProviderWithAuth` …".
- **`<Authenticated>`, `<Unauthenticated>`, `<AuthLoading>`, `<AuthRefreshing>`** render their children
  by that state.
- **`ConvexProviderWithClerk` / `ConvexProviderWithAuth0`** adapt each library's hook into `useAuth`.

## 2. What an app can observe

- **The `auth.config` shape** and its validation errors.
- **Which tokens are accepted:**
  - issuer and audience matching, as in §1.2;
  - the RS256 / EdDSA (OIDC) and RS256 / ES256 (custom) algorithms;
  - `exp` with 5 s of leeway (custom JWT).
- **`ctx.auth.getUserIdentity()`:**
  - the exact fields, including `tokenIdentifier = iss|sub`;
  - custom claims at the top level, and the dropped claims;
  - the flattening of nested custom-JWT claims;
  - `null` without a token.
- **Errors:**
  - HTTP 401 for a bad or expired token;
  - over the socket, `AuthError` and the client's reaction (refresh, then give up after 2).
- **Read-your-identity:** after `setAuth`, no query result computed without the identity reaches the app.
- **Isolation:** one user's cached or shared query result never reaches another. A query that does not
  read the identity is shared by everyone.
- **The React states** and components.

## 3. How bunvex does it

**`@bunvex/auth`** (the package stub exists) holds the configuration types and their validation, token
verification (OIDC discovery, JWKS, the custom JWT path), and the identity mapping of §1.3. Its
dependency rule (ARCHITECTURE) is that only `@bunvex/server` uses it.

- **Configuration.** bunvex has no push step yet (Phase 3 item 7, the CLI). The app passes its config to
  the server, e.g. `createServer({ ..., auth: authConfig })`, where `authConfig` is the default export of
  its `bunvex/auth.config.ts`.
  - The config has the same shape and the same validation and messages, with bunvex's names.
  - It is validated when the server starts, which is where a bunvex app "pushes".
- **Verification**, on Bun's WebCrypto through a JWT library (A2), with:
  - discovery and JWKS cached by `Cache-Control`;
  - a refetch when a token names an unknown `kid`, rate-limited, so key rotation works without a restart.
- **HTTP.** `Authorization: Bearer` gives the call its identity, and a bad token answers **401** with
  Convex's codes. `Authorization: Bunvex <admin key>` (DV-97) waits for admin keys (Phase 3 item 6).
- **`ctx.auth.getUserIdentity()`** in queries, mutations and actions. Actions pass the identity to their
  `runQuery` / `runMutation`.
  - The engine records that the execution read the identity (as Convex's `observe_identity`).
  - The query cache then keys it by identity attributes, or not, as in §1.4. This closes **B13**.
- **Sync.**
  - `Authenticate User` is verified, `AuthError` answers a failed one, and the identity is checked at use
    for `TokenExpired`.
  - The identity version bumps and every query re-runs.
  - Shared executions key by identity only when the run read it, which refines DV-12 to Convex's
    precision.
  - This closes **DV-11**.
- **Client and React.**
  - `@bunvex/client` gets the authentication manager of §1.6: `setAuth`, `clearAuth`, `getAuth`, and the
    `authRefreshTokenLeewaySeconds` / `expectAuth` / `initialAuthTokenReuse` options.
  - `@bunvex/react` gets `BunvexProviderWithAuth`, `useBunvexAuth`, `Authenticated`, `Unauthenticated`,
    `AuthLoading` and `AuthRefreshing`.
- **Order of PRs:**
  1. `@bunvex/auth` (config, verification, identity), plus `ctx.auth` and the HTTP header;
  2. the identity-aware query cache (B13);
  3. sync `Authenticate User`, expiry, and identity in shared executions;
  4. the client authentication manager;
  5. the React helpers.

  Tests use a local issuer (an in-process OIDC discovery + JWKS server with keys generated per test) and
  the official `convex` client as the oracle (`setAuth`).

## 4. Divergences

Recorded in [docs/parity/divergences.md](../parity/divergences.md): A1 as DV-100, A3 as DV-101, A4 under DV-03/DV-04, A5
under Gaps; A2 is an implementation choice, not a divergence.

| # | Divergence | Why | Decision |
|---|---|---|---|
| A1 | The config is passed to `createServer({ auth })` and validated at server start, from `bunvex/auth.config.ts`; Convex evaluates `convex/auth.config.ts` at push time, in a sandbox that only exposes environment variables | bunvex has no push step yet (the CLI, Phase 3 item 7), and it runs app code in its own process (DV-02) | **accepted** (revisit with the CLI) |
| A2 | Verification uses the `jose` library (MIT, the standard JOSE implementation for JS, on WebCrypto) instead of writing JWS/JWK handling from scratch | Security-critical code; `jose` covers RS256, ES256 and EdDSA, JWK import and JWKS selection | **accepted: `jose`** |
| A3 | Discovery and JWKS are cached by `Cache-Control` (as Convex), plus a rate-limited refetch on an unknown `kid` | Convex's HTTP cache serves a stale JWKS until it expires; the refetch makes key rotation work at once | **accepted** |
| A4 | Messages name bunvex (`bunvex/auth.config.ts`, the `Bunvex` admin scheme) and drop docs links | Owner's naming rule (DV-03/DV-04) | follows the rule |
| A5 | Clerk and Auth0 providers (`BunvexProviderWithClerk` / `…WithAuth0`) come after `BunvexProviderWithAuth` | They wrap third-party libraries; the generic provider covers them meanwhile | **accepted** later |

Everything else follows Convex: the provider matching, both verification paths, the identity's fields and
quirks (the dropped claims, the custom-JWT flattening), 5 s of leeway, the 401s, `AuthError` and
`TokenExpired`, the observed-identity cache, and the client's refresh rules.

## 5. Tests

- **Config:**
  - every validation error of §1.1, with its message;
  - `type: "oidc"`, a `data:` JWKS, and the WorkOS check.
- **Verification**, against an in-process issuer:
  - the OIDC and custom paths;
  - every algorithm;
  - wrong `iss` / `aud` / `kid`, expired tokens (and inside the 5 s leeway), missing `exp`;
  - provider matching with and without `https://` or a trailing `/`;
  - JWKS rotation;
  - `Cache-Control` honored.
- **Identity:** fields, `tokenIdentifier`, custom claims, the dropped claims and the flattening.
- **HTTP:** a Bearer token gives `getUserIdentity`, a bad token gives 401, and an action passes the
  identity on.
- **Cache (B13):**
  - a query that reads the identity is cached per user;
  - one that doesn't is shared;
  - a refreshed token (same claims) hits.
- **Sync:**
  - `Authenticate User` bumps the identity version and re-runs the queries;
  - a bad token gives `AuthError` and close;
  - an expired identity gives `TokenExpired`;
  - two users never see each other's results through shared executions.
- **Client:** setAuth pauses until the first token, then confirmation, scheduled refetch, retry after an
  `AuthError`, giving up after 2, and the races.
- **Oracle:** the official `ConvexClient.setAuth` and `ConvexReactClient` with
  `ConvexProviderWithAuth` against bunvex.

## 6. Open questions

- Should the server also accept the config from an environment variable (e.g. JSON in
  `BUNVEX_AUTH_CONFIG`) for deployments that do not embed it in code? This is not Convex's way, so it
  would be its own divergence.

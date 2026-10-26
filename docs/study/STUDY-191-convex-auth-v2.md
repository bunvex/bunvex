# STUDY-191 — Built-in auth following Convex Auth v2
<!-- index: Built-in auth following Convex Auth v2 (`@convex-dev/auth` 2.0 beta, branch `reboot`): its components, tokens, sessions and sign-in methods, and how `@bunvex/auth` matches them; the direction that replaces better-auth as AD-01's base | accepted: direction and A-1–A-8 as recommended (owner, 2026-10-26; DV-575–DV-577); work not started -->

- **Status:** accepted (owner, 2026-10-26): A-1–A-8 as recommended (§4; DV-575–DV-577). Nothing is built yet; the
  next step is the `signJwt` study (§3.4 step 2).
  - **Direction decided** (owner, 2026-10-26). bunvex's built-in auth follows Convex Auth v2 instead of hosting
    better-auth (STUDY-28, AD-01). The core comes first, for parity. What bunvex adds on top (engine services, more
    sign-in methods, the dashboard) is decided later, each as its own addition.
- **Convex source read:**
  - **convex/convex-auth**, branch `reboot` at `84ccfa8d` (2026-10-26) and tag `v2.0.0-beta.0` (`8c28cad9`,
    2026-10-15). The org was renamed from get-convex to convex. `main` is still v1, at `dd314f51` (0.0.96).
  - **The clone** is `~/www/convex-auth`. Paths below are relative to `packages/core/src/` of `reboot` unless they
    say otherwise.
  - **convex/convex-backend `origin/main`** for `ctx.auth.signJwt`: `crates/keybroker/src/deployment_jwt.rs` and
    the commits listed in [STUDY-186](STUDY-186-convex-after-72ce13c.md) §4.2.
  - **The docs:** https://auth-v2.previews.convex.dev. The source of the docs is `packages/docs`.
- **Related:**
  - [STUDY-27](STUDY-27-auth.md): `ctx.auth`, token verification, the client's auth.
  - [STUDY-28](STUDY-28-builtin-auth.md): better-auth in the engine. This study replaces its direction; its survey
    of the other backends (§1.4) and of minivex (§1.5) still holds.
  - [STUDY-152](STUDY-152-components-restudy.md), [STUDY-158](STUDY-158-own-components.md) and
    [STUDY-183](STUDY-183-sharded-counter.md): components, and how bunvex writes its own.
  - [STUDY-186](STUDY-186-convex-after-72ce13c.md) §4.2: `signJwt`.
  - DV-179, DV-493, AD-01, AD-02.

## 0. Why this study

STUDY-28 (2026-10-01) chose to host better-auth inside the engine (AD-01). Since then, Convex has rewritten Convex
Auth from scratch as v2. They did not build on their own better-auth component (`@convex-dev/better-auth`); v2 is a
native set of components:

- its flows are mutations only;
- its tokens are signed by the deployment;
- revocation becomes reactive (in branches under review).

Shawn Erquhart, who wrote the better-auth component, is among v2's contributors.

The owner weighed four shapes of built-in auth on 2026-10-26:

| | Shape | In short |
|---|---|---|
| E1 | Installable components, as v2 | Parity, but nothing beyond what Convex gives |
| E2 | A native engine service, configured in the dashboard (Supabase-like) | Zero code, but diverges from Convex; users live in a system table |
| E3 | v2's components shipped with bunvex, plus engine services | Parity and system integration |
| BA | better-auth in the engine (AD-01) | Most features on day one, in better-auth's shape, with no parity |

**The decision.** Follow Convex: build the v2 core first, which is E1 and also the first step of E3. Decide the
engine services and the extra features later, on a working core. BA and E2 are set aside because they leave the
Convex Auth parity gap open (`parity/README.md`, "Auth helpers").

This study is that first step. It covers what v2 is, what an app observes, and what bunvex must build to match it.

## 1. How Convex does it

### 1.1 Where it lives, and how mature it is

- **Repository and branch.** v2 is developed on the `reboot` branch of convex/convex-auth and published as
  `@convex-dev/auth@2.0.0-beta.*` with the npm tag `beta`. The release scripts are in `packages/core/package.json`
  (`alpha`, `beta`, with `--publish-branch reboot`).
- **Tags:**
  - `v2.0.0-alpha.1`, 2026-08-24;
  - `alpha.2`, 2026-09-16;
  - `beta.0`, 2026-10-15.
- **Activity:** 827 commits, with 57, 84, 63 and 60 commits a month from July to October 2026.
- **Stability promises.** The docs mark v2 as beta and say not to use it in production:
  - the stable release is targeted for Q4 2026;
  - there is no upgrade path from a beta to the stable release;
  - only the newest beta gets fixes (`packages/docs/content/docs/index.mdx`).
- **v1** (0.0.96, `main`) is in maintenance. Its README points to `reboot`.

### 1.2 The package

One npm package, `@convex-dev/auth`, holds several components, the code an app runs, the clients and a CLI
(`package.json` `exports`):

- **Components:**
  - `./convex.config.js`, the core `auth`;
  - `./components/<name>/convex.config.js` for `username`, `password`, `email`, `passkey`, `anonymous`, `oauth`,
    `google`, `apple` and `github`;
  - each with its `_generated/component.js` types and a `./test` helper.
- **App-side code:**
  - `./server`: `setupConvexAuth`, `getAuthUserId`;
  - `./methods/<method>/server`: `setupEmailPassword`, `setupGoogle`, …
- **Clients:**
  - `./react`: `ConvexAuthProvider`, `useAuthActions`, `useAuthToken`, `useAuth`;
  - `./methods/<method>/react`: hooks per method;
  - `./browser`;
  - `./ssr` and `./ssr/nextjs`.
- **CLI:** a `bin` that runs `init`.
- **Dependencies:**
  - `@convex-dev/rate-limiter`, `@convex-dev/batch-worker`;
  - `@simplewebauthn/server` and `/browser`;
  - `argon2id-wasm` (their own package, compiled from Rust);
  - `jose`, `cookie`.
- **Optional peers:** `@convex-dev/resend`, `next`, `react`. Required peer: `convex ^1.48.0`.
- **Not exported:** the TOTP component (`authTotp`) exists, but no entry point exports it (made internal in
  `7ef5f0dc`).

### 1.3 The components

Each component stores secrets keyed by an opaque `userId: v.string()`. None of them calls another; the app's code
composes them inside one transaction.

| Component | Tables (`schema.ts`) | Env | Children | Role |
|---|---|---|---|---|
| `auth` (`component/`) | `accounts {provider, providerAccountId, userId}` (indexes `by_provider_account`, `by_user`); `sessions {userId, accountId}`; `refreshTokens {hash, sessionId, state, expiresAt, retiredAt?}` | — | — | Accounts, sessions, refresh tokens; mints access tokens. Knows no provider (`component/convex.config.ts`) |
| `authUsername` | `usernames {userId, username, usernameNormalized}` | — | — | Username → user |
| `authPassword` | `passwords {userId, passwordHashPHC}` | — | rate-limiter | Hash and verify; 5 attempts, then 1 a minute per user (`components/password/public.ts`) |
| `authEmail` | `verifiedEmails {email, normalizedEmail, userId, isPrimary}`; `challenges {email, purpose, emailCodeHash, browserSecretHash, expiresAt}` | — | rate-limiter, batch-worker | Verified addresses, sign-up / change / recovery codes |
| `authPasskey` | `passkeys {userId, name?, credentialId, publicKey, counter, transports?}`; `handles`; `challenges` | — | batch-worker | WebAuthn credentials |
| `authTotp` | `totpSecrets {…, status, lastUsedCounter?}`; `backupCodes {userId, codeHash}` | — | — | TOTP secrets, backup codes (internal, unused) |
| `authAnonymous` | `accounts {anonymousId}` | — | — | Anonymous users |
| `authOauth`, `authGoogle`, `authGithub`, `authApple` | `authorizationRequests {stateHash, redirectTo, callbackUrl, codeVerifier, expiresAt, …}`; `tickets {stateHash, ticketCodeHash, expiresAt, encryptedPayload}` (`lib/oauth/schema.ts`) | `CLIENT_ID`, `CLIENT_SECRET` (Apple: `CLIENT_ID`, `TEAM_ID`, `KEY_ID`, `PRIVATE_KEY`) | — | One OAuth provider each, with an HTTP callback |

### 1.4 How an app wires it

From `examples/react-google/convex/` and `examples/react-email-password/convex/`.

**`convex.config.ts`** mounts the components and binds their env from the app's declared env. An OAuth component
also gets an `httpPrefix` for its callback:

```ts
const app = defineApp({ env: { AUTH_GOOGLE_CLIENT_ID: v.string(), AUTH_GOOGLE_CLIENT_SECRET: v.string() } });
app.use(auth);
app.use(google, { httpPrefix: "/oauth/google",
  env: { CLIENT_ID: app.env.AUTH_GOOGLE_CLIENT_ID, CLIENT_SECRET: app.env.AUTH_GOOGLE_CLIENT_SECRET } });
```

**`auth.config.ts`** registers the deployment's own tokens as a `customJwt` provider:
- `issuer: ${CONVEX_CLOUD_URL}/components/auth`;
- `jwks: ${CONVEX_CLOUD_URL}/.well-known/jwks.json`;
- `algorithm: "ES256"`;
- `applicationID: "convex"`.

The branch `dowski/convex-auth-config-func` (`6fddae29`) wraps this as `convexAuthProvider()`.

**`auth.ts`:**
- `setupConvexAuth({component, usersTable?, accessTokenTtlSeconds?, refreshTokenTtlSeconds?})`
  (`server/setup.ts:171`) returns the public `signOut`, `refreshSession` and `isAuthenticated`, plus a core object.
- The core object is passed to each method's setup. For example, `setupEmailPassword(auth, {component,
  passwordComponent, emailSender, urls})` returns that method's public mutations: `signUpWithEmailPassword`,
  `completeSignUp`, `signInWithEmailPassword`, `changePassword`, `startChangeEmail`, `startPasswordRecovery`, …
- The method's `.attachUserCallbacks({createUser, onSignIn?})` takes the app's internal mutations. The core holds
  them as function handles (`createFunctionHandle`, `server/setup.ts:273`, `:287`) and calls them in a
  sub-transaction, so a throwing `onSignIn` rolls the sign-in back.

**The users table:**
- The app owns it. The examples declare `users: defineTable({})`.
- `createUser` receives `provider: {name, accountId, profile}` (for example Google's profile) and inserts whatever
  the app wants.
- `usersTable` (default `"users"`) is a type-level contract only: the core never reads or writes the table
  (`server/setup.ts:174–189`).
- Email addresses stay in `authEmail`. An app reads one with
  `ctx.runQuery(components.authEmail.verifiedEmails.getPrimaryEmail, {userId})`
  (`examples/react-email-password/convex/currentUser.ts`).

### 1.5 Tokens and sessions

**Access tokens.**
- The core mints them with the new syscall `ctx.auth.signJwt({claims: {sub, aud: "convex"}, expiresInSeconds})`
  (`component/public.ts`).
- The key is ES256, derived from the deployment's secret. It is mutations only, and the lifetime is 1 s to 1 h.
- `iss`, `iat` and `exp` are set by the deployment, with `iss = {origin}/components/{path}`.
- Claims prefixed `convex` or `cvx` are reserved.
- The public keys are at `/.well-known/jwks.json` (convex-backend `crates/keybroker/src/deployment_jwt.rs`).
- The component holds no signing material. Before `e9df54c8` it signed RS256 itself from component env
  (`AUTH_PRIVATE_KEY`, `AUTH_JWKS`) and served its own JWKS.

**Lifetimes** (`component/public.ts:26–49`):
- `AUDIENCE = "convex"`;
- access token 60 s by default, at most 1 h;
- refresh token 30 days;
- `STANDARD_ISSUED_REFRESH_TOKEN_LIMIT = 3`;
- `REFRESH_GRACE_MS = 5 s`;
- `SPENT_TOKEN_HORIZON_MS = 1 h`.

**Refresh rotation** (`refresh`, `component/public.ts:599`). A refresh token is stored as a SHA-256 hash, in one of
the states `issued`, `redeemed`, `spent` or `dropped`.
- The first use of an `issued` token redeems it. The previously redeemed token becomes `spent`, and its unredeemed
  siblings become `dropped`.
- A `redeemed` token presented again is accepted, as a retry after a lost response.
- A `spent` or `dropped` token presented again revokes the whole session.
- More than 3 unredeemed tokens outside the 5 s grace window also revoke it.
- Retired rows are kept for 1 h, then pruned inline. That is the bounded reuse horizon in `KNOWN_ISSUES.md`.

**Core functions** (`component/public.ts`):
- `signUp` (:410), `signIn` (:448) and `signUpWithoutSession` (:489), all mutations;
- `getUserIdByAccount` (:518), a query;
- `refresh` (:599) and `signOut` (:708), mutations.

### 1.6 Identity in functions, and revocation

**On `reboot` today:**
- `getAuthUserId(ctx)` returns `identity.subject`, the user id, and reads no row (`server/userId.ts:32`, with a
  `TODO … should validate the session`).
- `isAuthenticated` is `getUserIdentity() !== null`.
- So a revoked session stays valid until its access token expires, 60 s by default.

**The stack under review** (Christian Wyglendowski's branches, 2026-10-21 to 10-23) changes that:
- `dowski/sid-in-jwt` (`1c5ba2cf`): `sub` becomes the session id. The core gains a `getSession` query, and
  `getAuthUserId` runs it through `componentsGeneric().auth`. A deleted session stops resolving at once, and
  reactively.
- `auth-state-server`: `isAuthenticated` requires a live session.
- `auth-state-client`: a `SessionWatcher` signs the client out when `isAuthenticated` turns false.
- Also in the stack:
  - `revokeSessions`, `revokeOtherSessions` and `listSessions`;
  - a cap of 100 sessions per user;
  - revoking sessions on password reset and recovery;
  - an expired-session sweep on batch-worker.

### 1.7 Transport

**No actions.**
- Every sign-in, sign-up, refresh and sign-out is a mutation; `authAction` was removed in `607f6111`.
- The queries are `isAuthenticated`, `checkPasswordRecovery` and a passkey `list`.

**HTTP: only the OAuth callback.** It is an HTTP action inside each OAuth component, mounted under the app's
`httpPrefix` (`lib/oauth/http.ts`). The flow:
1. A mutation `startSignIn…` stores the authorization request (with the PKCE values) and returns the provider URL.
2. The provider redirects to the callback.
3. The callback claims the request and `fetch`es the token endpoint (`lib/oauth/callback.ts:105`).
4. It stores an encrypted one-time ticket (AES-GCM, keyed from the ticket code) and redirects to the app.
5. A mutation `completeSignIn…` redeems the ticket with the state the browser kept.

The callback URL is built from `CONVEX_SITE_URL` with the component's `httpPrefix` applied
(`lib/oauth/dbHelpers.ts:67`). That needs a backend that gives components system env vars (`KNOWN_ISSUES.md`).

**Browser.**
- The refresh token lives in `localStorage`, namespaced (`browser/storage.ts:61`).
- A Web Locks mutex and storage events keep tabs in step (`browser/sessionManager.ts`).

**SSR and Next.js.**
- `ssr/handlers.ts` exports `refreshHandler` and `signOutHandler`, both WHATWG handlers. The refresh token sits in
  an httpOnly, SameSite=Lax cookie (`ssr/cookies.ts:100`), and the page gets only the access token. An Origin check
  guards against CSRF (`ssr/origin.ts`).
- `ssr/signInProxy.ts` is an allowlisted proxy in `ConvexHttpClient`'s wire format, so one hook works in both modes.
- The branch `ssr-single-handler` merges these into one route.

### 1.8 Crypto, randomness and I/O

- **Passwords.**
  - argon2id with 16 MiB, t=3, p=1 (`packages/argon2id-wasm/rust/src/lib.rs:6–8`).
  - It is compiled to WASM and runs **inside the mutation** (`components/password/public.ts`).
  - The salt comes from `crypto.getRandomValues`.
- **Randomness in mutations.** `getRandomValues` makes refresh tokens (`component/crypto.ts`), OAuth state and PKCE
  values, passkey challenges and email codes. Convex's mutations get a seeded CSPRNG.
- **Rate limits.**
  - `@convex-dev/rate-limiter`, as a child component, limits password attempts per user and email lookups.
  - The public routes as a whole have none yet (`KNOWN_ISSUES.md`).
- **Email.**
  - Through `@convex-dev/resend`: `authEmail` calls the sibling `resend` component's `sendEmail` by handle.
  - Codes are links carrying 256 bits; a short typed code is a TODO (`components/email/helpers.ts:142`).
- **Passkeys.** `@simplewebauthn/server` verifies them inside mutations.
- **OAuth.** Written by hand, without `oauth4webapi` or `@auth/core` (v1 used `@auth/core`). `jose` is used only
  for Apple's client secret (`components/apple/secret.ts`) and for decoding JWTs in SSR.

### 1.9 Feature coverage and known gaps

**Has:**
- username + password;
- email + password: verification, change of password and address, recovery;
- passkeys, with management and autofill;
- anonymous;
- generic OAuth, Google, Apple and GitHub.

**Lacks:**
- magic link and email OTP sign-in;
- SMS;
- a 2FA flow (`authTotp` is unused);
- v1's catalogue of 80+ `@auth/core` providers;
- organizations;
- admin and user management;
- SSO and SAML;
- React Native (`KNOWN_ISSUES.md`, "custom url schemes");
- the v1 migration guide (WIP).

**`KNOWN_ISSUES.md`:**
- no rate limits on public routes;
- OAuth documents never cleaned up, and an unauthenticated `startSignIn`;
- OAuth needs system env vars in components;
- one pending OAuth flow per storage;
- no custom URL schemes;
- the refresh-reuse horizon is bounded.

### 1.10 What is moving (the last two weeks)

- **Deployment-signed tokens:** landed on 2026-10-26 (`e9df54c8`), with `convexAuthProvider()` on a branch.
- **The session stack** of §1.6.
- **An API reorganisation:**
  - `setupConvexAuth`;
  - components prefixed `auth`;
  - explicit exports.
- **Next.js and SSR:**
  - a single handler;
  - request time before reading the clock;
  - the account-switch handshake.
- **An exploration of component init args** with function references (`codex/explore-component-args`, "DO NOT
  REVIEW"). It would move callbacks and settings into `convex.config.ts`.
- **Storing the OAuth provider's tokens**, and migrating `alpha.2` sessions.

## 2. What an app can observe

Matching v2 means an app written for `@convex-dev/auth` v2 runs on bunvex once its imports change (DV-493), and a
Convex export of its data imports unchanged. The contract:

1. **Component names and shapes.**
   - The names: `auth`, `authUsername`, `authPassword`, `authEmail`, `authPasskey`, `authAnonymous`, `authOauth`,
     `authGoogle`, `authGithub`, `authApple`.
   - Their public function paths, arguments and return validators, as the app calls them through
     `components.<name>.*`.
   - Their env declarations.
   - Their children: rate-limiter and batch-worker, at the same mount names.
2. **Schemas.** Every table, field and index of §1.3, so a snapshot export and import carry them once components
   are exported (STUDY-152 step 10; today DV-215 refuses `_components/…`).
3. **The app-side API.**
   - `setupConvexAuth` options and defaults, and what it returns.
   - Each method's setup, its returned mutation names and arguments.
   - `attachUserCallbacks`: the `createUser` argument (`provider: {name, accountId, profile}`) and `onSignIn`
     rollback.
   - `getAuthUserId` and its type parameter.
4. **Tokens.**
   - Claims: `iss` = `{cloud url}/components/auth`, `aud`, `sub`, `iat`, `exp`.
   - The ES256 algorithm, the JWKS route, the default and maximum lifetimes.
   - What `ctx.auth.getUserIdentity()` returns for one: `subject`, `issuer`, `tokenIdentifier`.
5. **Refresh semantics.** Redeem, retry, reuse-revokes, the grace window and the horizon (§1.5), and the errors a
   client sees.
6. **Clients.**
   - The React provider and hooks.
   - What is kept in storage: keys and shapes, so a page reload keeps a session.
   - The SSR cookies (names, flags) and handlers.
   - The sign-in proxy's wire format.
7. **HTTP.** The OAuth callback under the app's `httpPrefix`, its redirects and error pages.
8. **Errors.** Messages and `ConvexError` data for wrong passwords, rate limits, expired codes and so on, in bunvex's
   words where they name Convex (rule 5).

Not observable, so free for bunvex to choose:
- how the password hash is computed, as long as the stored PHC string verifies the same;
- how the components are packaged inside bunvex.

## 3. How bunvex does it

### 3.1 The package

**`@bunvex/auth`**, in `components/auth/`, follows STUDY-183's package model:
- TypeScript in the repo, compiled JS at publish;
- `_generated/` committed;
- the example app;
- upstream's tests ported to `@bunvex/testing`;
- a differential test against Convex's package on Convex's binary (`packages/differential`).

Its `exports` mirror v2's entry points, with `bunvex.config.js` for `convex.config.js` (DV-494).

**The name is taken.** Today `@bunvex/auth` (`packages/auth/`) is the token verifier: `TokenVerifier`, `identity`,
the OIDC config. Only `packages/server` imports it (7 files). It moves out of the way (A-2).

### 3.2 Names under rule 5

v2's shipped names carry "convex". They become bunvex's, as every client name did (DV-243 and the like):

| v2 | bunvex (proposed) |
|---|---|
| `setupConvexAuth` | `setupAuth` |
| `ConvexAuthProvider` | `BunvexAuthProvider` |
| `convexAuthProvider()` (branch) | `bunvexAuthProvider()` |
| `ConvexAuthApi`, `ConvexAuthActionsContextType`, `ConvexAuthServerConfig`, `setupConvexAuthServer` | `AuthApi`, `AuthActionsContextType`, `AuthServerConfig`, `setupAuthServer` |
| `CONVEX_SITE_URL`, `CONVEX_CLOUD_URL` | `BUNVEX_SITE_URL`, `BUNVEX_CLOUD_URL` (DV-179) |
| `aud: "convex"` | A-3 |
| storage keys, cookie names with `convex` | A-4 |

Names without "convex" stay as they are: component names, function paths, `getAuthUserId`, `useAuthActions`, the
method hooks.

### 3.3 Prerequisites

| Needed by v2 | bunvex today |
|---|---|
| Components, nested children, `componentsGeneric` | done (STUDY-152–157) |
| Component env (`defineComponent({env})`, `app.use(c, {env})`), `defineApp({env})`, system env in components | done (STUDY-153, STUDY-154, STUDY-171 §15.7) |
| Function handles across app and components, sub-transaction rollback | done (STUDY-50, STUDY-155) |
| HTTP actions mounted under `httpPrefix`, `fetch` in them | done (STUDY-31, STUDY-157) |
| Seeded `crypto.getRandomValues` in mutations | done (STUDY-66, `packages/core/src/determinism.ts`) |
| **`ctx.auth.signJwt` and `/.well-known/jwks.json`** | **not built.** Its own study (STUDY-186 §4.2: the key derivation that serves the same JWKS from a store the Convex binary wrote; Q1, the reserved claim prefixes) |
| **`@bunvex/rate-limiter`** | **not built** (STUDY-158 §3.4 step 4.3) |
| **`@bunvex/batch-worker`** | **not built** (step 4.2) |
| `@bunvex/resend` (optional peer, for email) | not planned yet |
| `@bunvex/testing` `registerComponent` | done (STUDY-159) |
| `.wasm` imports in a component's bundle | to check, only if A-5 keeps v2's hasher |

### 3.4 The order of work

1. **This study**, with A-1–A-8 decided.
2. **The prerequisites:**
   - the `signJwt` study, then its PR;
   - `@bunvex/batch-worker` and `@bunvex/rate-limiter`, in STUDY-158's order;
   - `@bunvex/resend`, its own small study.
3. **The core:**
   - `auth`;
   - `authAnonymous`, `authUsername` and `authPassword`, with the username-password method;
   - the React client and the browser session manager;
   - `getAuthUserId`;
   - the example app.
4. **The email method:** `authEmail` and email-password.
5. **OAuth:** `authOauth`, Google, GitHub and Apple, with their HTTP callbacks.
6. **Passkeys:** `authPasskey` and username-passkey.
7. **SSR and Next.js:** handlers, cookies, the sign-in proxy, on `@bunvex/nextjs`.
8. **Later, each its own study and addition:** what bunvex adds (§3.7).

Steps 3–7 port upstream's tests per step and add the differential test for that step's components.

### 3.5 Following a moving beta

- **Pin the commit.** v2 changes its API every month and promises no upgrade path between betas. bunvex pins one
  `reboot` commit in [upstream.md](../parity/upstream.md#other-repositories), as it does for the other component
  repositories, and moves the pin by the daily and weekly triage.
- **No compatibility with older betas.** A store written by an older beta is not migrated, as Convex does not.
- **When the core starts (A-6).** Either now on the pinned commit, or once Convex ships stable v2. The
  prerequisites of §3.3 are parity work either way and can start now.

### 3.6 What happens to AD-01, AD-02, STUDY-28 and the spike

- **AD-01** becomes "under review". Its base changes from better-auth to this study. Its B-decisions that do not
  depend on better-auth come back as their own additions in §3.7, when the owner takes them up:
  - B3, revocation in the protocol;
  - B4, users in the app schema, which v2 already does;
  - B8, rate limits from the server's IP;
  - B9, the dashboard.
- **AD-02**, the dashboard's auth screens, built on the mock, stays as it is. Its server side will call the
  components' functions with the admin key instead of `_system/auth:*`. Which screens stay is decided with the
  additions.
- **STUDY-28** stays as the record of the better-auth design and the spike's numbers. Its status line points here.
- **The branch `spike/better-auth`** stays unmerged, for reference.

### 3.7 Later additions (not decided here)

These were weighed on 2026-10-26 as shape E3. Each needs its own study and owner decision:

- **Engine services:**
  - verifying the built-in issuer locally, registered without `auth.config.ts`;
  - revocation in the sync protocol, so subscriptions stop at once even in functions that only call
    `getUserIdentity()`;
  - native password hashing off the JS thread;
  - rate limits keyed by the IP the server saw;
  - an email outbox with Resend or SMTP;
  - an audit log.
- **The packaging.** The auth components shipped with bunvex and versioned with it, an exception to DV-493's own
  versions.
- **More methods and features**, each a separate component so the core stays identical to Convex's:
  - admin (ban, impersonation, user management);
  - organizations;
  - a 2FA flow;
  - magic link and email OTP;
  - SMS;
  - SSO.
- **Component extensions in the dashboard** (UI-01 §26). A first-party component brings its own dashboard
  extension, shown when the component is mounted. Auth would be the first; workflows and flags would follow.

## 4. Divergences

Decided by the owner on 2026-10-26, all as recommended.

| # | Divergence | Recommendation | Why | Decision |
|---|---|---|---|---|
| A-1 | Follow v2, not v1: bunvex does not build `@convex-dev/auth` 0.0.x (v1's tables in the app schema, `@auth/core` providers, OTP, magic links) | **Yes.** v1 apps move to v2 (Convex's own path) | v1 is in maintenance and v2 replaces it; building both doubles the security surface | **accepted** (owner, 2026-10-26; DV-575) |
| A-2 | The current token verifier `@bunvex/auth` (`packages/auth`) is renamed, so the name goes to the auth components (DV-493's `@bunvex/<Convex's name>`) | **Rename to `@bunvex/identity`**, kept as its own internal package | It is internal (only `packages/server` imports it); the user-facing name belongs to the auth app developers install | **accepted** (owner, 2026-10-26); internal, no DV |
| A-3 | The access token's `aud`, and the `applicationID` an app writes in its auth config: v2 uses `"convex"` | **`"bunvex"`** | Rule 5. Only bunvex's own deployment verifies these tokens, and they live 60 s, so no stored state carries the value. A store opened from Convex has no live tokens to keep | **accepted** (owner, 2026-10-26; DV-576) |
| A-4 | Client storage keys and SSR cookie names that contain `convex` | **bunvex's names** (exact names in the core's PR) | Rule 5. A session cannot move between a Convex and a bunvex deployment anyway (different signing keys) | **accepted** (owner, 2026-10-26; DV-577) |
| A-5 | Password hashing: v2 runs its argon2id WASM inside the mutation, blocking the thread; bunvex could produce the same PHC string (argon2id, 16 MiB, t=3, p=1) natively | **Decide with a measurement in the core's PR.** Keep v2's parameters and PHC format in any case, so a hash from a Convex export verifies | Not observable apart from timing. Whether component code can reach a native hasher from its `vm` context is the open part (§6) | **accepted** (owner, 2026-10-26): measured in the core's PR; a native hasher, if chosen, comes back as its own decision |
| A-6 | When to build the core: on a pinned `reboot` commit now, or after Convex's stable v2 | **Prerequisites now, the core on the pinned commit right after them**, moving the pin by triage | Waiting delays parity, and the stable release is near (Q4 2026). The pin and triage bound the churn | **accepted** (owner, 2026-10-26); not started yet |
| A-7 | `@bunvex/resend`, needed by email: write it (Convex's API, DV-493) or let `authEmail` take any email-sending function | **Write `@bunvex/resend`** with Convex's API, its own small study | Parity; the email method's setup names Resend explicitly (`emailSender: {kind: "resend", …}`) | **accepted** (owner, 2026-10-26); parity, no DV |
| A-8 | Convex's reserved claim prefixes in `signJwt` (`convex`, `cvx`) | **As STUDY-186 Q1 decided:** reserve them, word the message in bunvex's words; settled in the `signJwt` study | Parity for apps that move | **accepted** (owner, 2026-10-25, STUDY-186 Q1) |

## 4b. Additions

None in this study. AD-01's base changes (§3.6). The additions of §3.7 come later, each in its own study.

## 5. Tests

- **Upstream's tests, ported.** Each component's and method's `*.test.ts` runs on `bun test` with
  `@bunvex/testing` (STUDY-159), as STUDY-183 did for sharded-counter. The tests cover:
  - refresh rotation, reuse and the grace window;
  - email codes;
  - passkey ceremonies, with `packages/passkey-test-authenticator`;
  - OAuth with a fake provider;
  - rate limits.
- **Differential tests** (`packages/differential`). The same app on `@convex-dev/auth` on Convex's binary and on
  `@bunvex/auth` on bunvex. They compare:
  - each table's documents after a sign-up, sign-in, refresh and sign-out;
  - the token's claims, except signature, `iss` host and the times;
  - the error messages.
  - This needs a precompiled Convex binary with `signJwt` (convex-backend after `ebbb92c`).
- **Export and import**, once components are exported (STUDY-152 step 10, DV-215). A Convex snapshot export of
  an app on v2 imports into bunvex, and its users sign in with their passwords (the PHC hashes verify).
- **Clients.** The React provider against both backends, like `sync-e2e/react/auth.test.tsx` for STUDY-27.
- **Security regressions** from minivex's audits (STUDY-28 §1.5) that apply:
  - a password change revokes the other sessions (on `reboot`'s branches);
  - rate limits hold under concurrency;
  - a reused refresh token revokes the session.

## 6. Open questions

- **A native hasher from component code** (A-5). Component code runs in the app's `vm` context (DV-492), where
  `Bun.password` may not be reachable. A privileged hashing call would be an engine service (§3.7). Measure first:
  argon2id with 16 MiB, t=3, as WASM in Bun.
- **Pinning before the session stack merges.** `sid-in-jwt` changes `sub` and adds a component query to every
  `getAuthUserId`. Pin before or after it lands upstream? The core's PR follows whatever the pin holds.
- **Component init args** (`codex/explore-component-args`). If Convex adopts them, callbacks move into
  `bunvex.config.ts`, which needs `v.function()` (STUDY-186: "nothing until Convex's client exposes it").
- **The dashboard before the extensions.** The data browser's component picker and `data --component` are still
  to build (STUDY-152 step 9, DV-224). Until then auth data is reachable only through the components' functions.
  That step may need to come before a Users screen is decided.
- **React Native.** It is not in v2 (custom URL schemes). bunvex follows when Convex does.

# STUDY-28 — Built-in authentication (users, sessions, a Users dashboard) on better-auth

- **Status:** accepted: B1–B10 as recommended (owner, 2026-10-01); the spike (§3.8 step 0) is next
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend (dashboard, docs); get-convex/convex-auth
  `7eab860` (v0.0.96); get-convex/better-auth `2f9fcf6` (v0.12.5); better-auth 1.7.6 (installed dist)
- **Related:** STUDY-27 (`ctx.auth`, JWT / OIDC, sync and client auth), STUDY-12 (dashboard), the owner's
  earlier attempt in `minivex` (`packages/minivex/src/auth/*`, `docs/specs/D7-auth.md`, `AUTH-01`, the auth
  audits)

The question: Supabase, Firebase, Appwrite and PocketBase ship authentication built in, with user
management in their consoles; Convex does not. Can bunvex ship it, built on better-auth (its adapter API
and plugins, the admin plugin for user management), **not** as a separate HTTP auth server but embedded,
so that everything goes through bunvex's own primitives (queries, mutations, actions, internal functions)
and is reactive, cached and transactional like the rest?

Short answer: yes, and bunvex is better placed than Convex to do it, because it runs in one process. A
better-auth endpoint can run **inside one bunvex mutation**, against a database adapter over the
transaction, which the Convex component cannot do. The work is in the edges: randomness and I/O inside
transactions, the HTTP and cookie assumptions, and keeping better-auth's version churn out of apps.

## 1. How Convex does it (and the others)

### 1.1 Convex: no built-in auth

- **The platform** only *verifies* tokens: `auth.config.ts` providers (OIDC, custom JWT), STUDY-27.
- **The dashboard** has no user management:
  - The deployment's Authentication settings page lists the configured providers
    (`dashboard-common/src/features/settings/components/AuthenticationView.tsx`, `AuthConfig.tsx`).
  - The function runner can act as an identity (`functionRunner/components/FunctionTester.tsx`).
  - Users exist only as rows in the data browser.
- **Two libraries fill the gap, both outside the backend:** Convex Auth (§1.2) and the better-auth
  component (§1.3).

### 1.2 Convex Auth (`@convex-dev/auth`, beta)

All of it is ordinary Convex functions in the app (`src/server/implementation/index.ts`):

- **Functions.** `convexAuth({providers})` returns `{auth, signIn, signOut, store, isAuthenticated}`.
  - `signIn` and `signOut` are public **actions**: they do the I/O (OAuth token exchange through
    `oauth4webapi`, email and SMS, password hashing with Lucia's Scrypt).
  - Every database step is one call to the internal mutation `store`, a discriminated union of steps
    (`signIn`, `refreshSession`, `verifyCodeAndSignIn`, `createAccountFromCredentials`, `modifyAccount`,
    `invalidateSessions`, …).
  - That split, I/O in actions and writes in mutations, is the model bunvex's functions impose too.
- **Tables** are spread into the app's own schema (`authTables`): `users`, `authSessions`,
  `authAccounts`, `authRefreshTokens`, `authVerificationCodes`, `authVerifiers` and `authRateLimits`.
  - So app code can query `users` and join on it.
- **Tokens.**
  - An RS256 JWT is signed with `jose` inside the mutation, from `JWT_PRIVATE_KEY` in an environment
    variable. `sub` is `userId|sessionId`, the issuer `CONVEX_SITE_URL`, the audience `convex`, and it
    lives 1 h.
  - The refresh tokens form a rotation tree with a 10 s reuse window; reuse outside it revokes the subtree.
  - JWKS is served from an environment variable by `auth.addHttpRoutes(http)`, with OAuth
    `signin/callback` routes.
  - `auth.config.ts` points at `CONVEX_SITE_URL`, so verification goes through the standard OIDC path.
- **Identity.** `getAuthUserId(ctx)` splits `identity.subject`; it reads no row. So a revoked session
  stays valid until its JWT expires (convex-auth #20).
- **Client.**
  - React only. Tokens live in localStorage (deliberately: the backend is a third-party domain and the
    WebSocket cannot carry httpOnly cookies, `docs/pages/security.mdx`).
  - Next.js keeps them in httpOnly cookies through middleware.
- **Limits.**
  - No MFA, SSO, organizations or admin API.
  - A refresh-token buildup hit "Too many reads" (#334).

### 1.3 The better-auth component (`@convex-dev/better-auth`)

- **Where better-auth runs.** In an HTTP action on `*.convex.site`: `registerRoutes(http, createAuth)`
  builds a **new `betterAuth()` per request** (`src/client/create-client.ts`).
- **Tables.** They live inside the component (`user`, `session`, `account`, `verification`, `twoFactor`,
  `jwks`, `rateLimit`, …), so app code reaches them only through component functions.
- **The adapter** (`src/client/adapter.ts`) is the core problem.
  - Each better-auth database call becomes its own `ctx.runQuery` / `ctx.runMutation`: a separate
    transaction and a round trip. The adapter declares `transaction: false`.
  - So better-auth's multi-step flows (sign-up, OAuth user + account, accepting an invitation, the rate
    limiter) are **not atomic**.
  - Their "triggers" commit per write, and the docs warn about it.
  - It refuses `offset`, `mode: "insensitive"` and joins.
- **Identity.** A `convex()` plugin wraps better-auth's `jwt`, `oidcProvider` and `bearer` plugins.
  - It issues an RS256 JWT (audience `convex`, 15 min) that Convex verifies as a `customJwt` provider.
  - `getAuthUser(ctx)` then reads the session and the user: two more component calls per request.
- **Reported problems** (GitHub issues):
  - **Latency:** 100–360 ms for get-session on an empty database (#284, #73).
  - **JWKS:** refetched on every token validation (#437).
  - **Non-atomic rate limiting:** it fails under contention (#432, #312).
  - **Adapter semantics:** `eq null`, ids across tables, and indexes (#399, #410, #296).
  - **JWTs minted for deleted sessions** (#434).
  - **SSR and proxy domain problems** (#422, #424).
  - **Pinning:** a hard pin to `better-auth <1.7`, which then broke on 1.7 (#433).
  - **Workarounds:** an isolate memory limit at push time (`registerRoutesLazy`); and a `crossDomain`
    plugin that fakes cookies in localStorage and skips the OAuth state cookie check.
- **Plugins.**
  - Supported without a schema change: anonymous, email OTP, generic OAuth, JWT, magic link, one tap,
    phone number, two factor and username.
  - Need a "local install": organization, admin, passkey and others.
  - Unsupported: SSO.

The lesson: almost every problem comes from **bridging** an adapter-based library to a remote,
per-call-transaction backend, not from better-auth itself.

### 1.4 What the other backends ship (the bar to meet)

| | Supabase | Firebase | Appwrite | PocketBase |
|---|---|---|---|---|
| Where auth runs | Separate Go service, same Postgres (`auth` schema) | Separate Google service and store | Module in the API, same DB | In-process, same SQLite |
| Tokens | 1 h JWT + single-use rotating refresh | 1 h JWT + long refresh | Stateful session; 15 min JWT | 7-day JWT, revoke by `tokenKey` |
| Data layer sees the user | RLS `auth.uid()` | Rules `request.auth` | Permissions / roles | API rules `@request.auth` |
| Realtime respects revocation | Only at JWT expiry | Listener cancelled | Yes | Per event |
| Dashboard users | List/search/filter, create/invite, recovery, magic link, ban for a time, delete | List, add, reset, disable, delete | Full: edit, sessions (revoke), identities, memberships, block, impersonate, audit | Record grid, set password, verify, impersonate |
| Orgs / teams | Do it yourself | Do it yourself | Teams | Do it yourself |
| Hooks | 6 (SQL or HTTP) | Blocking functions (paid) | Async only | Sync JS/Go |

A minimal but credible built-in auth has these:
- Users in the same database, queryable and joinable, so no profiles table has to be kept in sync.
- Short-lived tokens with refresh, and revocation that reaches live subscriptions **at once**, which
  Supabase does not do.
- Sign-in methods:
  - email and password with verification and reset;
  - magic link or OTP;
  - OAuth (Google, GitHub, Apple) and generic OIDC;
  - anonymous, with linking;
  - external providers too (Clerk, Auth0), which bunvex already accepts (STUDY-27).
- A pluggable email sender, rate limits, and synchronous hooks.
- A Users screen with search and filters, a detail view (identities, sessions with revoke), the actions
  ban for a time, reset, verify, delete and impersonate (audited), auth settings, and an audit log.
- TOTP, passkeys, SSO and organizations can follow.

### 1.5 What minivex taught (the owner's earlier attempt)

minivex mounted better-auth as an HTTP server (`/api/auth/*` → `auth.handler`) beside the functions. Its
adapter (`createAdapterFactory`, raw SQL, with real transactions) wrote to its tables, and reactive
tables emitted changes. Apps "read through minivex, act through better-auth's HTTP API". What went wrong:

- **Thin identity.** Only the user id reached functions (`Identity = string | null`): no
  `getUserIdentity()`, no role and no claims (D7, never implemented).
- **No typed client for plugins.** The demo hand-wrote `fetch` calls to `/api/auth/organization/*` and
  `/admin/*`.
- **better-auth swallows storage errors.** A failing Redis read in `getSession` returned "no session" and
  logged everyone out. That needed a failure counter, a 503, and session sweeps.
- **Cookie refresh starvation (AUTH-01).** `getSession` on SSR used up the refresh window but could not
  set the cookie. Fixed with `deferSessionRefresh` plus an explicit refresh.
- **Version churn.** 1.7.0 changed account keying, which needed a migration, and 1.7.3 reverted it.
- **Naming traps.** Plural `modelName`s; logical vs physical table names; lazy DDL races.
- **Ban and logout depended on a change event arriving**, with a resync as backstop.
- **The dashboard** had only ban/unban and set-role. Raw edits in the data page could desync better-auth.
- **Security fixes from the audits:**
  - sign-up was open by default;
  - a bearer token survived a password change;
  - an admin password reset kept the attacker's session;
  - rate-limit buckets were spoofable through `X-Forwarded-For`;
  - an admin key could grant itself the role that unlocks impersonation.

The lesson: keeping better-auth **beside** the functions, behind HTTP, made two sources of truth (its
endpoints and the reactive tables) and left identity thin. Every fix was glue between them.

## 2. What an app can observe (the contract)

1. **Convex compatibility is not affected.**
   - `ctx.auth.getUserIdentity()`, the sync `Authenticate` message with a JWT, and `auth.config.ts`
     providers keep working exactly as in STUDY-27.
   - The official Convex client and `@convex-dev/auth` apps must still run. Built-in auth is an
     **addition**; an app that does not enable it sees nothing new.
2. **With built-in auth enabled, a user is a JWT identity like any other.**
   - `tokenIdentifier` is `issuer|userId` and `subject` is the user id.
   - Standard claims: `email`, `emailVerified`, `name`, `pictureUrl`. Configured custom claims carry
     things like `role` and `sessionId`.
   - Functions that only call `getUserIdentity()` cannot tell built-in auth from Clerk.
3. **New:**
   - the user and organization tables, readable in queries;
   - `ctx.auth.getUserId()` / `getUser()`;
   - a client `auth` API (sign in, sign up, session, plugin methods);
   - a Users screen in the dashboard;
   - revocation that reaches live subscriptions at once.

## 3. How bunvex would do it

### 3.1 Four options

| | A. better-auth beside (HTTP) | B. better-auth bridged per call (the Convex component) | **C. better-auth hosted in the engine** | D. Native (Convex Auth-style) |
|---|---|---|---|---|
| Where it runs | Its own router | Actions; one transaction per DB call | **Each endpoint is a bunvex function; adapter over the current transaction** | bunvex functions written by us |
| Atomic flows | Yes (own DB tx) | No | **Yes (one mutation)** | Yes |
| Reactive and cached | Partly (emitted changes) | Yes, but slow | **Yes: the tables are bunvex tables** | Yes |
| Plugins | All | Subset | **Allowlisted, per plugin** | Only what we write |
| Security code we own | Glue | Glue | Glue + dispatch | Everything |
| Version churn | High | High | Medium (pinned, tested) | None |
| Precedent | minivex | Convex | — | Convex Auth, PocketBase |

**Recommendation: C, with a bunvex-owned surface** (tables, identity, client API, dashboard).
better-auth becomes an implementation detail that is pinned and tested per plugin. If it ever stops
fitting, that surface lets us replace it with D piece by piece. Option A is what minivex did, and B is
what Convex did; §1.3 and §1.5 show why neither works well.

### 3.2 Why C is possible here and not in Convex

bunvex runs functions **in the same process as the engine**. A transaction body is a JS closure
(`engine.mutation((db) => …)`), not a function name sent to another isolate. So:

- **A better-auth endpoint runs inside one mutation.** Its adapter wraps the mutation's `Tx`, so every
  `create`, `findOne` and `update` is a read or write in **the same serializable OCC transaction**, which
  is atomic and retried as a whole. better-auth's `transaction(cb)` is then just `cb(sameAdapter)`.
- **When an endpoint must do I/O, it runs in an action.** The adapter then runs each call as a short
  engine query or mutation. `transaction(cb)` runs `cb` inside **one** engine mutation, because the
  closure can be handed to the engine directly. Convex can only call named functions across the
  boundary, which is why its adapter cannot honor `transaction`.
- **The reads that matter become queries.** `getSession`, `listSessions` and the admin `listUsers` run
  as queries. Their results are cached by identity and pushed live; "my session" in the client is a
  subscription, not polling.

### 3.3 The architecture

```
client (BunvexClient / React)                 bunvex process
  auth.signIn.email(...) ──WS: Mutation──▶  auth:dispatch (mutation) ─┐
  auth.useSession()     ──WS: Query──────▶  auth:session  (query)     ├─ better-auth (/minimal) with
  auth.signIn.social()  ──WS: Action─────▶  auth:dispatch (action)    │  the bunvex adapter over Tx
  browser redirect      ──HTTP───────────▶  /auth/callback/:p (HTTP action → action)
                                             │ writes users / sessions / accounts (bunvex tables)
  setAuth(jwt) ◀── token ── issued by the auth mutation (RS256/ES256, keys in-process)
  every function: ctx.auth.getUserIdentity() ← verified in-process (no JWKS fetch)
                  + the session row read as a dependency → revocation re-runs or ends subscriptions
```

**1. One better-auth instance per deployment, built once** from `better-auth/minimal`, with no Kysely.
- Its configuration lives in the app (`bunvex/auth.ts`, §3.7). It is built at startup, not per request.
- The secret comes from deployment environment variables (`BUNVEX_AUTH_SECRET`, or the existing env
  mechanism once it lands).

**2. The adapter** (`createAdapterFactory`) over a `Tx`.
- **Where clauses.** `where` maps to index ranges when an index matches, and to a filter otherwise.
  `contains` / `starts_with` / `ends_with` / `insensitive` become filters, which the admin search needs.
- **Pagination.** `offset` is supported, by skipping rows on the index.
- **Ids.** They come from the engine (`_id`), with `disableIdGeneration`, and `id`↔`_id` are mapped.
- **Options.** Dates are stored as numbers (`supportsDates: false`); `consumeOne` and `incrementOne` are
  implemented directly, which is correct under OCC.
- **Cost.** Adapter calls never leave the process: a `findOne` is an index read in the current snapshot,
  not a network round trip.

**3. Endpoint dispatch.** Every better-auth endpoint the deployment enables is classified once
(§3.5):
- **query**: reads only; session refresh deferred (`deferSessionRefresh`);
- **mutation**: writes, no I/O;
- **action**: needs `fetch` (OAuth, HIBP, captcha), or sends its email synchronously.

The dispatcher calls `auth.api[endpoint]({ body, headers })`. The headers are synthesized: the session
token comes from the caller's session, not a cookie. `returnHeaders` collects what better-auth wanted to
set (session token, JWT), and the dispatcher turns it into a function result.

**4. Side effects leave the transaction.**
- **Email and SMS** go through better-auth's `advanced.backgroundTasks.handler`, which bunvex maps to
  "schedule this action after commit" (the scheduler, Phase 3 item 2). An aborted mutation then sends
  nothing, and a retried one sends once.
- **Before hooks** run inside the transaction; after hooks are already deferred by better-auth until
  commit.
- **Password hashing** (scrypt, tens of ms, ~32 MB) runs inside the mutation. It lengthens the
  transaction, but `node:crypto.scrypt` is async (it runs on a worker thread in Node; to be measured in Bun). If measurements show OCC
  contention, sign-in can be split (verify in an action, then commit in a mutation).

**5. Randomness (B5).** better-auth calls `crypto.getRandomValues` for ids, session tokens, OTPs and
salts. bunvex mutations currently **throw** on it (`packages/core/src/determinism.ts`: Convex-style
determinism).
- A seeded PRNG is not acceptable for secrets.
- So the auth dispatcher's executions get the real CSPRNG. This is safe for mutations: a retry starts
  fresh and discards everything, and nothing else depends on replaying the same values.
- Queries stay deterministic; the session read needs no randomness.
- It is a narrow, internal exception, not an app-visible one.

**6. Identity: a JWT for the protocol, plus the session row for revocation (B3).**
- **The token.** After sign-in the dispatcher asks better-auth's `jwt` plugin for a token. The keys are
  RS256 or ES256 (the algorithms STUDY-27's custom JWT path supports); better-auth's default is EdDSA.
  The token carries `sub` = the user id, the `sessionId`, and the configured claims.
- **The client** sends the JWT with `Authenticate`, so the sync protocol, the official client and
  `ctx.auth.getUserIdentity()` stay exactly STUDY-27's.
- **Verification is local.** The built-in provider is registered with the verifier with its keys in
  memory: no discovery, no JWKS fetch, and `iss` is the deployment URL.
- **Immediate revocation**, which Convex Auth, Supabase and Firebase only get at JWT expiry:
  - The sync session reads its `session` row (and the user's `banned` flag) as a **tracked read**, like a
    query.
  - A write that revokes the session, bans or deletes the user, or changes the password therefore
    invalidates that read. The server answers as for an expired token: `AuthError`, the client fetches a
    new token, and gets none.
  - Subscriptions are never served past a revocation.
- **Cost.** Per execution, the HTTP path and the function calls pay one indexed read, cached by session.

**7. Tables (B4).** Two kinds:
- **App tables** in the app's schema, like Convex Auth: `users` (with what plugins add: `role`,
  `banned`, `username`, …), plus `organizations`, `members` and `invitations` when that plugin is on.
  Apps can query them, use `v.id("users")` and join on them, and the dashboard's data browser shows them.
  Writes through `ctx.db` are refused for better-auth-owned fields, so the data page cannot desync it
  (minivex's `ADMIN_BACKLOG` problem).
- **System tables**, not visible to `ctx.db`: `_auth_accounts` (password hashes, OAuth tokens),
  `_auth_sessions`, `_auth_verifications` and `_auth_jwks`. They are read by the dispatcher and the
  dashboard's system functions only.
- **Names.** They are fixed by bunvex, not left to better-auth's `modelName` pluralization (minivex's
  trap). The schema comes from better-auth's `getAuthTables(options)` at build time, with a test that
  fails when a better-auth upgrade changes it.

**8. Rate limits and origin checks (B8).** `auth.api.*` skips better-auth's rate limiter and its
origin/CSRF middleware, which run only in `handler`.
- **Rate limits** are implemented by bunvex itself as a table-backed token bucket, keyed by identifier
  and the client IP the server saw. They are atomic under OCC, unlike #432.
- **CSRF** only matters for the HTTP routes that use cookies (§3.4), which check `Origin` against
  `trustedOrigins` there.
- Calls over the WebSocket carry a token, not ambient cookies, so they are not CSRF-prone.

### 3.4 What still needs HTTP

These go through bunvex HTTP actions (Phase 3 item 4), mounted under `/auth/*`:
- **Browser redirects:** the OAuth `callback/:provider`, links in emails (verify, reset, magic link), and
  the passkey/WebAuthn ceremony origin.
- **SSR:** an httpOnly cookie channel for frameworks (Next.js and the like), as Convex Auth's middleware
  does. It holds the refresh secret, and the page gets a JWT.
- **JWKS and `/.well-known/openid-configuration`,** so third-party backends can verify bunvex-issued
  tokens.

Everything else goes over the sync WebSocket as a function call. That avoids the separate auth domain
(`convex.site`), the localStorage-faked cookies and the proxy `x-forwarded-host` 404s of the Convex
component.

### 3.5 Plugins: an allowlist, one manifest each (B7)

Each supported plugin gets a **manifest**:
- its endpoints and their function kind;
- the tables and fields it adds, split into app and system;
- what it needs (email, `fetch`, HTTP redirect, origin);
- its client binding;
- a conformance test that runs its flows through bunvex.

A plugin without a manifest is refused at startup with an error that names it. better-auth is pinned to
one minor version; upgrading it is a PR that runs every manifest's tests.

| Tier | Plugin | Kind of endpoints | Needs | Notes |
|---|---|---|---|---|
| 1 | email + password (core) | mutation; reset/verify send email | scheduler | scrypt in mutation (§3.3.4) |
| 1 | **admin** | query (list-users, list-user-sessions, has-permission), mutation (set-role, ban, unban, create, update, remove, set-password, revoke, impersonate) | — | the dashboard's engine; impersonation audited |
| 1 | jwt (internal) | — | keys | always on; RS256/ES256 |
| 1 | username, anonymous | mutation | — | anonymous → link on sign-up |
| 1 | email-otp, magic-link | mutation + scheduled email; verify via mutation or HTTP link | scheduler, HTTP | |
| 2 | organization (+ teams, dynamic roles) | query + mutation; invitations email | scheduler | uses transactions: atomic here |
| 2 | two-factor (TOTP, backup codes, OTP) | mutation | — | needs the signed 2FA step state without a cookie: kept in the session |
| 2 | social providers, generic-oauth | action + HTTP callback | fetch, HTTP | user + account created in one mutation |
| 2 | passkey (`@better-auth/passkey`) | mutation | HTTP origin, `rpID` | |
| 3 | phone-number | mutation + scheduled SMS | SMS sender | |
| 3 | api-key (`@better-auth/api-key`) | mutation; verified on HTTP calls | — | an extra identity path for HTTP |
| — | bearer, multi-session, oauth-proxy, one-tap, captcha (as is) | — | — | replaced by bunvex's transport or not needed; captcha can be a bunvex check |
| — | sso (`@better-auth/sso`), oidc-provider | later | | bunvex runs on Bun, so Node dependencies are not the blocker they are in Convex |

### 3.6 The client and its DX

```ts
// bunvex/auth.ts — the deployment's auth, next to its functions
import { defineAuth } from "@bunvex/auth/server";
import { admin, organization } from "better-auth/plugins";
import { internal } from "./_generated/api";

export const auth = defineAuth({
  emailAndPassword: { enabled: true, requireEmailVerification: true },
  socialProviders: { github: { clientId: process.env.GITHUB_ID!, clientSecret: process.env.GITHUB_SECRET! } },
  plugins: [admin(), organization()],
  // An action, scheduled after the mutation commits.
  sendEmail: internal.emails.send,
  signUp: "open", // or "invite-only"; closed unless configured (minivex's audit)
});
```

```ts
// bunvex/schema.ts — users are a real table of the app
import { authTables } from "@bunvex/auth/server";
export default defineSchema({ ...authTables(auth), notes: defineTable({ owner: v.id("users"), text: v.string() }) });
```

```ts
// any function: the Convex way still works, plus helpers
export const myNotes = query(async (ctx) => {
  const userId = await ctx.auth.getUserId(); // null when signed out; reads no row
  if (!userId) return [];
  return ctx.db.query("notes").withIndex("by_owner", (q) => q.eq("owner", userId)).collect();
});
```

```tsx
// the client: one object, typed by the plugins the deployment enabled
const client = new BunvexReactClient(url);
const authClient = createAuthClient({ client, plugins: [adminClient(), organizationClient()] });

await authClient.signUp.email({ email, password, name });
await authClient.signIn.email({ email, password });
await authClient.signIn.social({ provider: "github" }); // a redirect through /auth/callback/github
const { data: session } = authClient.useSession(); // a live subscription, not polling
await authClient.organization.create({ name: "Acme", slug: "acme" });
await authClient.admin.banUser({ userId, banReason: "spam", banExpiresIn: 86400 });

<BunvexProviderWithAuth client={client} useAuth={authClient.useBunvexAuth}>…</BunvexProviderWithAuth>
```

**How the client works.** `createAuthClient` is better-auth's own client, with
`fetchOptions.customFetchImpl` routing each request (path + body) to the dispatcher as a function call
over the existing socket, instead of HTTP. So the plugins' typed client methods (`adminClient`,
`organizationClient`, `twoFactorClient`, …) come for free: minivex had to hand-write `fetch` calls.
- **`useSession`** is backed by a subscription to `auth:session`.
- **`useBunvexAuth`** feeds STUDY-27's `BunvexProviderWithAuth`. The token is set with `setAuth`, which
  refreshes it; a revocation logs out every tab and device at once.
- **React Native and other non-browser clients** use the same object (the token in configurable
  storage).

### 3.7 The dashboard (B9)

The dashboard calls `_system/auth:*` functions with the admin key (Phase 3 item 6). They use better-auth's
internal adapter and admin logic on behalf of the operator; the operator is not a user session.

**Users** (a reactive list):
- **List:** search by email, name or id; filters for provider, verified, anonymous, banned and role;
  sort; pagination.
- **Create:** a user, or an invitation (by email link).
- **Detail:** profile and editable metadata; linked accounts (providers); **sessions**, with device, IP
  and last seen, and revoke one or all; organizations; recent auth events.
- **Actions:** set role; ban, optionally for a time with a reason; unban; set password; send
  verification or reset; delete (with what references the user).
- **Impersonate:** requires a deploy-scoped admin key, is audited and time-limited, and an impersonated
  session is marked as such.

**Organizations** (when the plugin is on): list; members with their roles; invitations; teams.

**Settings:**
- methods and providers, with their secrets in environment variables;
- sign-up policy;
- token and session lifetimes;
- redirect allowlist (`trustedOrigins`);
- email templates and sender;
- rate limits.

**Audit log:** a system table of auth events (sign-ins, failures, revocations, admin actions).

### 3.8 Prerequisites and phases

| Step | Content | Depends on |
|---|---|---|
| 0 | **Spike** (a branch, no PR): better-auth `/minimal` with the Tx adapter. `signUpEmail` and `signInEmail` in a mutation, `getSession` in a query. Measure latency and OCC under concurrent sign-ins; list every determinism blocker | — |
| 1 | Scheduler (Phase 3 item 2), HTTP actions (item 4), env vars / secrets, admin keys (item 6) | roadmap |
| 2 | Core: tables, adapter, dispatcher, privileged randomness, JWT issuing + local verification, session liveness, email + password, rate limits, `@bunvex/auth` client + React | 0, 1 |
| 3 | admin plugin + dashboard Users | 2 |
| 4 | Email flows (verify, reset, magic link, OTP); OAuth providers via HTTP callback | 2, scheduler, HTTP actions |
| 5 | organization, two-factor, passkey, anonymous, username | 2 |

`@convex-dev/auth` running unmodified on bunvex is a separate, Convex-parity item. It is ordinary
functions plus HTTP routes, so it should follow from Phase 3 items 2–4, with a test of its own.

## 4. Divergences and decisions

Built-in auth is a feature Convex does not have, so each choice is the owner's.

| # | Decision | Recommendation | Why | Decision |
|---|---|---|---|---|
| B1 | Ship built-in auth (Convex has none) | yes, opt-in; Convex-compatible auth unchanged | the main gap against Supabase, Firebase, Appwrite and PocketBase | **accepted** (owner, 2026-10-01) |
| B2 | How: A beside / B bridged / C hosted / D native | **C**, behind a bunvex-owned surface | atomic, reactive and fast; better-auth's breadth; replaceable | **accepted** (owner, 2026-10-01) |
| B3 | Identity: JWT over the protocol + session row tracked for revocation | yes | protocol and official client unchanged; revocation reaches subscriptions at once | **accepted** (owner, 2026-10-01) |
| B4 | Tables: `users` (and orgs) in the app schema; secrets in system tables; better-auth-owned fields read-only through `ctx.db` | yes | joinable users without leaking hashes or tokens; no desync | **accepted** (owner, 2026-10-01) |
| B5 | The auth dispatcher's executions use the real CSPRNG (app mutations still throw) | yes | secrets cannot come from a seeded PRNG; retries discard everything | **accepted** (owner, 2026-10-01) |
| B6 | Transport: auth endpoints are function calls over the socket; HTTP only for redirects, email links, SSR cookies, JWKS | yes | no auth domain, no faked cookies, no proxies | **accepted** (owner, 2026-10-01) |
| B7 | Plugins: allowlist with a manifest + conformance test each; better-auth pinned to a minor | yes; tiers as §3.5 | better-auth's churn (minivex, #433) stays out of apps | **accepted** (owner, 2026-10-01) |
| B8 | Rate limits and origin checks done by bunvex (`auth.api` skips better-auth's) | yes | atomic under OCC; IP from the server, not `X-Forwarded-For` | **accepted** (owner, 2026-10-01) |
| B9 | Dashboard Users / Organizations / Settings / Audit through `_system/auth:*` with the admin key | yes, after admin keys | the operator is not a user; impersonation needs a deploy-scoped key | **accepted** (owner, 2026-10-01) |
| B10 | Order: the spike first, then the prerequisites (scheduler, HTTP actions, env, admin keys), then §3.8 | yes | the spike settles B5 and whether scrypt-in-mutation holds before anything is built on it | **accepted** (owner, 2026-10-01) |

They are in [docs/parity/divergences.md](../parity/divergences.md) as DV-102–DV-111 (decided).

## 5. Tests

- **Per plugin manifest** (§3.5): its flows end to end through `BunvexClient`. Sign-up, sign-in, sign-out,
  reset by email (with a test email sink), OAuth against a local fake provider, admin actions, and
  organization flows.
- **Atomicity:** a failure injected between better-auth's steps (user created, account not) leaves
  nothing behind; concurrent sign-ups with one email produce one user; OTP and verification tokens are
  single-use under concurrency (`consumeOne`).
- **Revocation:** a subscription that reads the identity stops (`AuthError`) within one transition of a
  ban, a session revocation, a password change or a user deletion. A test checks it is not delayed until
  JWT expiry.
- **Isolation:** `ctx.db` can neither read `_auth_*` tables nor write better-auth-owned fields.
- **Security regressions** from minivex's audits: sign-up closed by default; a password change revokes
  the other sessions; an admin password reset revokes the user's sessions; rate limits use the server's
  IP; the admin role cannot be self-granted.
- **Compatibility:** the official `ConvexClient` with a bunvex-issued token; `@convex-dev/auth` app
  tests once its prerequisites land.
- **Performance:** sign-in latency and throughput (scrypt included), `getSession` as a cached query, and
  the per-execution cost of the session liveness read, compared with the STUDY-27 path.

## 6. Open questions

- Does any better-auth code path read time or randomness in a way that breaks under a retried
  transaction? For example, a token minted and returned in one attempt, then retried. The spike answers
  it, and the dispatcher only ever returns the final attempt's result.
- Session refresh: with JWTs refreshed by the client (`setAuth`), better-auth's sliding `updateAge`
  refresh can run in the token mutation instead of in `getSession`.
- The email sender: a function in the app (`sendEmail: internal.emails.send`) is the most flexible.
  Should the dashboard also have a built-in SMTP configuration, as the others do?
- Multi-tenant: one deployment is one auth realm. Organizations cover tenancy inside an app.

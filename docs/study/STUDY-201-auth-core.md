# STUDY-201 — Built-in auth, the core
<!-- index: the first build step of built-in auth (STUDY-191 §3.4 step 3): Convex Auth v2's `auth` component (accounts, sessions, refresh-token rotation, deployment-signed access tokens), `authPassword`, `authUsername`, `authAnonymous`, the username + password and anonymous methods, `getAuthUserId` on the live session, the React client and the browser session manager; written from convex/convex-auth `reboot` at db15c82e | decided (owner, 2026-11-01): C-1–C-8 as recommended, C-2 a native hasher (AD-49); DV-577 and DV-581 extended -->

- **Status:** decided (owner, 2026-11-01): C-1–C-8 as recommended, except C-2, where the owner chose the native
  hasher (AD-49) over v2's WASM; C-3 extends DV-581, C-4 DV-577. To be built (§3.5). Decided before: STUDY-191's A-1–A-8 (DV-575–DV-577);
  the rename of `packages/auth` to `@bunvex/identity`, with `@bunvex/auth` reused for the auth components (A-2,
  confirmed by the owner on 2026-11-01, §3.2).
- **Scope:** STUDY-191 §3.4 step 3, "the core": the `auth` component; `authAnonymous`, `authUsername`,
  `authPassword` with the username + password method; the React client and the browser session manager;
  `getAuthUserId` and `isAuthenticated`; `setupConvexAuth` and the app wiring; the examples for username + password
  and anonymous. STUDY-191's decisions A-1–A-8 (DV-575–DV-577) apply.
- **Convex source read:** convex/convex-auth `origin/reboot` at **`db15c82e`** (2026-10-28), the branch tip on
  2026-11-01. STUDY-191's pin is `84ccfa8d` (2026-10-26); the 15 commits between them are in §1.0, and so are the
  open branches of the session stack. Paths are relative to `packages/core/src/` unless they say otherwise.
- **Dependencies inspected:** `argon2id-wasm@0.0.0-alpha.2` from the npm tarball (the version `package.json` and the
  lockfile pin); `@convex-dev/rate-limiter` 0.3.2 and `@convex-dev/batch-worker` 0.3.4 from the lockfile.
- **convex-backend:** only for `signJwt` and the JWKS, already in bunvex (STUDY-192).
- **bunvex source:** `main` at `c496571d` (2026-11-01).
- **Related:**
  - [STUDY-191](STUDY-191-convex-auth-v2.md): the overview and its decisions;
  - [STUDY-192](STUDY-192-sign-jwt.md): `ctx.auth.signJwt` and the JWKS;
  - [STUDY-197](STUDY-197-rate-limiter.md), [STUDY-200](STUDY-200-resend.md): the rate limiter and DV-581;
  - [STUDY-27](STUDY-27-auth.md): `ctx.auth` and token verification; [STUDY-159](STUDY-159-testing.md):
    `@bunvex/testing`.

## 1. How Convex does it

### 1.0 What changed since STUDY-191's pin

The 15 commits `84ccfa8d..db15c82e`, one line each on what they change for the core:

| Commit | Date | Title | For the core |
|---|---|---|---|
| `a26944f5` | 10-26 | Convert docs from Fumadocs to Docusaurus (#790) | Docs only (`packages/docs`). Nothing |
| `56bf5c50` | 10-26 | Move to stateful session auth (#757) | **`sub` becomes the session id** (`mintAccessToken`); new query `public.getSession`; `getAuthUserId` calls it through `componentsGeneric().auth`; `sessionIdentity()` test helper (`testing/core.ts`) |
| `09915cc0` | 10-27 | Session revocation support (#759) | New `public.listSessions` and `public.revokeSessions`; `ctx.convexAuth.revokeOtherSessions()` (`server/setup.ts`) |
| `cd2b49ee` | 10-27 | Use components and structure more like docs.convex.dev (#791) | Docs only |
| `f16ecb70` | 10-27 | Typo fix (#792) | Doc comment in `methods/username-password/react.tsx`. Nothing |
| `073617e3` | 10-27 | docs: Fix light mode code highlight (#793) | Docs only |
| `524af414` | 10-27 | docs: vertical line in steps (#794) | Docs only |
| `82e0ce50` | 10-27 | Add convexAuthProvider() for auth.config.ts (#788) | New `convexAuthProvider()` (`server/authProvider.ts`), exported from `./server`; every example's `auth.config.ts` and the CLI's scaffold use it |
| `338e98b2` | 10-27 | Typecheck the code examples in doc comments in CI (#763) | Passkey/OAuth doc comments; `check:doc-examples` in `preversion`. Nothing for the core |
| `f732bf21` | 10-28 | Session revocation support for password reset (#775) | `changePassword` gains `signOutOtherSessions?: boolean` and becomes an `authMutation` (it was `mutationGeneric`); example `PasswordSettings.tsx` gets the checkbox |
| `e0714978` | 10-28 | Revoke all of a user's sessions on email password recovery (#779) | New helper `ctx.convexAuth.revokeAllSessions(userId)`; `revokeListedSessions` shared by both helpers. Used by email recovery (step 4), not by the core's methods |
| `9bde7472` | 10-28 | Update isAuthenticated to read from the session (#760) | `isAuthenticated` = `getAuthUserId(ctx, component) !== null` (was `getUserIdentity() !== null`) |
| `a7e964a9` | 10-28 | Say "sign-in method" instead of "provider" (#696) | Wording: `ProviderBuilders` → `MethodBuilders` (internal type), the duplicate-name error says "sign-in method"; doc comments. No public function or table renamed |
| `a5e0d480` | 10-28 | Fix stale docs (#748) | Doc comments in `methods/anonymous/react.tsx`, example READMEs. Nothing |
| `db15c82e` | 10-28 | Keep email + password flow secrets in the provider's storage (#722) | `AuthClient.storage` getter (`@internal`) for the email method's flow secrets. Nothing for the core's flows |

No change to `component/schema.ts`, to the password, username or anonymous components, or to `argon2id-wasm`
between the pin and `db15c82e` (`git diff --stat 84ccfa8d db15c82e`).

**Not merged at `db15c82e`** (Christian Wyglendowski's and Nicolas Ettlin's open branches, all 2026-10-28, all based
on `9bde7472` or `a5e0d480`):

- `dowski/cap-max-sessions` (`e43477bc`): `MAX_SESSIONS_PER_USER = 100`, evicting the least recently refreshed
  session on sign-in. At `db15c82e` this is only a TODO (`component/public.ts:244`).
- `dowski/compute-refresh-token-expiry` (`a712847b`): drops `refreshTokens.expiresAt`; expiry is computed from the
  token's issue time and the current TTL.
- `dowski/session-helpers` (`57d586ab`): moves helpers out of `public.ts` (`component/expiry.ts`).
- `dowski/expired-session-cleanup` (`37d05056`): the core mounts **`@convex-dev/batch-worker`** and runs a sweep of
  expired sessions; new index `refreshTokens.by_state [state, retiredAt]` and new table `ttlConfig
  {refreshTokenTtlSeconds}`.
- `dowski/revoke-count-live-sessions` (`0a0cc3cb`): `revokeOtherSessions` counts every revoked session.
- `dowski/auth-state-client` (`0b7202c9`): the **`SessionWatcher`**; `ConvexAuthApi` requires `isAuthenticated`.
- `nicolas/reorg-rename-provider-names` (`d1dee251`): `registerPasswordProvider` → `registerPassword`,
  `registerAnonymousProvider` → `registerAnonymous`, email's `completeSignUp` → `completeSignUpWithEmailPassword`.
- `nicolas/reorg-internal-ambient-sign-ins` (`78ebd18b`): `ambientSignIns` becomes `@internal`; `oauth` no longer
  exported from `methods/oauth/react`.

So STUDY-191 §1.6's "stack under review" is half in: `sid-in-jwt`, `revokeSessions`/`listSessions`,
`revokeOtherSessions`, revocation on password change and recovery, and `auth-state-server` are merged; **the
100-session cap, the batch-worker sweep and the `SessionWatcher` are not**.

### 1.1 The package (`packages/core/package.json`)

- `@convex-dev/auth` `2.0.0-beta.0` (the version field at `db15c82e`; no beta.1 tag yet), `"type": "module"`,
  `"sideEffects": false`, Apache-2.0. `bin: {"@convex-dev/auth": "./dist/cli/init.js"}` (the `init` scaffolder,
  `cli/program.ts`: writes `convex/auth.config.ts`, `convex.config.ts`, `auth.ts`).
- Every export has a `convex-auth-internal-types` condition pointing at `dist/internal-types/` (declarations built
  with `--stripInternal false`), then `types`, then `default`.
- **Exports the core uses:**

| Entry point | Source | What |
|---|---|---|
| `.` | `index.ts` | types only: `ConvexAuthApi`, `IsAuthenticatedFn`, `RefreshSessionFn`, `SignInComplete`, `SignInEnvelope`, `SignInError`, `SignOutFn`, `TokenBundle` |
| `./server` | `server/index.ts` | `convexAuthProvider`, `setupConvexAuth`, type `AuthCore`, `getAuthUserId` |
| `./react` | `react/index.tsx` | `ConvexAuthProvider`, `useAuthActions`, `useAuthToken`; types `TokenStorage`, `ConvexAuthApi`, `TokenBundle`, `ConvexAuthActionsContextType`. **`useAuth` is not exported** (it lives in `react/client.tsx`, passed to `ConvexProviderWithAuth`) |
| `./browser` | `browser/index.ts` | `TokenStorage`, `InMemoryStorage`, `defaultStorage`, `JWT_STORAGE_KEY`, `REFRESH_TOKEN_STORAGE_KEY`, `runWithMutex`, `AuthClient`, types `SpaAuthApi`, `SsrAuthApi`, `AuthClientConfig`, `AuthState` |
| `./convex.config(.js)`, `./_generated/component(.js)` | `component/` | the core component and its `ComponentApi` |
| `./test` | `src/testing/core.ts` (source) | `registerCore(t, name = "auth")`, `sessionIdentity(tokens)` |
| `./components/username/{convex.config,_generated/component}(.js)`, `/test` | `components/username/`, `testing/username.ts` | `authUsername`; `registerUsername(t, name = "authUsername")` |
| `./components/password/…`, `/test` | `components/password/`, `testing/password.ts` | `authPassword`; `registerPasswordProvider(t, name = "authPassword")`, which also registers `${name}/rateLimiter` |
| `./components/anonymous/…`, `/test` | `components/anonymous/`, `testing/anonymous.ts` | `authAnonymous`; `registerAnonymousProvider(t, name = "authAnonymous")` |
| `./methods/username-password` | `methods/username-password/index.ts` | `DEFAULT_MIN_PASSWORD_LENGTH` (10), for any runtime |
| `./methods/username-password/server` | `…/server.ts` | `setupUsernamePassword`; types `UsernamePasswordOptions`, `SignInResult`, `SignUpResult`, `ChangePasswordResult` |
| `./methods/username-password/react` | `…/react.tsx` | `useSignInWithUsernamePassword`, `useSignUpWithUsernamePassword`; types `Credentials`, `SignInWithUsernamePasswordResult`, `SignUpWithUsernamePasswordResult` |
| `./methods/anonymous/server` | `methods/anonymous/server.ts` | `setupAnonymous` |
| `./methods/anonymous/react` | `methods/anonymous/react.tsx` | `useSignInAnonymously`, type `SignInAnonymouslyMutation` |

- The `./test` helpers ship as TypeScript source because they use Vite's `import.meta.glob` (`testing/core.ts:1-10`).
- **Dependencies** and their use by the core:

| Package | Range | Used by the core for |
|---|---|---|
| `argon2id-wasm` | `0.0.0-alpha.2` (exact) | `hashPassword`, `verifyPassword` in `components/password/public.ts:6-9` (§1.6) |
| `@convex-dev/rate-limiter` | `^0.3.2` (lock 0.3.2) | the child `rateLimiter` of `authPassword` and its token bucket (§1.6). 0.3.x has no child component (0.4.0 added `batchWorker` and `pendingUpdates`, STUDY-200 §1.2) |
| `@convex-dev/batch-worker` | `^0.3.2` (lock 0.3.4) | **nothing in the core at `db15c82e`**: only `authEmail` and `authPasskey` mount it. The unmerged sweep (§1.0) would make it a child of `auth` |
| `jose` | `^5.2.2` | only `decodeJwt` in the `./test` helper `sessionIdentity` (`testing/core.ts:12,43`), and SSR / Apple. Not in any component or flow of the core |
| `cookie` | `1.1.1` | SSR only (`ssr/cookies.ts`). Not the core |
| `@simplewebauthn/*` | `^14` | passkeys only |
| `@babel/code-frame`, `chalk`, `commander` | | the CLI only |

- **Peers:** `convex ^1.48.0` (required); `react ^18 || ^19`, `next ^16`, `@convex-dev/resend ^0.2.8` (optional).

### 1.2 The `auth` component (`component/`)

- **Definition:** `defineComponent("auth")` (`component/convex.config.ts:21`). No env, no children, no HTTP routes,
  no crons. Knows no sign-in method; carries no signing material (the deployment signs, §1.3).
- **Schema** (`component/schema.ts`):
  - `accounts {provider: string, providerAccountId: string, userId: string}`; indexes `by_provider_account
    [provider, providerAccountId]`, `by_user [userId]` (`:7-13`).
  - `sessions {userId: string, accountId: Id<"accounts">}`; index `by_user [userId]` (`:19-22`). Written only on
    create and delete, so a query reading it is not invalidated by refreshes (`:15-18`).
  - `refreshTokens {hash: string, sessionId: Id<"sessions">, state: "issued" | "redeemed" | "spent" | "dropped",
    expiresAt: number, retiredAt?: number}`; indexes `by_hash [hash]`, `by_session_state [sessionId, state,
    retiredAt]` (`:50-64`). `hash` is the SHA-256 hex of the raw token; the raw token is never stored.
- **Constants** (`component/public.ts:26-49`): `AUDIENCE = "convex"`; `DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 60`;
  `DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 2592000` (30 days); `MAX_ACCESS_TOKEN_TTL_SECONDS = 3600`;
  `STANDARD_ISSUED_REFRESH_TOKEN_LIMIT = 3`; `REFRESH_GRACE_MS = 5000`; `SPENT_TOKEN_HORIZON_MS = 3600000`. The last
  three are exported (the tests import them).
- **Functions.** All are public in the component; the app sees them as `"internal"` (`_generated/component.ts`).
  Plain `Error`s only: **no `ConvexError` anywhere in the core component**.

| Function | Kind | Args | Returns | Does / throws |
|---|---|---|---|---|
| `public.signUp` (`:418`) | mutation | `claims: vAuthClaims`, `createUserHandle: string`, `onSignInHandle?: string`, `accessTokenTtlSeconds?: number`, `refreshTokenTtlSeconds?: number` | `vTokenBundle` | `resolveTtlConfig`; `createAccount` (runs `createUser` by handle, inserts the account); `notifySignIn`; `issueSession` |
| `public.signIn` (`:456`) | mutation | `claims`, `onSignInHandle?`, both TTLs | `vTokenBundle` | account by `(providerName, providerAccountId)`; none → throws (below); `notifySignIn`; `issueSession` |
| `public.signUpWithoutSession` (`:497`) | mutation | `claims`, `createUserHandle` | `{userId: string}` | `createAccount` only; no session, no `onSignIn` (email method; "kind of awkward" TODO `:504`) |
| `public.getUserIdByAccount` (`:526`) | query | `provider: string`, `providerAccountId: string` | `string \| null` | |
| `public.getSession` (`:550`) | query | `sessionId: string` | `{userId: string} \| null` | `normalizeId("sessions", …)`; a malformed id or a missing row → `null` |
| `public.refresh` (`:630`) | mutation | `refreshToken: string`, both TTLs | `vRefreshResult` | rotation, §1.3 |
| `public.signOut` (`:739`) | mutation | `refreshToken: string` | `null` | token by hash in any state → `deleteSession`; unknown → no-op |
| `public.listSessions` (`:778`) | query | `userId: string` | `{sessionId, creationTime, lastRefreshedAt, expiresAt}[]` | §1.4 |
| `public.revokeSessions` (`:842`) | mutation | `sessionIds: string[]` | `string[]` (ids revoked) | skips malformed, missing and repeated ids; no authorization (`:833-841`) |

- **Shared validators** (`lib/types.ts`):
  - `vTokenBundle = {accessToken: string, refreshToken: string, refreshTokenExpiresAt: number, userId: string}`
    (`:24`).
  - `vSignInComplete = {status: "complete", tokens: vTokenBundle}` (`:42`); `vSignInError(userError) = {status:
    "error", userError}` (`:63`).
  - `vRefreshResult = {kind: "rotated", tokens: vTokenBundle} | {kind: "noSession"}` (`:150`).
  - `vAuthClaims = {providerName: string, providerAccountId: string, profile: any}` (`:204`).
  - `USE_USER_ID_AS_ACCOUNT_ID = ""` (`:228`): the account is keyed by the user id `createUser` returns.
- **Errors thrown** (messages verbatim; `JSON.stringify`d values):
  - `resolveTtlConfig` (`:192-215`), at every call that takes TTLs (not at setup): `Token TTLs must be positive.`;
    `Access-token TTL must be at most one hour (the deployment refuses to sign a longer-lived JWT).`; `Access-token
    TTL must be shorter than the refresh-token TTL.`
  - `createAccount` (`:330-335`): `Cannot create an account: an account for provider = "<p>" and provider account ID
    = "<id>" already exists. Sign-in methods that cannot tell a first sign-in from a return visit must look the
    identity up (getUserIdByAccount) and call signIn instead.`; after `createUser` (`:360-362`): `Invariant
    violation: an account for provider = "<p>" and provider account ID = "<id>" already exists`.
  - `signIn` (`:473-477`): `Cannot sign in: no account for provider = "<p>" and provider account ID = "<id>" exists. A
    first sign-in for an identity must go through signUp.`
  - `redeem` (`:575-577`): `Invariant violation: a session has more than one redeemed refresh token`.
- **Logs** (`console.warn`): `Dropped refresh token used: a sibling was already redeemed, so the session has forked.
  Deleting the associated session. This could be due to a bug or a leaked refresh token.` / `Spent refresh token
  used: a later token was already redeemed. Deleting …` (`:657-664`); `Refresh token used with at least <n> issued
  tokens never redeemed: deleting the associated session. This could be due to a bug or a leaked refresh token.`
  (`:693-697`); `Session <id> has no issued refresh token, which should be impossible. Leaving it out of the
  session list.` (`:806-809`).
- **User callbacks** run as sub-transactions through function handles: `createAccount` calls
  `ctx.runMutation(createUserHandle, {provider: {name, accountId, profile}})` (`:339-345`); `notifySignIn` calls
  `ctx.runMutation(onSignInHandle, {provider: {…}, userId})` (`:384-391`). Both inside the core's mutation, so an
  `onSignIn` that throws rolls back the user `createUser` made (`:405-407`). On `signUp`, `onSignIn` receives the
  claims unchanged, so for a password account `provider.accountId` is `""` (§2.4).

### 1.3 Tokens

- **Access token** (`mintAccessToken`, `component/public.ts:226-235`): `ctx.auth.signJwt({claims: {sub: sessionId,
  aud: "convex"}, expiresInSeconds: ttl})`. The deployment adds `iss`, `iat`, `exp` and the header: ES256, the
  deployment's key, `iss = ${CONVEX_CLOUD_URL}/components/<mount path>` (`/components/auth` by default), JWKS at
  `${CONVEX_CLOUD_URL}/.well-known/jwks.json` (STUDY-192). **`sub` is the session id** (since `56bf5c50`), not the
  user id.
- **Identity.** On the app's `ctx.auth.getUserIdentity()`: `subject` = session id, `issuer` =
  `…/components/auth`, `tokenIdentifier` = `${issuer}|${sessionId}`, so it changes with every sign-in.
- **Lifetimes.** Access 60 s by default, at most 3600 s, and shorter than the refresh TTL; refresh 30 days. Set per
  app with `setupConvexAuth({accessTokenTtlSeconds, refreshTokenTtlSeconds})` and passed as args on every core call
  (§1.5); a change affects newly minted tokens only (`server/setup.ts:182-183`).
- **Refresh token** (`component/crypto.ts`): 32 bytes from `crypto.getRandomValues`, base64url without padding (43
  characters). Stored as `sha256Hex` (`lib/crypto.ts:11-19`, `crypto.subtle.digest`). `expiresAt = now +
  refreshTokenTtlSeconds × 1000` at issue (`:165-180`).
- **Rotation** (`refresh`, `:630-729`), with `now = Date.now()`:
  1. `resolveTtlConfig` first, so a bad config throws on every call (`:641`).
  2. Look up by hash. **Unknown** (never issued, or pruned past the horizon) → `{kind: "noSession"}`, nothing
     changed (`:652`).
  3. **`spent` or `dropped`** → warn, `deleteSession`, `noSession` (`:654-666`).
  4. **Expired** (`expiresAt <= now`, issued or redeemed) → `deleteSession`, `noSession` (`:672-675`).
  5. **`issued`** → `redeem` (`:568-601`): the session's redeemed token (at most one) becomes `spent` with
     `retiredAt = now`, its other issued tokens become `dropped` with `retiredAt = now`, this one becomes
     `redeemed`; then `pruneRetiredTokens` deletes spent/dropped rows with `retiredAt <= now − 1 h`.
  6. **`redeemed`** (a retry after a lost response) → read up to 3 issued tokens of the session, oldest first; if
     there are 3 and the oldest was created more than 5 s ago, warn, `deleteSession`, `noSession` (`:683-700`).
     Otherwise accepted, and the token stays `redeemed`.
  7. Issue a new `issued` token and a new access token; return `{kind: "rotated", tokens: {…, userId:
     session.userId}}` (`:707-727`). The session row is not written.
- **Concurrency.** Racers on one issued token serialize by OCC: the first redeems it, the rest find it redeemed and
  each gets its own issued token; within 5 s they do not count against the limit (`:623-628`).
- **`deleteSession`** (`:102-123`) deletes every token row of the session (unbounded `collect`, KNOWN_ISSUES), then
  the session if it still exists. Idempotent.
- **Sign-in** (`issueSession`, `:237-271`): insert the session, issue its first refresh token (state `issued`),
  mint the access token. Returns `{accessToken, refreshToken, refreshTokenExpiresAt, userId}`. No session cap at
  `db15c82e` (TODO `:244-247`).

### 1.4 Sessions, liveness and revocation

- **A session is live while its row exists** (`getSession` doc, `:544-545`). Rows are deleted by sign-out, reuse
  detection, an expired token presented to `refresh`, and `revokeSessions`. Nothing sweeps a session nobody comes
  back to (KNOWN_ISSUES; the sweep is unmerged, §1.0).
- **`getAuthUserId(ctx, component = componentsGeneric().auth)`** (`server/userId.ts:59-76`): `getUserIdentity()`;
  `null` → `null`; else `ctx.runQuery(component.public.getSession, {sessionId: identity.subject})` and return its
  `userId` as `GenericId<UsersTable>` (default `"users"`), or `null` when the session is gone. One component query
  per call; works in queries, mutations and actions (`ctx` needs `auth` and `runQuery`). The default component is
  resolved at module load (`:13-15`). In a subscribed query, deleting the session re-runs it.
- **`isAuthenticated`** (app query, `server/setup.ts:251-257`): `getAuthUserId(ctx, component) !== null`, so false
  for a revoked session whose token is still valid. It runs in the app, not the component, because only the app
  sees the caller's verified identity (`:247-250`).
- **`listSessions`** (`:778-821`): the user's sessions by `by_user`, newest first; for each, the newest `issued`
  token: `lastRefreshedAt` = its `_creationTime`, `expiresAt` = its `expiresAt`; `creationTime` = the session's.
  Expired sessions are included; the query does not read the clock (`:771-774`).
- **`revokeOtherSessions()`** (`ctx.convexAuth` helper, `server/setup.ts:368-388`): identity `null` → 0; session of
  `identity.subject` gone → 0; else list the user's sessions, drop the current one, `revokeSessions` the rest, and
  return how many of them had `expiresAt > Date.now()` (`revokeListedSessions`, `:293-309`). Expired ones are
  deleted but not counted. `@internal` in the types (`lib/types.ts:380`).
- **`revokeAllSessions(userId)`** (`:389-394`): the same over all of `userId`'s sessions, the caller's included.
  `@internal`. Used by email recovery, not by the core's methods.
- **What a revoked client sees** at `db15c82e`: its next `refresh` returns `noSession` and the client clears its
  storage; until then its access token still verifies, `getUserIdentity()` still returns the identity, but
  `getAuthUserId` and `isAuthenticated` return null/false at once and reactively. No client component watches
  `isAuthenticated` yet (the `SessionWatcher` is unmerged).

### 1.5 `setupConvexAuth` and the method builders (`server/setup.ts`)

- **`setupConvexAuth<UsersTable = "users">({component, usersTable?, accessTokenTtlSeconds?,
  refreshTokenTtlSeconds?})`** (`:185-419`). `usersTable` is type-level only (the core never touches the table;
  `:187-203`); the value is kept on the result for methods' type inference. No validation at setup.
- **Returns `AuthCore`** (`:67-150`): `{usersTable, component, signOut, refreshSession, isAuthenticated,
  bindProvider}`. The app re-exports the three functions:
  - `refreshSession` (`:224-234`): public mutation `{refreshToken: string}` → `vRefreshResult`; forwards to
    `component.public.refresh` with the configured TTLs.
  - `signOut` (`:236-245`): public mutation `{refreshToken: string}` → `null`.
  - `isAuthenticated` (`:251-257`): public query `{}` → `boolean`.
- **`bindProvider({name, createUser, onSignIn?})`** (`:264-409`, `@internal`): called by a method's
  `attachUserCallbacks`. A name bound twice on one core throws at module load: `A sign-in method named "<name>" is
  already bound to this auth core. Method names key the accounts table, so each method must have a unique name.`
  (`:275-281`). Returns `{authMutation}`.
- **`authMutation({args, returns?, handler})`** (`:397-406`): a public `mutationGeneric` whose handler gets
  `{...ctx, convexAuth: helpers}`. The helpers (`makeHelpers`, `:312-395`; types `BoundAuthHelpers`,
  `lib/types.ts:316-399`):
  - `completeSignUp({providerAccountId, profile})` → `component.public.signUp` with `createUserHandle:
    await createFunctionHandle(createUser)`, `onSignInHandle` (or `undefined`), the TTLs;
  - `completeSignIn({providerAccountId, profile})` → `component.public.signIn`;
  - `signUpWithoutSession(…)` → `component.public.signUpWithoutSession`;
  - `resolveUserId(providerAccountId)` → `component.public.getUserIdByAccount` with `provider: name`;
  - `revokeOtherSessions()`, `revokeAllSessions(userId)` (§1.4).
  Handles are created per call (`createFunctionHandle` inside the handler).
- **The user callbacks' types** (`lib/types.ts:246-308`): `createUser: FunctionReference_future<"mutation",
  "internal", {provider: {name: ProviderName, accountId: string, profile: Profile}}, GenericId<UsersTable>>`;
  `onSignIn?: FunctionReference_future<"mutation", "internal", {provider: {…}, userId: GenericId<UsersTable>},
  null>`. "Throw a `ConvexError` to reject the sign in" (`:274-276`).

### 1.6 The `authPassword` component (`components/password/`)

- **Definition:** `defineComponent("authPassword")`, `component.use(rateLimiter)` → child mounted as `rateLimiter`
  (`convex.config.ts:14-16`). No env.
- **Schema:** `passwords {userId: string, passwordHashPHC: string}`, index `by_userId [userId]` (`schema.ts`).
- **Rate limit** (`public.ts:33-40`): `new RateLimiter(components.rateLimiter, {verifyPassword: {kind: "token
  bucket", rate: 1, period: MINUTE, capacity: 5}})`, keyed by `userId` (no IP, per Pilcrow and OWASP, `:18-32`).
  So 5 attempts, then one a minute per user; the limit is consumed inside the transaction, and because failures are
  return values (not throws) the consumption commits.
- **Functions:**

| Function | Kind | Args | Returns | Does |
|---|---|---|---|---|
| `public.setPassword` (`:54`) | mutation | `userId: string`, `password: string` | `{success: true} \| {success: false, userError: setPasswordUserError}` | `validateNewPassword`; `hashPassword(NFC(password))`; insert or patch the row |
| `public.verifyPassword` (`:89`) | mutation | `userId`, `password` | `{success: true} \| {success: false, userError: verifyPasswordUserError}` | 1. rate limit (`RATE_LIMITED`, `retryAfterMs: status.retryAfter`); 2. `validatePasswordInputFormat`; 3. row by user, none → throws `No password stored for userId <id>.` (`:123`); 4. `verifyPassword(NFC(password), phc)`, false → `INVALID_CREDENTIALS` |

- **Validation** (`validation.ts`):
  - `MIN_PASSWORD_LENGTH = 10` (`:12`, also exported as `DEFAULT_MIN_PASSWORD_LENGTH`), `MAX_PASSWORD_LENGTH = 100`
    (`:20`), in code points of the raw (un-normalized) input (`:78`).
  - Order: `PASSWORD_TOO_SHORT {minimumLength: 10}` → `PASSWORD_TOO_LONG {maximumLength: 100}` →
    `PASSWORD_HAS_SURROUNDING_WHITESPACE` (`/^\s|\s$/u`) (`:72-93`); a new password then `PASSWORD_TOO_COMMON`
    (`:106-117`).
  - `setPasswordUserError` = the three format errors | `PASSWORD_TOO_COMMON`; `verifyPasswordUserError` = the three
    format errors | `INVALID_CREDENTIALS` | `RATE_LIMITED {retryAfterMs: number}` (`:26-61`).
  - `normalizePassword` = `normalize("NFC")` before hashing and verifying (`:122-124`).
  - Common passwords (`commonPasswords.ts`, `commonPasswords.generated.ts`): the 3000 most frequent passwords of 10+
    characters from SecLists' NCSC 100k list, keyed by code-point length, sorted; lookup on `NFC` then
    `toLowerCase()`, binary search. Regenerated by a `bun` script (`scripts/generateCommonPasswords.script.ts`).
- **argon2id** (`packages/argon2id-wasm`):
  - Rust `argon2` 0.5 via `wasm-bindgen` (`wasm-pack --target web`), 67 623-byte `argon2_wasm_bg.wasm`.
  - Parameters: argon2id, version 0x13, `m = 16384` KiB (16 MiB), `t = 3`, `p = 1`, 32-byte output (crate default)
    (`rust/src/lib.rs:7-10`).
  - Salt: 16 bytes from `crypto.getRandomValues` in JS (`src/index.ts:29`), so in a mutation it comes from the seeded
    CSPRNG. PHC string: `$argon2id$v=19$m=16384,t=3,p=1$<22-char B64 salt>$<43-char B64 hash>`.
  - Verify re-derives the algorithm and parameters from the stored PHC, so argon2i/argon2d and other parameters
    verify (`lib.rs:22-28`; test "verifyPassword is lenient about the stored PHC string").
  - Loading: `import wasmModule from "../rust/pkg/argon2_wasm_bg.wasm"` (`src/index.ts:5`), a `WebAssembly.Module`
    provided by the Convex CLI's `wasmPlugin` (STUDY-83); `init({module_or_path})` once, memoized
    (`src/index.ts:11-24`). Runs synchronously **inside the mutation**, blocking its isolate for one hash.
  - Errors: `Failed to initialize the argon2 WASM module: <cause>`, `Failed to hash password: <cause>`, `Failed to
    verify password against the stored hash: <cause>` (`src/index.ts:18,35,51-53`).
  - The generated `argon2_wasm.js` still holds a `new URL('argon2_wasm_bg.wasm', import.meta.url)` fallback, never
    taken because a module is passed.

### 1.7 The `authUsername` component (`components/username/`)

- **Definition:** `defineComponent("authUsername")`; no env, no children.
- **Schema:** `usernames {userId: string, username: string, usernameNormalized: string}`, indexes `by_userId
  [userId]`, `by_usernameNormalized [usernameNormalized]` (`schema.ts`). Uniqueness is kept by the code (`:16-18`).
- **Functions** (`public.ts`):

| Function | Kind | Args | Returns | Does |
|---|---|---|---|---|
| `public.setUsername` (`:35`) | mutation | `userId`, `username` | `{success: true, previousUsername: string \| null} \| {success: false, userError: setUsernameUserError}` | format check; another user holds the normalized name → `USERNAME_TAKEN`; patch the user's row (keeping a new spelling for the same user) or insert |
| `public.getUserIdByUsername` (`:74`) | query | `username` | `string \| null` | by normalized name |
| `public.getUsername` (`:91`) | query | `userId` | `string \| null` | the spelling as given |
| `public.deleteUsername` (`:107`) | mutation | `userId` | `{deleted: boolean}` | idempotent |

- **Rules** (`validation.ts`):
  - `normalizeUsername` = `toLowerCase()` then `normalize("NFC")` (`:168-170`).
  - Errors, first violation wins (`:130-157`): `USERNAME_HAS_SURROUNDING_WHITESPACE` (`/^\s|\s$/u`);
    `USERNAME_HAS_INVALID_CHARACTERS` for C0 controls (≤ U+001F), DEL and C1 (U+007F–U+009F), lone surrogates, 14
    bidi and invisible controls (U+061C, U+200B, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069, U+FEFF), 16 non-ASCII
    spaces (U+00A0, U+1680, U+2000–U+200A, U+202F, U+205F, U+3000), noncharacters U+FDD0–U+FDEF and every
    U+xxFFFE/U+xxFFFF (`:41-113`), or a leading combining mark (`/^\p{M}/u`); `USERNAME_TOO_SHORT {minimumLength: 1}`
    in code points after normalization. ZWJ and ZWNJ are allowed; no maximum; inner spaces allowed.
  - `setUsernameUserError` = those four plus `USERNAME_TAKEN` (`:19-32`).

### 1.8 The `authAnonymous` component (`components/anonymous/`)

- `defineComponent("authAnonymous")`; schema `accounts {anonymousId: string}`, **no index** (`schema.ts`).
- `provider.createAnonymousAccount` (`provider.ts:8-15`): mutation, no args, no `returns` validator; inserts
  `{anonymousId: crypto.randomUUID()}` and returns the UUID (seeded in a mutation).

### 1.9 The methods (app side)

**`setupUsernamePassword(core, {component, usernameComponent})`** (`methods/username-password/server.ts:115-351`),
then `.attachUserCallbacks({createUser, onSignIn?})` typed `UserCallbacks<"password", Record<string, never>,
UsersTable>`. Binds the method name `"password"` (`PROVIDER_NAME`, `:23`, "TODO: derive this from the component
mount path"). Returns three public mutations:

- **`signUpWithUsernamePassword({username, password})`** → `signUpResult` = `vSignInComplete | vSignInError(
  setPasswordUserError | setUsernameUserError)` (`:59-62`, `:142-226`):
  1. `validateUsernameFormat` → error; 2. `validateNewPassword` → error; 3. `getUserIdByUsername` → taken:
     `USERNAME_TAKEN`; 4. `completeSignUp({providerAccountId: "", profile: {}})` (account keyed by the new user id);
     5. `setUsername`, failure → throws `Unexpected error when setting the username: <code>` (`:198-202`); 6.
     `setPassword`, failure → throws `Unexpected error when setting the password: ` + `userError`, a variable that
     is `null` there, so the message would end in `null` (`:218-221`; unreachable after step 2).
  - So username errors come before password errors, and `USERNAME_TAKEN` after both.
- **`signInWithUsernamePassword({username, password})`** → `signInResult` = `vSignInComplete | vSignInError(
  verifyPasswordUserError | {error: "USER_NOT_FOUND"})` (`:42-50`, `:235-270`): username unknown → `USER_NOT_FOUND`;
  `verifyPassword` failure → its `userError` (`RATE_LIMITED`, a format error, or `INVALID_CREDENTIALS`);
  `completeSignIn({providerAccountId: userId, profile: {}})`. Distinguishing `USER_NOT_FOUND` from
  `INVALID_CREDENTIALS` is deliberate (`:231-233`). A username whose user has no password row throws (§1.6).
- **`changePassword({currentPassword, newPassword, signOutOtherSessions?})`** → `changePasswordResult` =
  `{success: true} | {success: false, userError: NOT_SIGNED_IN | INVALID_CREDENTIALS | RATE_LIMITED {retryAfterMs}
  | setPasswordUserError}` (`:71-82`, `:277-347`): `getAuthUserId` null → `NOT_SIGNED_IN`; new password validated
  first (so an invalid new password costs no rate-limit token); `verifyPassword(current)`: `RATE_LIMITED` passes
  through, every other failure (format errors included) becomes `INVALID_CREDENTIALS`; `setPassword`; if
  `signOutOtherSessions` (default `false`), `revokeOtherSessions()`. A new password equal to the current one is
  accepted.

**`setupAnonymous(core, {component})`** (`methods/anonymous/server.ts:30-83`), `.attachUserCallbacks({createUser,
onSignIn?})` typed `UserCallbacks<"anonymous", Record<string, never>, UsersTable>`, method name `"anonymous"`.
Returns **`signInAnonymously({})`** → `vSignInComplete`: `createAnonymousAccount`, then `completeSignUp({
providerAccountId: <uuid>, profile: {}})`. Every call creates a new account and user; no way to return to one.

### 1.10 `auth.config.ts` and `convexAuthProvider()` (`server/authProvider.ts`)

- `convexAuthProvider({componentName = "auth"} = {})` returns `{type: "customJwt", applicationID: "convex", issuer:
  ${CONVEX_CLOUD_URL}/components/${componentName}, jwks: ${CONVEX_CLOUD_URL}/.well-known/jwks.json, algorithm:
  "ES256"}` (`:25-43`). Without `CONVEX_CLOUD_URL` it throws `convexAuthProvider: the CONVEX_CLOUD_URL environment
  variable is not set` (`:30-34`), at auth-config evaluation.
- **Verification is the ordinary `customJwt` path**: the deployment fetches its own JWKS over HTTP, checks `iss`,
  `aud` against `applicationID`, `exp`/`iat` (STUDY-192 §1.6: "Convex has no shortcut").

### 1.11 The React client (`react/`)

- **`ConvexAuthProvider({client, api, storage?, storageNamespace?, ambientSignIns?, children})`**
  (`react/index.tsx:62-164`):
  - `client: ConvexReactClient`; `api: ConvexAuthApi = {refreshSession, signOut}` (references; any export names).
  - `storage?: TokenStorage` (default `defaultStorage()`: `window.localStorage`, else in-memory with a one-time
    warning); `storageNamespace?: string` (default `client.url`); `ambientSignIns?` (default `[oauth()]`, from
    `methods/oauth/client.ts`, so the core provider always registers the OAuth callback handler, inert unless the URL
    has `convexAuthCode`/`convexAuthError`).
  - Builds a **separate `ConvexHttpClient(client.url, {logger: client.logger})`** for `refreshSession` and `signOut`,
    because the WebSocket client is paused waiting for a token during a refresh (`:118-124`). Sign-in mutations go
    over the WebSocket client (`signInApi`, `:130-133`).
  - Renders `AuthProvider` around `ConvexProviderWithAuth client={client} useAuth={useAuth}` (`:157-163`). Built once
    per `client` (`useMemo([client])`); other props are read once.
- **`useAuthActions()`** (`:177-185`) → `{setSession(bundle), signOut()}`; outside the provider throws
  `useAuthActions must be used within a <ConvexAuthProvider>.`
- **`useAuthToken()`** (`:194-196`) → the access token or `null` (also `null` outside a provider).
- **`useAuth()`** (`react/client.tsx:98-104`, not exported from `./react`) → `{isLoading, isAuthenticated,
  fetchAccessToken}` for `ConvexProviderWithAuth`; outside throws `useAuth must be used within a
  <ConvexAuthProvider>.`
- **`useAuthSignInApi()`** (`react/client.tsx:32-41`), used by method hooks; outside throws `useAuthSignInApi must
  be used within a <ConvexAuthProvider> (or, under Next.js, a <ConvexAuthNextjsProvider>).`
- `AuthProvider` (`react/client.tsx:111-171`) reads the `AuthClient` with `useSyncExternalStore` (server snapshot =
  `{isLoading: true, isAuthenticated: false, token: null}`), calls `authClient.init()` on mount and `dispose()` on
  unmount (StrictMode-safe, `:127-134`).
- **Method hooks:**
  - `useSignInWithUsernamePassword(api)` / `useSignUpWithUsernamePassword(api)` (`methods/username-password/
    react.tsx:145-218`) → `{signIn | signUp: (credentials) => Promise<result>, pending: boolean}`. On `complete`
    they call `setSession(result.tokens)`; a thrown mutation is folded into `{status: "error", userError: {error:
    "OTHER_ERROR", cause}}` (`:249`). `api` is usually `api.auth`; the reference is kept stable by function name
    (`react/functionReference.ts`).
  - `useSignInAnonymously(api)` (`methods/anonymous/react.tsx:64-77`) → `{signIn: () => Promise<void>}`; it does
    not fold errors (a throw rejects).

### 1.12 The browser session manager (`browser/`)

- **Storage keys** (`browser/storage.ts:31-33`): `__convexAuthJWT` (access token) and `__convexAuthRefreshToken`,
  each suffixed `_<namespace>` where the namespace is `storageNamespace` (default the deployment URL) with
  `[^a-zA-Z0-9]` removed (`NamespacedStorage`, `:112-137`). Example: `__convexAuthJWT_httpshappyanimal123convexcloud`.
  An ambient sign-in's keys are `__convexAuthProvider_<id>_<key>_<namespace>` (`:145-152`). Values are the raw
  strings (no JSON).
- **Mutex** (`browser/mutex.ts:24-32`): `navigator.locks.request(name, cb)` when present, else an in-process queue.
  The lock name is the namespaced refresh key, `__convexAuthRefreshToken_<namespace>` (`sessionManager.ts:209`).
- **`AuthClient`** (`browser/sessionManager.ts:174-625`), modes `"spa"` (JS holds the refresh token) and `"ssr"`:
  - `init()` (`:348-385`): attach the `storage` listener; once: run ambient `onInit`s, store an
    `initialAccessToken` if given, read both keys, `isLoading = false`, notify.
  - `fetchAccessToken({forceRefreshToken})` (`:454-477`): not forced → the cached token as is (even expired).
    Forced → under the mutex: if another tab changed the token meanwhile, use it; else `refresh` with
    `retryOnNetworkError` and store the outcome. The SPA refresh reads the refresh token from storage first, then
    memory; none → `noSession` without a call (`:216-227`, `:482-486`).
  - `noSession` clears both keys (`:494-503`); `rotated` stores both (`:550-564`).
  - `setSession(bundle)` (`:410-414`): a full bundle in SPA mode stores both keys; a slim bundle in SPA mode throws
    `[convex-auth] Received a session with no refresh token in SPA mode. …`; a full bundle in SSR mode throws
    `[convex-auth] Received a refresh token in an SSR response. …` (`:521-543`).
  - `signOut()` (`:438-446`): call the `signOut` mutation with the stored refresh token, **swallow any error**, clear
    both keys.
  - **Cross-tab** (`:583-607`): a `storage` event on the same storage area for the JWT key sets the access token
    (notifying), for the refresh key sets the refresh token silently; it never writes back.
  - **State** (`:609-618`): `isAuthenticated = accessToken !== null` (local only), `isLoading` while not initialized
    or a sign-in is pending (`withSignInPending`).
  - `verbose` logs `console.debug("<ISO time> [convex-auth] <message>")` (`:620-624`).
- **Retry** (`browser/retry.ts`): a `TypeError` matching `/network|failed to fetch|load failed/i` is retried after
  500 ms and 2000 ms (+ up to 100 ms jitter), then a last attempt.
- **Refresh scheduling is Convex's client's**, not this package's: `ConvexProviderWithAuth` → `client.setAuth`; the
  `AuthenticationManager` decodes the JWT, schedules a forced fetch `authRefreshTokenLeewaySeconds` (default 10 s)
  before `exp`, and forces one when the server rejects a token. With 60 s tokens the client refreshes about every
  50 s.

### 1.13 How an app wires the core (the examples)

- **`examples/react-password/`** (username + password):
  - `convex/convex.config.ts`: `app.use(auth); app.use(passwordProvider); app.use(username)`, mounts `auth`,
    `authPassword` (its default name, though imported as `passwordProvider`), `authUsername`.
  - `convex/auth.config.ts`: `{providers: [convexAuthProvider()]}`.
  - `convex/auth.ts`: `setupConvexAuth({component: components.auth})`; exports `signOut`, `refreshSession`,
    `isAuthenticated`; `setupUsernamePassword(auth, {component: components.authPassword, usernameComponent:
    components.authUsername}).attachUserCallbacks({createUser: internal.users.createUser})` exports
    `signUpWithUsernamePassword`, `signInWithUsernamePassword`, `changePassword`.
  - `convex/users.ts`: `createUser` internal mutation, args `{provider: {name: v.literal("password"), accountId:
    v.string(), profile: v.object({})}}`, `returns: v.id("users")`, inserts `{}`.
  - `convex/schema.ts`: `users: defineTable({})`.
  - `convex/currentUser.ts`: `loggedInUser` query: `getAuthUserId`, the user row, then
    `components.authUsername.public.getUsername`.
  - `src/main.tsx`: `ConvexAuthProvider client={convex} api={{refreshSession: api.auth.refreshSession, signOut:
    api.auth.signOut}}` around a React Router app; `src/App.tsx`: `AuthLoading` / `Authenticated` /
    `Unauthenticated` guards; `src/routes/logIn.tsx`, `signUp.tsx`: the hooks with a message per `userError`;
    `dashboard.tsx`: user and sign-out; `PasswordSettings.tsx`: `changePassword` with the "sign out other
    sessions" checkbox.
  - `convex/password.test.ts`: 23 tests (sign-up/in, wrong password, unknown user, taken and case-insensitive
    usernames, empty username, too-short password creates no account, change password incl. other sessions,
    rate limit).
- **`examples/react-minimal/`** (anonymous): `app.use(auth); app.use(anonymous)`; `setupAnonymous(auth,
  {component: components.authAnonymous}).attachUserCallbacks({createUser: internal.users.createUser})` exports
  `signInAnonymously`; `src/App.tsx` (heading "Convex Auth — minimal client"): a sign-in button and a sign-out
  button. `convex/auth.test.ts`: 3 tests (envelope, valid JWT, user through the session).

### 1.14 What the core needs from the platform, and bunvex today

| Need | Where upstream | bunvex |
|---|---|---|
| `ctx.auth.signJwt` in a component mutation, `iss = {cloud}/components/{path}` | `component/public.ts:231` | **supported**: `packages/core/src/deployment-jwt.ts` (`deploymentJwtIssuer`, `COMPONENT_ISSUER_PREFIX`), `packages/server/src/functions.ts:503-520` (`MutationAuth`); DV-578 prefixes `bunvex`/`bvx`, DV-579 host signing |
| `/.well-known/jwks.json` | auth config | **supported**: `packages/server/src/health.ts:63-68`, `server.ts:1727` |
| `customJwt` verification of the deployment's own tokens (HTTP self-fetch, `aud`, `iss`) | `server/authProvider.ts` | **supported**: `packages/auth/src/verify.ts:336-395`, `packages/auth/src/config.ts`; loopback allowed (STUDY-192 §3.4) |
| `CONVEX_CLOUD_URL` in `auth.config.ts` | `server/authProvider.ts:29` | **supported as `BUNVEX_CLOUD_URL`** (DV-179; `server.ts:2069`, canonical URLs `canonical-urls.ts`) |
| `componentsGeneric()` at module load | `server/userId.ts:13` | **supported**: `packages/server/src/index.ts:128` |
| `createFunctionHandle` of app internal mutations, called from a component (`ctx.runMutation(handle)`), sub-transaction rollback | `server/setup.ts:287,323`, `component/public.ts:339,384` | **supported**: `packages/server/src/function-handles.ts:185` (STUDY-50, STUDY-155) |
| Component calls from app queries/mutations/actions (`ctx.runQuery(component.public.getSession)`) | everywhere | **supported** (STUDY-152–157) |
| Child component (`component.use(rateLimiter)`) | `components/password/convex.config.ts:16` | **supported**, and `@bunvex/rate-limiter` is built (`components/rate-limiter`, STUDY-197), but in **0.4.2's shape** (a `batchWorker` child, a `pendingUpdates` table); Convex Auth locks 0.3.2 (neither). Same gap as resend's R-2 (DV-581) |
| Seeded `crypto.getRandomValues` and `crypto.randomUUID` in mutations | `component/crypto.ts:3`, `argon2id-wasm/src/index.ts:29`, `components/anonymous/provider.ts:11` | **supported**: `packages/core/src/determinism.ts` (per-execution stream, `:39-43`; `randomUUID` v4 `:422-431`) |
| `crypto.subtle.digest("SHA-256")` in mutations and queries | `lib/crypto.ts:12` | **supported**: `packages/server/src/web-crypto.ts:82-103` (`isolateCrypto`), work counted in `determinism.ts:455-466`; only randomness-needing ops are refused (`:432-453`) |
| `.wasm` import in a component's bundle → `WebAssembly.Module` | `argon2id-wasm/dist/index.js:2` | **supported**: `packages/cli/src/bundle.ts:60-84` (`bunvex-wasm`, STUDY-83), used for component bundles too (`packages/cli/src/components.ts:86,147,228`) and by `@bunvex/testing` (it pushes through the CLI bundle, `packages/testing/src/harness.ts:18,170`). Checked in the scratchpad: `argon2id-wasm`'s `dist/index.js` bundled with bunvex's `PLUGINS` and evaluated as a `vm.SourceTextModule` in a context like `contextGlobals` (`codeGeneration: {strings: false}`): `WebAssembly` is present, the module instantiates, hashes and verifies |
| `WebAssembly` in the function context | — | **present** (a JS intrinsic of every `vm` context; not in `contextGlobals`' list, `code-version.ts:298-330`, and not needed there) |
| `Bun.password` from component code (a native hasher, A-5) | — | **gap**: `Bun` is not among the context's globals (`code-version.ts:298-358`), so component code cannot reach it; a native hasher needs an engine service (STUDY-191 §3.7, §6) |
| `ctx.db.get/patch/delete(table, id)` (explicit table), `normalizeId` | everywhere | **supported** (`packages/server/test/db-table.test.ts`) |
| `FunctionReference_future`, `ReturnValueForOptionalValidator`, `mutationGeneric`, `queryGeneric`, `getFunctionName`, `AuthConfig`/`AuthProvider` types | `lib/types.ts`, `server/setup.ts`, `react/functionReference.ts` | **supported**: `packages/server/src/index.ts:4,92,113,167,170,240` |
| `console.warn` from component mutations | `component/public.ts:657,693` | supported (function logs) |
| Client: `ConvexProviderWithAuth` with `fetchAccessToken({forceRefreshToken})` and scheduled refresh; `ConvexHttpClient(url, {logger})`; `client.url`, `client.logger` | `react/index.tsx:122,159` | **supported**: `packages/react/src/auth.ts:40` (`BunvexProviderWithAuth`), `packages/client/src/authentication-manager.ts:250-269` (leeway 10 s, `base-client.ts:194`), `packages/client/src/http-client.ts:50,72,94`, `packages/react/src/client.ts:162,334` |
| Web Locks, `localStorage`, `storage` events | `browser/` | browser APIs; nothing for the platform. bunvex's tests need a DOM-like environment (upstream runs `edge-runtime`, jsdom per file) |
| Test harness: `registerComponent`, `withIdentity`, `t.jwks()` | `testing/*.ts`, tests | **partly different**: `@bunvex/testing` `registerComponent(name, definitionPath)` (`harness.ts:505`), not `(name, schema, modules)` (Bun has no `import.meta.glob`, STUDY-159); `signJwt` works under it (`packages/testing/test/sign-jwt.test.ts:28`); `t.jwks()` is built (C-6, `packages/testing/test/jwks.test.ts`), and `component/core.test.ts` verifies every token against it |
| System env in components (`CONVEX_SITE_URL` with `httpPrefix`) | OAuth only | supported (`packages/server/src/functions.ts:265-298`); not needed by the core |
| `@bunvex/batch-worker` | not the core at `db15c82e` | built (`components/batch-worker`); needed once the sweep lands |

### 1.15 Measurement: argon2id as WASM vs `Bun.password` (A-5)

Bun 1.4.4, Apple M1 Pro (arm64), 20 runs each, password 28 characters; the WASM is `argon2id-wasm@0.0.0-alpha.2`
from npm, bundled with bunvex's `PLUGINS` and run inside a `vm` context (script in the scratchpad, `bench/`):

| | hash | verify | blocks the JS thread |
|---|---|---|---|
| WASM (in the mutation, as v2) | 23.0 ms | 22.8 ms | **yes**: max event-loop lag 23.6 ms per call |
| `Bun.password.hash` / `verify` (argon2id, `memoryCost: 16384`, `timeCost: 3`) | 24.8 ms | 24.3 ms | no: max lag 0.2 ms (thread pool); 8 concurrent hashes in 50 ms |
| `Bun.password.hashSync` | 25.0 ms | — | yes |

- **Interoperable both ways**: `Bun.password.verify` accepts the WASM's PHC, the WASM accepts Bun's, wrong
  passwords are refused.
- **Bun's PHC differs in salt length**: `$argon2id$v=19$m=16384,t=3,p=1$<43-char salt>$<43-char hash>`, a 32-byte
  salt against the WASM's 16 bytes; `Bun.password` takes no salt argument, so its salt is not from the execution's
  seeded stream. Both are valid PHC strings of the same parameters (STUDY-191 §2: "free … as long as the stored PHC
  string verifies the same").
- Per call the cost is the same; the difference is that the WASM runs on the thread that runs every other function
  of the deployment (bunvex runs functions in one process, or one sandbox child), where Convex gives each function
  its own isolate thread.
- **A second measurement (2026-11-01): `node:crypto` `argon2`**, which Bun implements natively and which takes the salt
  (`nonce`). With the same 16-byte salt and parameters (`memory: 16384`, `passes: 3`, `parallelism: 1`, `tagLength:
  32`), its PHC string is **byte for byte** `argon2id-wasm`'s (`$v=19$m=16384,t=3,p=1$Aw4ZJC86RVBbZnF8h5KdqA$…`
  on both), and the WASM verifies it. The asynchronous `argon2` runs on the thread pool: 8 concurrent hashes in
  48 ms, at most 11.5 ms of event-loop lag. So the salt can stay the mutation's seeded one, as v2's (C-2).

### 1.16 Upstream's tests for the core

Vitest, `environment: "edge-runtime"` (`vitest.config.ts`), a Vite plugin that loads `.wasm` as a
`WebAssembly.Module` (the same stub as the CLI's). Backend tests use `convex-test` 0.0.65 (`convexTest(schema,
modules)`, `registerComponent`, `withIdentity`, `t.jwks()`); convex-test signs `signJwt` tokens with a per-instance
key and runs the component as the root app, so `iss` is the bare origin (`component/core.test.ts:32-41`). The app's
callbacks are a fixture module injected as `testApp.ts` (`component/testApp.fixture.ts`: `createUser` returns
`user<n>`, `onSignIn`, `onSignInThatThrows`). Fake timers for the grace window and the horizon.

| File | Tests | Covers |
|---|---|---|
| `component/core.test.ts` | 63 | signUp, signIn, signUpWithoutSession, refresh, reuse detection (spent, dropped, limit, grace, horizon), signOut, listSessions, revokeSessions, TTL configuration, getUserIdByAccount, getSession; tokens verified with `jose` against `t.jwks()` |
| `components/anonymous/anonymous.test.ts` | 1 | `createAnonymousAccount` returns an id |
| `components/password/passwordProvider.test.ts` | 22 | set+verify, format rules on set and verify, NFC, interop with `hash-wasm` both ways, lenient PHC parsing, rate limit (5 then `RATE_LIMITED`) |
| `components/password/commonPasswords.test.ts` | 11 | the generated list's shape, `isCommonPassword` |
| `components/username/username.test.ts` | 23 | setUsername rules and conflicts, NFC and case, lookups, delete |
| `server/setup.test.ts` | 13 | `ctx.convexAuth.revokeOtherSessions`, `revokeAllSessions`, `isAuthenticated` (with `registerCore`, `sessionIdentity`) |
| `server/userId.test.ts` | 6 | `getAuthUserId` through the session, revoked session → null, custom component |
| `server/authProvider.test.ts` | 3 | `convexAuthProvider` shape, `componentName`, missing env (`vi.stubEnv`) |
| `browser/sessionManager.test.ts` | 35 | `AuthClient` SPA, ambient sign-ins, SSR, async storage; stub `window`, namespace suffix `httpshappyanimal123convexcloud` |
| `browser/storage.test.ts`, `keyedStore.test.ts`, `retry.test.ts` | 3, 8, 4 | default storage fallback and warning; KeyedStore; retry backoff with fake timers |
| `react/client.test.tsx`, `index.test.tsx`, `methods.test.tsx` | 10, 5, 3 | hooks outside a provider, init/dispose, hydration, setSession, signOut, cross-tab; ambient sign-ins of the provider |
| `methods/username-password/react.test.tsx`, `methods/anonymous/react.test.tsx` | 6, 2 | hooks with a stubbed `AuthSignInApi` (`react/testSignInApi.ts`); `OTHER_ERROR` folding, `pending` |
| `examples/react-password/convex/password.test.ts`, `examples/react-minimal/convex/auth.test.ts` | 23, 3 | the methods end to end through the app (§1.13) |

### 1.17 Known issues (`KNOWN_ISSUES.md` at `db15c82e`) for the core

- **No rate limiting on public routes**: `refreshSession`, `signOut`, `signInAnonymously`, sign-up have none (only
  `verifyPassword` is limited, per user).
- **Bounded reuse horizon**: spent/dropped rows are kept 1 h and pruned only by their own session's next redemption;
  an abandoned session keeps its rows (about 60 at the defaults) and its session row until signed out or its
  expired token is presented. Both `pruneRetiredTokens` and `deleteSession` read the whole set, so a session
  refreshed pathologically often could become unrefreshable and un-signoutable. Fix direction: a batch-worker sweep
  (the unmerged branch).
- The OAuth entries (cleanup, system env vars, one pending flow, custom URL schemes) are not the core, but the core
  provider registers `oauth()` by default (§1.11).

## 2. What an app can observe

### 2.1 Names and shapes

- Component names `auth`, `authUsername`, `authPassword` (child `rateLimiter`), `authAnonymous`; their tables,
  fields and indexes (§1.2, §1.6–§1.8); function paths `public.*` (`auth`, `authUsername`, `authPassword`) and
  `provider.createAnonymousAccount`, with the args and return validators of §1.2, §1.6–§1.8.
- No env on any core component; no HTTP routes; no crons; no `batchWorker` under `auth` at `db15c82e`.
- The rate limiter's tables under `authPassword/rateLimiter` (0.3.2's: one table, no child).

### 2.2 The app-side API

- `setupConvexAuth` options and defaults (`usersTable = "users"`, 60 s, 30 days) and the result (`signOut`,
  `refreshSession`, `isAuthenticated`, plus `usersTable`, `component`, `bindProvider`).
- `setupUsernamePassword(core, {component, usernameComponent})` and `setupAnonymous(core, {component})`;
  `.attachUserCallbacks({createUser, onSignIn?})`; the returned names `signUpWithUsernamePassword`,
  `signInWithUsernamePassword`, `changePassword`, `signInAnonymously`, with their args and result unions (§1.9).
- `createUser` args `{provider: {name: "password" | "anonymous", accountId, profile: {}}}`, returning an id of
  `usersTable`; `onSignIn` args `{provider, userId}`, returning `null`; a throwing `onSignIn` rolls the sign-in back
  (a first sign-in's user included).
- `getAuthUserId(ctx, component?)` with its `UsersTable` type parameter; `convexAuthProvider({componentName?})`.
- `DEFAULT_MIN_PASSWORD_LENGTH` = 10.
- The duplicate-method error at module load.

### 2.3 Tokens and sessions

- Claims `{sub: <session id>, aud: "convex", iss: "<cloud>/components/auth", iat, exp}`, ES256, the JWKS route; 60 s
  default, 3600 s maximum, must be shorter than the refresh TTL.
- `getUserIdentity()`: `subject` = session id (not the user id); `tokenIdentifier` = `<iss>|<session id>`, new at
  each sign-in. An app that keys users by `subject` or `tokenIdentifier` sees a new value per session.
- Revocation: `getAuthUserId` and `isAuthenticated` turn null/false at once and reactively when the session row is
  deleted; `getUserIdentity()` keeps returning the identity until the token expires.
- Refresh outcomes (§1.3): unknown → `noSession` without side effects; spent/dropped → session deleted; expired →
  session deleted; issued → redeemed (siblings dropped, previous redeemed spent, retired rows past 1 h pruned);
  redeemed → accepted again unless 3 issued tokens are pending and the oldest is more than 5 s old. Each refresh
  adds one `refreshTokens` row and never writes `sessions`.
- `signOut` accepts a token in any state, is idempotent, returns `null` for an unknown token.
- `listSessions` newest first, expired included, fields `{sessionId, creationTime, lastRefreshedAt, expiresAt}`;
  `revokeSessions` returns the ids it deleted.
- `revokeOtherSessions()` returns the number of non-expired sessions revoked (0 signed out or on a revoked session).
- No cap on sessions per user, no background deletion of expired sessions at `db15c82e`.
- The documents after a flow, as a differential test compares them: a sign-up writes one `accounts` row, one
  `sessions` row, one `refreshTokens` row (`issued`), and for password one `usernames` and one `passwords` row and
  rate-limiter state only on verify.

### 2.4 Method behaviour

- Error codes and their order: sign-up `USERNAME_HAS_SURROUNDING_WHITESPACE` / `USERNAME_HAS_INVALID_CHARACTERS` /
  `USERNAME_TOO_SHORT {minimumLength: 1}` → `PASSWORD_TOO_SHORT {minimumLength: 10}` / `PASSWORD_TOO_LONG
  {maximumLength: 100}` / `PASSWORD_HAS_SURROUNDING_WHITESPACE` / `PASSWORD_TOO_COMMON` → `USERNAME_TAKEN`; sign-in
  `USER_NOT_FOUND` → `RATE_LIMITED {retryAfterMs}` → format errors → `INVALID_CREDENTIALS`; `changePassword`
  `NOT_SIGNED_IN` → new-password errors → `RATE_LIMITED` → `INVALID_CREDENTIALS` (current-password format errors
  folded into it).
- All of them are return values (`{status: "error", userError}` or `{success: false, userError}`), not throws: no
  `ConvexError` in the core. Throws are bugs or misconfiguration (plain `Error`, redacted to the client on a
  production deployment like any other).
- Rate limit: per user id, 5 attempts then 1 per minute, also counting format-invalid attempts at sign-in (the limit
  is taken before the format check), not counting invalid new passwords in `changePassword`.
- Usernames: case-insensitive and NFC-insensitive lookups; the stored and shown spelling is the user's; the same
  user re-setting a case variant keeps the new spelling.
- Passwords: NFC before hashing; lengths in code points of the raw input; common-password check case-insensitive.
- The `accountId` the callbacks see for a password account is `""` at sign-up (both `createUser` and the first
  `onSignIn`) and the user id afterwards; for anonymous, the UUID.
- Anonymous: every sign-in creates a new user and calls `createUser`; the UUID is the account key.

### 2.5 The stored password hash

- `passwordHashPHC` in PHC form, argon2id v19, `m=16384,t=3,p=1`, 16-byte salt, 32-byte hash. A hash from a Convex
  export must verify in bunvex, and verification follows the stored parameters (argon2i/argon2d accepted). How the
  hash is computed is not observable, apart from timing and, for a different hasher, the salt length (§1.15).

### 2.6 The client

- `ConvexAuthProvider` props and defaults (`storageNamespace` = the deployment URL, `localStorage`, `[oauth()]`);
  `useAuthActions` (`setSession`, `signOut`), `useAuthToken`; the method hooks' results, `OTHER_ERROR` folding and
  `pending`; the hook error messages outside a provider.
- Storage: keys `__convexAuthJWT_<ns>` and `__convexAuthRefreshToken_<ns>` with raw token values, `ns` = the
  namespace stripped to `[A-Za-z0-9]`; the Web Locks name `__convexAuthRefreshToken_<ns>`; tabs follow each other
  through `storage` events; a reload keeps the session. DV-577 already moves these to bunvex's words.
- Refresh and sign-out go over HTTP (`POST /api/mutation` of the app's `refreshSession`/`signOut`), sign-ins over the
  WebSocket; the Convex client refreshes 10 s before `exp`; a failed server sign-out still clears local state.
- `isAuthenticated` of `useConvexAuth()` follows the server's acceptance of the token (Convex's client); the
  `AuthClient`'s own flag only means "a token is stored".

### 2.7 Quirks an oracle would show

1. `sub`/`tokenIdentifier` are per session (§2.3).
2. `Unexpected error when setting the password: null` would be the message of the unreachable sign-up branch
   (`methods/username-password/server.ts:218-221`).
3. A username whose user has no password row makes `signInWithUsernamePassword` throw `No password stored for
   userId <id>.` (the hook reports `OTHER_ERROR`), after consuming no rate-limit token (rolled back with the throw).
4. TTL misconfiguration is not caught at setup: every sign-in and refresh throws instead.
5. `listSessions` reads no clock and lists expired sessions; `revokeOtherSessions` counts with the mutation's frozen
   `Date.now()`.
6. `refresh` of an expired but known token deletes the session; an unknown token deletes nothing.
7. `useSignInAnonymously().signIn` rejects on a server error where the password hooks resolve `OTHER_ERROR`.
8. `isCommonPassword` lowercases after NFC, `normalizeUsername` lowercases before NFC (deliberately different
   orders, `commonPasswords.ts:17`, `username/validation.ts:159-170`).
9. Unicode results depend on the engine's ICU and Unicode tables (`toLowerCase`, `normalize`, `\s`, `\p{M}`): V8 in
   Convex, JavaScriptCore in bunvex. A `usernameNormalized` written by Convex for a rare character could differ from
   what bunvex computes for the same input (unconfirmed; to test with a corpus).

### 2.8 "convex" in shipped names and strings (rule 5)

| Where | What | Status |
|---|---|---|
| `component/public.ts:26` | `aud: "convex"` | DV-576 → `"bunvex"` |
| `server/authProvider.ts:38` | `applicationID: "convex"` | DV-576 → `"bunvex"` |
| `server/authProvider.ts:25`, `server/index.ts:13` | `convexAuthProvider` | STUDY-191 §3.2 → `bunvexAuthProvider` |
| `server/authProvider.ts:29,32` | `process.env.CONVEX_CLOUD_URL`; message `convexAuthProvider: the CONVEX_CLOUD_URL environment variable is not set` | DV-179 → `BUNVEX_CLOUD_URL`, message in bunvex's words |
| `server/setup.ts:185`, `server/index.ts:14` | `setupConvexAuth` | §3.2 → `setupAuth` |
| `server/setup.ts:403`, `lib/types.ts:407-408`, every method (`methods/*/server.ts`) | `ctx.convexAuth`, type `ConvexAuthCtx` | **not in STUDY-191's table**: needs a name (§2.9) |
| `lib/types.ts:191`, `index.ts:10`, `react/index.tsx:37` | `ConvexAuthApi` | §3.2 → `AuthApi` |
| `react/index.tsx:62` | `ConvexAuthProvider` | §3.2 → `BunvexAuthProvider` |
| `react/client.tsx:49`, `react/index.tsx:38` | `ConvexAuthActionsContextType` | §3.2 → `AuthActionsContextType` |
| `react/client.tsx:21,63,76,82` | `ConvexAuthSignInApiContext`, `ConvexAuthActionsContext`, `ConvexAuthTokenContext`, `ConvexAuthInternalContext` (module exports, not entry-point exports) | rename (internal identifiers) |
| `browser/ambientSignInClient.ts:94,119`, `browser/sessionManager.ts:64` | `ConvexMutationApi`, config field `convex` | rename (internal API) |
| `react/index.tsx:181`, `react/client.tsx:36-37,101`, `react/methods.ts:42` | messages naming `<ConvexAuthProvider>`, `<ConvexAuthNextjsProvider>` | follow the provider names |
| `browser/sessionManager.ts:319` | message `… each auth method registers once per ConvexAuthProvider` | follows the provider name |
| `browser/storage.ts:31,33` | `__convexAuthJWT`, `__convexAuthRefreshToken` (also the Web Locks name) | DV-577, exact names in the core's PR |
| `browser/storage.ts:146` | prefix `__convexAuthProvider_` | DV-577 |
| `browser/storage.ts:74`, `browser/sessionManager.ts:365,526,537,622` | log prefix `[convex-auth]` | rename |
| `lib/oauthParams.ts:21,26` | URL params `convexAuthCode`, `convexAuthError` (read by the default `oauth()` of the core provider) | DV-577's spirit; decide with the core if `oauth()` ships with it |
| `packages/core/package.json` | `@convex-dev/auth`, `bin` name, export condition `convex-auth-internal-types`, `./convex.config(.js)` entries | DV-493 (`@bunvex/auth`), DV-494 (`bunvex.config.js`); the condition needs a name or goes |
| `testing/*.ts` | `TestConvex` type, `convex-test` | becomes `@bunvex/testing` |
| `cli/program.ts` | the scaffold (`convexAuthProvider`, `setupConvexAuth`, `npx convex dev`, docs URL `auth-v2.previews.convex.dev`) | if the CLI is ported |
| `examples/react-minimal/src/App.tsx` | heading "Convex Auth — minimal client" | bunvex's example's words |

No "convex" in component names, table or field names, function paths, error codes, or the core's error messages.

## 3. How bunvex does it

### 3.1 The package

`@bunvex/auth`, in `components/auth/`, as STUDY-191 §3.1 says and as the other components are built (STUDY-183's
model, STUDY-199 and STUDY-200 the latest):
- the components `auth`, `authAnonymous`, `authUsername` and `authPassword`, each with its `bunvex.config.ts`,
  schema, functions and `_generated/`, at v2's export paths (`./bunvex.config.js`,
  `./components/<name>/bunvex.config.js`, DV-494);
- the app-side code: `./server` (`setupAuth`, `getAuthUserId`, `bunvexAuthProvider`) and
  `./methods/{username-password,anonymous}/server`;
- the clients: `./react`, `./browser` and `./methods/{username-password,anonymous}/react`;
- the test helpers `./test` and `./components/<name>/test` (C-6).

Every name, path, table, field, index, validator, default, constant, message, error code and log line is v2's at
the pin (C-1), with the renames of rule 5 (STUDY-191 §3.2, C-4) and DV-576/DV-577.

### 3.2 The rename first (A-2, confirmed 2026-11-01)

`packages/auth` (the token verifier, internal to `packages/server`) becomes `packages/identity`, `@bunvex/identity`,
in its own PR before the core. What it touches:
- `packages/server`'s seven imports, `scripts/check-deps.ts`'s keys, `ARCHITECTURE.md`'s tree and the README's
  layout row;
- `scripts/npm-packages.ts` (`FIXED`, in dependency order before `persistence` and `server`) and
  `scripts/smoke-npm.sh`, which name it.

`@bunvex/auth` 0.1.0-alpha.2 is already on npm as the verifier. The auth components publish as `@bunvex/auth` at a
higher version, so the name is reused on purpose; deprecating the old version on npm is the owner's call
(`npm deprecate @bunvex/auth@0.1.0-alpha.2 "renamed to @bunvex/identity"`).

### 3.3 The platform is ready

Everything §1.14 lists is in bunvex, with the file that provides it, except two things:
- **`t.jwks()` in `@bunvex/testing`.** convex-test has it since 0.0.65 (`ed7a5ce`, "Support ctx.auth.signJwt in
  mutations"), and upstream's `core.test.ts` verifies every token with it. It is parity with convex-test (STUDY-159), not an addition: built in its own small PR (C-6); built (`packages/testing/test/jwks.test.ts`).
- **The native hasher** (C-2, AD-49): an internal runtime operation, `argon2id(password, salt)` and its verify, that
  `authPassword`'s functions call and the server answers with Bun's `node:crypto` argon2 on its thread pool (in the
  host under the function sandbox, as `signJwt`'s signing is, DV-579). The salt is drawn in the mutation from its
  seeded stream, as v2 draws it, so the PHC string is v2's byte for byte (checked: the same salt gives the same
  string as `argon2id-wasm`). The runtime answers it only to `authPassword`'s functions; the context stays closed
  otherwise (no `Bun`, no `node:` modules). `argon2id-wasm` is not a dependency.
  Built (PR 3): `authPassword` imports `hashPassword(password, salt)` and `verifyPassword(password, hash)` from
  `@bunvex/server/password`, a module the runtime links as it links `@bunvex/server` (`code-version.ts`), never
  bundled. They answer where the running function's scope carries a hasher (`function-handles.ts`), which
  `Functions.invoke` gives only to a mutation of a component whose definition is named `authPassword` (the name
  from its `_component_definitions` row); anyone else gets "hashPassword can only be called from a mutation of the
  authPassword component". Under the process sandbox a mutation's child forwards the call as a `password`
  operation, and the host answers it in the mutation's scope, so the check is the host's. Each hash is work in
  flight for the mutation's runner (`Tx.track`) and its time, on the thread pool, is not the function's
  (`pausingUserTime`), as a store call's. Verification follows the stored string (argon2id, argon2i, argon2d, its
  `m`, `t`, `p` and tag length; no version is 0x13), as the Rust crate's; a version other than 0x13 is refused
  (Bun's argon2 computes only 0x13, and v2 writes only 0x13). A stored string's costs are bounded (owner, 2026-11-02): over 64 MiB
  (`m` > 65536) or 10 passes, verification throws ("memory cost over 65536 KiB", "time cost over 10") before any
  work. v2's WASM runs in the function's isolate, whose memory is bounded (`ISOLATE_MAX_USER_HEAP_SIZE`,
  `ISOLATE_MAX_ARRAY_BUFFER_TOTAL_SIZE`, 64 MiB each, `crates/common/src/knobs.rs:1165,1174`), so an outsized `m` fails
  that one function; here it would be allocated in the deployment's process. v2 writes `m=16384,t=3`. The name identifies the component, it does not
  authenticate it: any pushed component may call itself `authPassword`, which only opens a hasher to it.

### 3.4 Tests

- **Upstream's tests, ported** (§1.16) to `@bunvex/testing`, with its virtual clock for vitest's fake timers:
  `core.test.ts` (tokens checked against `t.jwks()`), the password, username and anonymous components, the server
  helpers, the browser session manager and the React clients (happy-dom, in their own process as STUDY-197's hook
  tests), and the examples' tests.
- **More:** every message and log line of §1; the refresh rotation's states one by one; revocation reaching a live
  subscription at once (`getAuthUserId` turning null); a hash from v2's WASM verifying in bunvex and the reverse
  (C-2); the username rules on a Unicode corpus (C-7).
- **A differential test** against `@convex-dev/auth` at the pin on Convex's binary (a precompiled binary with
  `signJwt` exists, STUDY-192): each table's documents after sign-up, sign-in, refresh, revocation and sign-out
  (ids, times and hashes normalized); the access token's claims (not the signature, the `iss` host or the times);
  the error messages; a PHC string written on Convex verifying on bunvex.
- **Sabotage checks:** the reuse detection (a spent token presented again revokes the session), the grace window,
  the unredeemed-token limit, the password rate limit, the session check in `getAuthUserId`.

### 3.5 The build, in PRs

1. The rename (§3.2).
2. `t.jwks()` in `@bunvex/testing` (C-6).
3. The native hasher's runtime operation (AD-49), in the function context and the process sandbox, with tests
   against `argon2id-wasm`'s strings (a test dependency only) and the check that only `authPassword` may call it
   (built: `packages/server/test/password.test.ts`, `packages/testing/test/password.test.ts`).
4. The server side: the four components, `setupAuth`, the two methods' server code, `bunvexAuthProvider`,
   `getAuthUserId`, with the ported tests and the differential test. In PRs (owner, 2026-11-02):
   - 4a. the `auth` component, `@bunvex/auth/test` and the ported `core.test.ts` (built: `components/auth`; the
     suite runs the component's functions as an app's, as upstream's; its callbacks' spies are a table, the fake
     timers the deployment's virtual clock);
   - 4b. `authPassword`, `authUsername`, `authAnonymous` (built: `components/auth/src/components/`, their suites
     ported; `authPassword`'s is mounted as a component named `authPassword`, which the hasher answers, with test
     functions for its rows; the common-password list regenerated by bunvex's own script from SecLists, identical to
     v2's; a lone surrogate is refused at the wire, as on Convex's backend, where convex-test passes it);
   - 4c. `setupAuth`, the methods' server code, `getAuthUserId`, `bunvexAuthProvider` (built: `components/auth/src/server/`, `src/methods/*/server.ts`, the rest of `lib/types.ts`; `ctx.bunvexAuth`, `BunvexAuthCtx`, `AuthApi` (C-4); the `setup`, `userId` and `authProvider` suites ported, the methods checked end to end in an app with the four components, `methods.test.ts`);
   - 4d. the differential test (built: `packages/differential/test/auth.test.ts`, `auth-app/`, the pin built from the
     clone by `harness/convex-auth.ts`, npm's 2.0.0-beta.0 predating it): every answer of a scenario (sign-up, sign-in,
     the refusals in order, the rate limit, refresh with a lost answer and a dropped token's reuse, `changePassword`,
     anonymous sign-in, sign-out, the caller's user and `isAuthenticated` with real access tokens verified through
     `auth.config.ts`), every row of the components' and the app's tables, the access token's header and claims, and a
     hash Convex's side stored verified by bunvex's verifier. Component tables are read with the dashboard's
     `paginatedTableDocuments`: bunvex's `data --component` is still refused (DV-224, stale since components).
5. The clients: `./react`, `./browser`, the methods' React hooks (and the inert `oauth()` ambient sign-in, C-5). In two PRs:
   - 5a. `./browser` (the token storage, the refresh lock, the retry, `AuthClient` in both models, the ambient sign-ins'
     contract) and the OAuth client `oauth()`, inert until a callback carries its parameters (built: upstream's
     `storage`, `keyedStore`, `retry`, `sessionManager` and OAuth client suites ported to `components/auth/test-react`,
     happy-dom preloaded, plus a sign-out the server fails still signing out locally (§2.6), and both refusals of a
     session of the wrong shape). One difference no browser shows: a `navigator.locks` that is `null` (happy-dom) is
     taken as absent (the in-process queue), where v2's would call `null.request`;
   - 5b. `./react` and the methods' React hooks (built: `BunvexAuthProvider`, `useAuthActions`, `useAuthToken`, `useAuth` for
     `BunvexProviderWithAuth`, the methods' hooks; upstream's `react/client`, `index`, `methods` and the methods' hook
     suites ported, the default `oauth()` checked through its published value since `useOauth` comes with OAuth, and a
     failed anonymous sign-in rejecting; a component may now import `@bunvex/client` (its HTTP client, as v2 uses
     `convex/browser`), `scripts/check-deps.ts`).
6. The examples: username + password, and anonymous.
7. Later: the `init` CLI (C-8).

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| C-3 | `authPassword`'s child `rateLimiter` is bunvex's rate limiter, 0.4.2's shape (its own `batchWorker` child and `pendingUpdates` table), where Convex Auth mounts 0.3.2: DV-581 extended | one rate limiter in bunvex; the password limit is one token-bucket `limit` call, the same in both versions | DV-581, extended (owner, 2026-11-01) |
| C-4 | The names of §2.8 not yet decided, in bunvex's words (storage keys and the OAuth URL parameters under DV-577; the rest under rule 5) | rule 5 | DV-577, extended, and rule 5 (owner, 2026-11-01) |

## 4b. Additions

| # | Addition | Why | Decision |
|---|---|---|---|
| C-2 | Password hashing off the JS thread: an internal runtime operation for `authPassword`, answered with Bun's native argon2, the PHC strings byte for byte v2's | the same cost per hash, but v2's WASM stops the deployment's one JS thread for each (§1.15); measured: 8 native hashes in 48 ms with at most 11 ms of event-loop lag | AD-49 (owner, 2026-11-01) |

## 5. Tests

As §3.4, once built.

## 6. Not verified yet

- **Unicode tables** (§2.7): JavaScriptCore and V8 may differ on `normalize("NFC")` and `toLowerCase()` for recent
  Unicode versions. The username tests run a corpus and record any difference (C-7).
- **The rest of the session stack** (§1.0): the 100-session cap, the expired-session sweep (a `batchWorker` child
  under `auth`, a `ttlConfig` table, `refreshTokens.expiresAt` dropped) and the `SessionWatcher`. They come by the
  daily triage when they land upstream; a store of the pinned beta is not migrated (STUDY-191 §3.5).

## 7. Questions for the owner

All decided by the owner on 2026-11-01 as recommended, except C-2: the native hasher (AD-49), chosen after the
comparison of §1.15 and a second measurement (Bun's `node:crypto` argon2 takes the salt, so its strings equal the
WASM's).

| # | Question | Recommendation |
|---|---|---|
| C-1 | **The pin.** Move it from `84ccfa8d` to `db15c82e` (the session id as `sub`, `getSession`, revocation, `isAuthenticated` on the live session, `convexAuthProvider()`), and build now; or wait for the rest of the session stack, which still changes the schema (the sweep) and the client API (`SessionWatcher`) | **Move it and build now.** The part that changes what an app observes most (sessions checked live) has landed; what remains comes by triage, as STUDY-191 §3.5 planned, and v2 promises no compatibility between betas anyway |
| C-2 | **The hasher (A-5).** Measured (§1.15): the same cost per call (23 ms as WASM, 25 ms native), but the WASM blocks the deployment's single JS thread for each hash and verify, where `Bun.password` runs off-thread. Component code cannot reach `Bun` | **v2's WASM now** (the npm `argon2id-wasm`, Apache-2.0, as a dependency, the same PHC strings, the salt from the mutation's seeded stream): parity, works today. A native hasher off the JS thread comes later as its own addition (STUDY-191 §3.7), with a load measurement |
| C-3 | **The rate limiter under `authPassword`** (§4): bunvex's, as DV-581 decided for resend | **Yes**, extending DV-581 |
| C-4 | **The names still open** (§2.8): `ctx.convexAuth` → `ctx.bunvexAuth` (`ctx.auth` is taken), `ConvexAuthCtx` → `BunvexAuthCtx`, `ConvexMutationApi` → `BunvexMutationApi`, the log prefix `[bunvex-auth]`, the export condition `bunvex-auth-internal-types`, the storage keys `__bunvexAuthJWT_<ns>`, `__bunvexAuthRefreshToken_<ns>` (also the Web Locks name) and `__bunvexAuthProvider_`, the URL parameters `bunvexAuthCode` and `bunvexAuthError` | **Yes, Convex's names with "convex" made "bunvex"**, as the clients' names were (DV-243). The storage keys and URL parameters extend DV-577 |
| C-5 | **`oauth()` in the core's provider.** v2's provider registers the OAuth ambient sign-in by default, which brings its small client piece and URL parameters into this step, before OAuth (step 5) | **Ship it with the core, inert until OAuth exists**, as v2 does: no temporary divergence in the provider's defaults |
| C-6 | **The test helpers and `t.jwks()`.** v2's helpers take `(t, name)` and register modules with `import.meta.glob`; bunvex's components register by their definition's path (STUDY-159). The ported `core.test.ts` needs convex-test's `t.jwks()` | **`register(t, name)` as bunvex's other components' helpers**, and **`t.jwks()` in `@bunvex/testing`** (parity with convex-test), in its own PR |
| C-7 | **Unicode differences** between JavaScriptCore and V8 in username normalization (unconfirmed) | **Test a corpus** and record any difference found as a DV then; nothing to decide before |
| C-8 | **The `init` CLI** (v2's `bin`, which scaffolds the files) | **Later**, its own PR after the examples; the examples and docs show the wiring meanwhile |

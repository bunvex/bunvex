# STUDY-208 — Built-in auth, Convex Auth 2.0.0
<!-- index: built-in auth moves from Convex Auth v2 `db15c82e` to the 2.0.0 release (`f73ec439`): sessions that end at an inactivity timeout or a max lifetime, 100 per user, their tokens erased in scheduled batches; accounts out of the core, `sessions.component`, `createdUserIds`; the core mounted only as `auth`; `_internal_dangerous_` names; `method` in the callbacks; the password floor at 8 and `minimumLength`; usernames capped at 100; the client signing out when its session is revoked; the init command and the anonymous method gone from the package | decided (owner, 2026-11-12): follow v2.0.0 on the three points: `aud` "bunvex-auth" (DV-576 rewritten), no init command (DV-583 resolved), anonymous hidden -->

- **Status:** decided (owner, 2026-11-12): follow v2.0.0 on all three questions of §7:
  - D-1: the audience becomes `"bunvex-auth"`, which rewrites DV-576;
  - D-2: the `init` command is removed, which resolves DV-583;
  - D-3: the anonymous method is hidden from the package.

  The rest matches v2.0.0 and needs no decision. The new messages that name Convex's file or variable follow the
  renames already decided (C-4, DV-179; §4). To be built (§3.6).
- **Scope:** everything Convex Auth changed between STUDY-201's pin and its first stable release, for what bunvex has
  built:
  - the core (`auth`);
  - `authPassword`, `authUsername` and `authAnonymous`;
  - the username + password and anonymous methods;
  - the React client and `./browser`;
  - `./ssr` and `./ssr/nextjs` (STUDY-202);
  - the package's entries, and the examples.

  Email, OAuth and passkeys (STUDY-191 §3.4 steps 4–6) are not built. Their changes in the range are noted only
  where the shipped inert `oauth()` client sees them (§1.9), and are read again when those steps are studied.
- **Convex source read:** convex/convex-auth `main` at **`f73ec439`**, tag `v2.0.0` (2026-11-12). The `reboot`
  branch was merged into `main` (`8189c141`), and releases are published from `main` since `e749dc08`. Earlier pins:
  STUDY-201 and STUDY-202 read `db15c82e` (2026-10-28).
  - `git log db15c82e..f73ec439` has 88 commits. About 10 of them are the v1 line merged into `main`
    (0.0.95–0.0.98, under the repository's root `src/`), and many touch only docs, the docs site or CI. §1.0 lists
    those that change what bunvex built.
  - The 12 commits after the tag on 2026-11-12 are docs redirects, removed TODOs, the passkey example and a vitest
    bump; none changes the package's code.
  - Paths are relative to `packages/core/src/` unless they say otherwise.
- **Dependencies inspected:** `password-hash-wasm` 0.0.0 (formerly `argon2id-wasm`), from the clone's
  `packages/password-hash-wasm`; `cookie` stays 1.1.1, which keeps STUDY-202's reference.
- **bunvex source:** `main` at `0d0af3b0` (2026-11-05).
- **Related:**
  - [STUDY-191](STUDY-191-convex-auth-v2.md): the overview, and A-3, the audience;
  - [STUDY-201](STUDY-201-auth-core.md): the core, its decisions C-1 to C-9, and AD-49, the native hasher;
  - [STUDY-202](STUDY-202-auth-ssr.md): SSR and Next.js;
  - [STUDY-192](STUDY-192-sign-jwt.md): `signJwt`;
  - [STUDY-157](STUDY-157-component-services.md): scheduling from a component.

## 1. How Convex does it

### 1.0 What changed, by commit

Only the commits that change something bunvex has built:

| Commit | Date | Title | For bunvex |
|---|---|---|---|
| `0c99276e` | 11-02 | Enforce a 100 session max per-user (#783) | §1.4 |
| `07911f86` | 11-02 | Compute refresh token expiry using the time it was issued and the current TTL (#781) | §1.3: `refreshTokens.expiresAt` dropped |
| `6c0ebf3f` | 11-03 | Use "convex-auth" as the JWT audience (#800) | §1.8 |
| `a48a91a5` | 11-03 | Sign clients out reactively when their session is revoked (#761) | §1.10 |
| `8009a86b` | 11-04 | Move the session and TTL helpers out of public.ts (#784) | Reorganization: `component/sessions.ts`, `component/expiry.ts`, `lib/ttl.ts` |
| `1c9dc06f` | 11-04 | Resolve the TTL config in setupConvexAuth (#801) | §1.2 |
| `a7bdf81d` | 11-04 | Split the refresh-token TTL into a refresh timeout and a max lifetime (#798) | §1.2, §1.3 |
| `5e9501ee`, `30169ef0`, `ea359653`, `855d166c` | 11-05 | The common-password list, the password floor at 8, `minimumLength` | §1.11 |
| `6c453fb1`, `13bc947d`, `71579475`, `0c994d4c`, `cbf5ab8a`, `3b5313c6` | 11-05, 11-09 | `argon2id-wasm` → `password-hash-wasm`, scrypt verification | §1.11 (nothing an app observes yet) |
| `437831bd` | 11-06 | Erase a deleted session's refresh tokens in scheduled batches (#799) | §1.5 |
| `aa63c0e7` | 11-06 | Wrap the Next.js server provider in Suspense for Cache Components (#713) | §1.13 |
| `cfbdb17d`, `21f00fb5`, `bff2ce56` | 11-09 | Stop using, document and export the anonymous method | §1.14 |
| `d3aa3b56` | 11-09 | Cap username length at 100 code points (#714) | §1.12 |
| `09a992d7` | 11-09 | Document RefreshResult and export it (#765) | §1.13 |
| `98efefd0` | 11-09 | Remove the npx @convex-dev/auth CLI (#821) | §1.15 |
| `a0fff71c` | 11-09 | Rename the remaining public names that say provider (#749) | §1.7 (test helpers; the rest is email and OAuth) |
| `abecbeb3` | 11-09 | Use NOT_LOGGED_IN for the not-signed-in error in all methods (#838) | §1.11 |
| `fac21c92` | 11-10 | Hide the API for custom OAuth providers from the package (#836) | §1.14 (nothing built) |
| `3ad61bd9` | 11-11 | Update OAuth client code to use OTHER_ERROR for thrown ConvexErrors (#871) | §1.9 |
| `d8df6b2a`, `c9b399d3`, `bca5f6e0` | 11-11 | Accounts into the components; no account id in the callbacks | §1.6 |
| `00595c0d` | 11-11 | Keep track the IDs of the users that the core created (#869) | §1.6 |
| `91d16264`, `a5948296` | 11-11 | `sessions.component`; `authenticatedBy` | §1.6 |
| `ccf8a392` | 11-11 | Rename the "provider" callback argument to "method" (#889) | §1.6, §1.7 |
| `b99e842e` | 11-11 | Require the core to be mounted as auth (#842) | §1.8 |
| `fd06a184` | 11-11 | Prefix the component functions that need a redesign with `_internal_dangerous_` (#881) | §1.7 |
| `f73ec439` | 11-12 | 2.0.0 | the package's version and `homepage`; the CHANGELOG |

**Commits that change nothing bunvex has built:**
- `613cbb2c` touches TOTP only.
- `c818b9fa` prefixes functions of the email, passkey and OAuth components only. It leaves anonymous's
  `createAnonymousAccount` and the username component's functions unprefixed.
- `2b5d672a`, `040d8e36`, `cfe2b0db`, `505e93d4`, `07986837`, `9d1cf253` touch email, OAuth and passkeys.

**The v1 line.** The security fix `5a14a6df` (GHSA-hmvv-g278-4x95, a low-entropy verification code accepted without
an identifier) is in v1's code (`src/server/implementation/`), not in v2. v2's email component is checked against
it when email is studied (§6).

**The upgrade steps.** The CHANGELOG's `## 2.0.0` (`CHANGELOG.md:3-61`) lists them: clear `auth/sessions` and
`auth/refreshTokens`, delete `auth/accounts`, and so on. bunvex keeps no path for its own older stores (CLAUDE.md),
and no published `@bunvex/auth` has these tables, so the build changes the schema in place.

### 1.1 The core's schema (`component/schema.ts:4-71`)

```
createdUserIds: { userId: v.string() }                         .index("by_userId", ["userId"])
sessions:       { userId: v.string(), component: v.string() }  .index("by_user", ["userId"])
refreshTokens:  { hash: v.string(), sessionId: v.id("sessions"),
                  state: "issued" | "redeemed" | "spent" | "dropped", retiredAt: v.optional(v.number()) }
                  .index("by_hash", ["hash"]) .index("by_session_state", ["sessionId", "state", "retiredAt"])
```

- **`accounts` is gone** (`c9b399d3`). Each sign-in method's component keeps its own accounts: OAuth's, and
  anonymous's (§1.14). Username + password has none, because `authUsername` maps the username to the user.
- **`sessions.accountId` became `sessions.component`**, the path of the component that authenticated the user (for
  example `"authPassword"`; `91d16264`, `a5948296`).
- **`refreshTokens.expiresAt` is gone** (`07911f86`). Expiry is derived (§1.3).
- **`createdUserIds` is new** (`00595c0d`; §1.6).

### 1.2 Token and session lifetimes (`lib/ttl.ts`, `server/setup.ts`)

**The constants and the config:**
- `DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 60` and `DEFAULT_SESSION_MAX_LIFETIME_SECONDS = 2592000` (30 days) are
  exported.
- `MAX_ACCESS_TOKEN_TTL_SECONDS = 3600` is not (`:6-11`).
- `TtlConfig` is `{accessTokenTtlSeconds, refreshInactivityTimeoutSeconds, sessionMaxLifetimeSeconds}`.
- `vTtlConfigFields` holds the three as **required** `v.number()` arguments of the component (`:23-34`).

**`resolveTtlConfig(args)`** (`:45-59`) fills in the defaults:
- `sessionMaxLifetimeSeconds ?? 2592000`;
- `accessTokenTtlSeconds ?? 60`;
- **`refreshInactivityTimeoutSeconds ?? sessionMaxLifetimeSeconds`**.

At the defaults, therefore, only the max lifetime ends a session. It then validates.

**`validateTtlConfig(ttl)`** (`:66-110`) throws a plain `Error` at the first failing check, in this order:
1. any value not `Number.isFinite`: `Token and session lifetimes must be finite numbers.`
2. any value `<= 0`: `Token and session lifetimes must be positive.`
3. access over 3600: `Access-token TTL must be at most one hour (the deployment refuses to sign a longer-lived JWT).`
4. access `>=` inactivity: `Access-token TTL must be shorter than the refresh inactivity timeout.`
5. inactivity `>` max: `Refresh inactivity timeout must be at most the session max lifetime.` (Equal is
   accepted.)

It returns a new object with the three fields only.

**`setupConvexAuth`** (`server/setup.ts:190-252`):
- Its options are `{component, usersTable?, accessTokenTtlSeconds?, refreshInactivityTimeoutSeconds?,
  sessionMaxLifetimeSeconds?}`. `refreshTokenTtlSeconds` is gone (`a7bdf81d`); at runtime an old name is
  ignored.
- `resolveTtlConfig(options)` runs **when the app's module loads** (`:249`), so a bad config fails the push. Every
  call into the core spreads `...ttl`.
- The component validates again in `_internal_dangerous_signUp`, `_internal_dangerous_signIn` and `refresh`, with
  no defaults of its own.
- The JSDoc (`:180-188`) says: changes to the access-token TTL apply to tokens minted after them; the session TTLs
  apply to every token already issued.

### 1.3 Expiry and refresh (`component/expiry.ts`, `component/sessions.ts`, `public.ts` `refresh`)

**The two deadlines:**
- `refreshTokenInactivityExpiresAt(token, s) = token._creationTime + s·1000`;
- `sessionMaxLifetimeExpiresAt(session, s) = session._creationTime + s·1000`.

**Issuing a token.** `issueRefreshToken(ctx, session, now, ttl)` (`sessions.ts:233-252`) takes the session row. It
inserts `{hash, sessionId, state: "issued"}` and returns
`Math.min(now + inactivity·1000, session._creationTime + max·1000)` as the bundle's `refreshTokenExpiresAt`.
`issueSession` (`public.ts:75-108`) then:
1. evicts past the cap (§1.4);
2. inserts `{userId, component}`;
3. reads the session back for its `_creationTime`;
4. issues the refresh token;
5. mints the access token (§1.8).

**`refresh`** (`public.ts:396-505`). Its arguments are `{refreshToken, ...vTtlConfigFields}`. In order:
1. Validate the TTLs, then read `now`.
2. Look the token up by its hash. An unknown token gives `noSession`.
3. **New:** if the token's session is gone, return `noSession` with no warning and no deletion. The token is
   waiting for its scheduled erasure (§1.5), not a fork.
4. A `spent` or `dropped` token: warn (unchanged text), `deleteSession`, then `noSession`.
5. **Expiry:**
   - `lastIssued` is the presented token when it is `issued`. When it is `redeemed`, it is the session's newest
     issued token, or the presented one if there is none: the session last refreshed when it issued that token.
   - The token is expired when either deadline is `<= now`, inactivity measured from `lastIssued`. An expired token
     deletes its session and returns `noSession`, with no log.
6. `issued` → redeem; `redeemed` → the limit check (3 tokens, 5 s). Both unchanged.
7. Issue a new token, mint, and return
   `{kind: "rotated", tokens: {accessToken, refreshToken, refreshTokenExpiresAt, userId}}`.

**`listSessions`** returns `{sessionId, creationTime, lastRefreshedAt}[]`, **with no `expiresAt`**. The rest is
unchanged.

**Counting revoked sessions.** `revokeOtherSessions` and `revokeAllSessions` (`server/setup.ts:324-349`) count a
revoked session when `lastRefreshedAt + inactivity > now && creationTime + max > now`.

### 1.4 At most 100 sessions per user (`component/sessions.ts:29-127`)

`MAX_SESSIONS_PER_USER = 100` is exported. `evictLeastRecentlyRefreshedSessions(ctx, userId)` runs first in every
`issueSession`, sign-up included:
1. It reads all the user's sessions by `by_user`, every time, even under the cap.
2. `excess = count − 100 + 1`. It returns when `excess <= 0`.
3. Each session's `lastRefreshedAt` is its newest issued token's `_creationTime`, or `−Infinity` when it has none.
4. A stable ascending sort, where ties keep index order (the oldest first).
5. `deleteSession` on the first `excess`, then a warning: `Evicted 1 session past the 100 session limit for a
   single user` (`sessions`, and the count, when more than one).

A user already over the cap is brought back to 100.

Concurrent sign-ins of one user now read the same range, so they conflict and retry where before they only inserted.

### 1.5 A session's tokens erased in scheduled batches (`component/sessions.ts:129-186`)

- `deleteSession(ctx, sessionId)` returns if the session is gone. Otherwise it deletes the row and runs
  `ctx.scheduler.runAfter(0, internal.sessions.deleteSessionTokens, {sessionId})`. It no longer touches a token.
- `deleteSessionTokens` is an **internal** mutation of the component, at path `sessions:deleteSessionTokens`:
  - args `{sessionId: v.id("sessions")}`, returns `null`;
  - it deletes up to 1000 of the session's `refreshTokens` (`by_session_state`, `.take(1000)`);
  - it schedules itself again when it got exactly 1000.
- So after a sign-out, a revocation, an eviction or a detected reuse, the session row is gone in the same
  transaction, while its token rows linger until the job runs. The job shows in the component's
  `_scheduled_functions` and in the logs.
- A revocation of many token-heavy sessions fits one transaction: upstream's test revokes 12 sessions of 1 500 rows
  under the 16 000-write limit.
- `pruneRetiredTokens` and `redeem` are unchanged. `KNOWN_ISSUES.md`'s "bounded horizon" stays, now noting that such
  a session can still be signed out.

### 1.6 Accounts out of the core; the callbacks; the created users

**Claims.** `vAuthClaims` is `{method: v.string(), profile: v.any()}` (`lib/types.ts:213-221`). `providerName`
became `method` (`ccf8a392`), and `providerAccountId` is gone (`bca5f6e0`).

**Callbacks.**
- `createUser` gets `{method: {name, profile}}`;
- `onSignIn` gets `{method: {name, profile}, userId}`;
- neither gets an account id (`CreateUserFn`, `OnSignInFn`, `UserCallbacks`; `lib/types.ts:241-301`). The
  CHANGELOG's step 4 tells apps to change their validators.

**The core functions** (`public.ts`):
- `_internal_dangerous_signUp {claims, componentPath, createUserHandle, onSignInHandle?, ...ttl}`, in order:
  1. validate the TTLs;
  2. create the app user;
  3. record its id (below);
  4. `onSignIn`;
  5. `issueSession`.

  A repeated sign-up creates another user: the method must check its own component for the identity first.
- `_internal_dangerous_signIn {claims, componentPath, userId, onSignInHandle?, ...ttl}`:
  - It trusts `userId`, and says so: "a wrong `userId` signs the caller in as that user".
  - An empty one throws `Cannot sign in: no user id was given.`, after the TTL check.
  - Then it records the id, runs `onSignIn` and `issueSession`.
- `_internal_dangerous_signUpWithoutSession {claims, createUserHandle}` → `{userId}`, recording the id.

**Gone:**
- `accounts` and its lookups;
- `public.getUserIdByAccount`;
- the helper `resolveUserId`;
- `USE_USER_ID_AS_ACCOUNT_ID`;
- the errors `Cannot create an account: …`, `Invariant violation: an account for provider = …` and `Cannot sign in:
  no account for provider = …`.

**The helpers** (`BoundAuthHelpers`, `lib/types.ts:309-392`; `server/setup.ts:352-431`):
- `completeSignUp({profile, authenticatedBy})`;
- `completeSignIn({userId, profile, authenticatedBy})`;
- `signUpWithoutSession({profile})`;
- `revokeOtherSessions()`, `revokeAllSessions(userId)`.

**`authenticatedBy`** is the method's component reference. **`componentPathOf(component)`** (`lib/componentPath.ts:23-41`)
turns it into the session's `component`:
- it reads `getFunctionAddress(component).reference`, which must start with `_reference/childComponent/` and have
  something after it;
- it returns the rest, so a nested component gives `"parent/child"` and a function of one gives its full path;
- otherwise it throws ``Expected a reference inside a component that the app mounts, such as `components.authPassword`.``

**`createdUserIds`** (`00595c0d`):
- `recordCreatedUserId(ctx, userId)` inserts the id when the `by_userId` lookup finds none. The three sign-in
  functions call it, before `onSignIn`.
- **`public.markUserIdCreated {userId}` → `null`** is new. `""` throws `Cannot mark an empty user ID as created.`;
  the call is idempotent. It is for users the app imports or creates without the core.
- Nothing reads the table at 2.0.0. The PR calls it groundwork for "attestations", which the other components will
  accept only from the core at `auth` (`lib/coreComponent.ts:14-16`).

### 1.7 Names (`fd06a184`, `ccf8a392`, `a0fff71c`)

**The functions that trust their caller are renamed:**

| At `db15c82e` | At 2.0.0 |
|---|---|
| `auth` `public.signUp` | `public._internal_dangerous_signUp` |
| `auth` `public.signIn` | `public._internal_dangerous_signIn` |
| `auth` `public.signUpWithoutSession` | `public._internal_dangerous_signUpWithoutSession` |
| `authPassword` `public.setPassword` | `public._internal_dangerous_setPassword` (§1.11) |

Their JSDoc gains DANGER paragraphs. The other public functions keep their names: `getSession`, `refresh`,
`signOut`, `listSessions`, `revokeSessions`.

**Method names and binding.** `bindProvider` became `bindMethod` (internal). The method names are:
- username + password: `"usernamePassword"` (was `"password"`);
- username + passkey: `"usernamePasskey"`;
- anonymous: `"anonymous"`.

A duplicate name fails with ``A sign-in method named "<name>" is already bound to this auth core. The app's
callbacks get the name of the sign-in method as `method.name`, so each sign-in method must have a unique name.``

**Test helpers:** `registerPasswordProvider` → `registerPassword`, `registerAnonymousProvider` → `registerAnonymous`.
`registerCore(t, name = "auth")` keeps its `name`. `a0fff71c`'s other renames
(`completeSignUpWithEmailPassword`, `*Options`) are email's and OAuth's.

### 1.8 The core mounted only as `auth`; the audience (`b99e842e`, `6c0ebf3f`)

**`lib/coreComponent.ts`:**
- `CORE_COMPONENT_PATH = "auth"`.
- `mintAccessToken` (`public.ts:62-73`) signs `{sub: sessionId, aud: AUDIENCE}`, then runs
  **`assertMountedAsCore(token)`**. So a wrong mount throws inside the sign-in, sign-up or refresh mutation, which
  rolls back.
- `assertMountedAsCore` decodes the token's `iss` (`atob` of the payload, no signature check). It strips
  `<cloud URL>/components/` and throws when the rest is not `auth`:
  ``The auth component is mounted at "<path>", but it must be mounted at "auth". Use `app.use(auth)` in convex.config.ts, without a `name` option.``
  - A token the app signed, whose issuer is the bare cloud URL, passes. That happens only in tests, which run the
    core as the app.
  - A nested `parent/auth` fails.
- `cloudUrl()` reads `process.env.CONVEX_CLOUD_URL` inside the component and strips trailing slashes. Unset or
  empty, it throws `The CONVEX_CLOUD_URL environment variable is not set. Convex Auth needs it to check the issuer of
  a token.`

**`convexAuthProvider()`** (`server/authProvider.ts:25-40`) takes no options any more (`componentName` gone). It
returns:

```
{type: "customJwt", applicationID: "convex-auth", issuer: "<cloud>/components/auth", jwks: "<cloud>/.well-known/jwks.json", algorithm: "ES256"}
```

**What upstream leaves as it was:**
- `getAuthUserId(ctx, component?)` still takes a component, and its JSDoc still shows `components.myAuth`
  (`server/userId.ts:52-65`), although any mount but `auth` is now refused.
- `vitest.config.ts` sets `CONVEX_CLOUD_URL` for every project.

**The audience** is `AUDIENCE = "convex-auth"` (`public.ts:44`), and `applicationID` the same (`6c0ebf3f`). The PR's
reason: `signJwt` serves several purposes, so a specific `aud` keeps tokens from being mixed up. Outstanding
60-second tokens stop verifying, which it accepts.

### 1.9 The OAuth client's errors (`3ad61bd9`)

`OauthFlowError` (`methods/oauth/client.ts`) loses `{error: "REJECTED", data}`. A thrown redemption, including a
`ConvexError` from the app's `onSignIn` or `createUser`, is now `{error: "OTHER_ERROR", cause: error}`, as in the
other methods. The examples drop their `case "REJECTED"`.

bunvex ships this client inert in the core's provider (STUDY-201 C-5), so the change reaches it now.

### 1.10 The client signs out when its session is revoked (`a48a91a5`)

The commit message says `AuthStateWatcher`; the code names it **`SessionWatcher`** (`react/client.tsx:112-147`). It
is not exported. It works as follows:
- It reads `AuthClientContext`. Outside `AuthProvider` it throws `SessionWatcher must be rendered under
  AuthProvider.`
- It takes `isAuthenticated` from `useConvexAuth()`: the state where the backend has accepted the token.
- It runs `useQuery(api.isAuthenticated, isClientAuthenticated ? {} : "skip")`.
- When the result is exactly `false`, an effect calls `authClient.signOut()` once. That call swallows errors; under
  SSR it posts to the sign-out route, which clears the cookies.
- It renders `null`, as the first child **inside** `ConvexProviderWithAuth`, before `children`:
  - in the SPA provider, at `react/index.tsx:167`;
  - in the Next.js client provider, at `ssr/nextjs/client.tsx:214`.

**When it fires.** Any server-side deletion of the session:
- a sign-out elsewhere;
- a revocation;
- password recovery;
- the 100-session eviction;
- a detected reuse.

A deadline that passes without a write is seen only at the next refresh.

**What it costs:** one more subscription per signed-in client.

**Breaking for apps:**
- `ConvexAuthApi` is `{refreshSession, signOut, isAuthenticated}`, with `isAuthenticated` **required**
  (`lib/types.ts:198-202`). Every example's `main.tsx` adds it.
- `ConvexAuthNextjsProvider` gets a required prop `isAuthenticatedFunctionName: string`:
  - the server provider passes `getFunctionName(config.isAuthenticated)`, because a function reference does not
    survive the trip to the client and its name does;
  - the client rebuilds the reference with `makeFunctionReference` in a `useMemo`.

**The tests,** in `react/client.test.tsx` with `convex/react` mocked:
- "signs out when the server reports the session is gone";
- "stays signed in while the server reports the session live";
- "does not subscribe until the backend accepts the token";
- "stops subscribing when the backend drops the token".

`react/index.test.tsx` and `ssr/nextjs/oauth.test.tsx` follow.

### 1.11 The password component and the method

**`_internal_dangerous_setPassword {userId, password, minimumLength}`** (`components/password/public.ts:68-90`).
`minimumLength` is new and required (`855d166c`).

**Validation** (`components/password/validation.ts`):
- `MIN_PASSWORD_LENGTH = 8`, down from 10, so passwords from other systems, v1's included, still verify.
- `MAX_PASSWORD_LENGTH = 100`.
- `validatePasswordInputFormat(password, minimumLength)` first throws when
  `!(minimumLength >= 8 && minimumLength <= 100)`, NaN included:
  `minimumLength must be between 8 and 100, but it is <n>.` Then, in the same order as before:
  1. `PASSWORD_TOO_SHORT {minimumLength}`, with the caller's minimum;
  2. `PASSWORD_TOO_LONG`;
  3. `PASSWORD_HAS_SURROUNDING_WHITESPACE`.
- `validateNewPassword` adds `PASSWORD_TOO_COMMON`.

**`verifyPassword`** checks the format against 8:
- under 8 code points → `PASSWORD_TOO_SHORT {minimumLength: 8}` (was 10);
- 8 or 9 code points → hashed and checked.

**The minimum.** `DEFAULT_MIN_PASSWORD_LENGTH = 10` moves to `lib/password.ts:12`. The method still re-exports it,
and passes it to `validateNewPassword` and `_internal_dangerous_setPassword`. So new passwords through the method
still need 10.

**The common-password list** (`5e9501ee`). The generator walks SecLists' list in order, NFC then lowercased:
- it keeps a password while fewer than 3000 of 8 or more characters have been kept, **or** while it has 10 or more
  and fewer than 3000 of those have been kept;
- the result is 5 423 passwords: 1 676 of length 8, 747 of 9, and 3 000 of 10 or more;
- the 10-or-more part is the list bunvex has.

Through the method nothing changes, since a 9-character password is too short first. A direct call with
`minimumLength` 8 refuses `12345678`.

**The method** (`methods/username-password/server.ts`):
- `METHOD_NAME = "usernamePassword"`, bound with `core.bindMethod`.
- Sign-up keeps its order. It calls `completeSignUp({profile: {}, authenticatedBy: component})` and then
  `_internal_dangerous_setPassword(…, minimumLength: DEFAULT_MIN_PASSWORD_LENGTH)`.
- Sign-in calls `completeSignIn({userId, profile: {}, authenticatedBy: component})`.
- **`changePassword`'s `NOT_SIGNED_IN` became `NOT_LOGGED_IN`** (`abecbeb3`). The union order is unchanged.

**`password-hash-wasm`.** The package was renamed and gained a scrypt verifier and a lucia scrypt encoder, as
modules of their own. The core imports only its argon2id module, and no path of `@convex-dev/auth` verifies scrypt
at 2.0.0. The CHANGELOG's "Passwords imported from v1 with 8 or more characters still work" is the floor at 8; the
migration docs say the tooling is "available soon". An unmerged branch, `nicolas/password-scrypt`, verifies a
`$scrypt$` row with the password in NFKC, as v1 does.

### 1.12 Usernames capped at 100 code points (`d3aa3b56`)

**The cap** (`components/username/validation.ts`):
- `MAX_USERNAME_LENGTH = 100`.
- The error union gains `USERNAME_TOO_LONG {maximumLength}`, second after `USERNAME_TOO_SHORT`.
- `validateUsernameFormat` checks it **first**: `[...normalizeUsername(u)].length > 100`, counted after
  normalization, as the minimum is.

**Lookup.** `getUserIdByUsername` returns `null` for such a username before any lookup (`public.ts:75-86`). Sign-in
with one is therefore `USER_NOT_FOUND`.

**Why.** A huge username used to crash the mutation with "Value is too large".

**Upstream's tests:**
- "accepts … a very long username" (5 000 characters) became "… a username of the maximum length", with
  `"😀".repeat(100)`;
- "rejects a username that is too long" takes 101 and 1 000 000 characters.

### 1.13 SSR and Next.js

**`RefreshResult` is exported** from `.` and `./ssr` (`09a992d7`). Its JSDoc moved onto the type and now says that
only a superseded token revokes its session; an unknown or expired one has no session left to revoke.

**Cache Components** (`aa63c0e7`). The library is unchanged. The example's layout wraps the server provider in
`<Suspense>`, and a new `next.config.ts` sets `cacheComponents: true`, as `create-next-app` does. Without the
boundary, `next build` fails on `/_not-found` with "Uncached data was accessed outside of `<Suspense>`", because the
provider reads cookies.

The boundary is left to the app on purpose: inside the provider it would stream everything, and `notFound()` could
not set a 404.

**Docs** (`f262819e`): `proxy.ts` goes next to `app/` (or at `src/proxy.ts`), since Next.js silently ignores a proxy
anywhere else.

**The Next.js example** uses username + password and GitHub only (§1.14). The `api` prop and the new client prop
are in §1.10.

### 1.14 Anonymous hidden from the package (`bff2ce56`, `cfbdb17d`, `21f00fb5`)

**Exports removed:**
- `./methods/anonymous/server`, `./methods/anonymous/react`;
- `./components/anonymous/convex.config(.js)`, `./components/anonymous/_generated/component(.js)`;
- `./components/anonymous/test`.

**The sources stay,** marked `@internal Not public until the anonymous sign-in method is ready.` The reason: it
comes back with account linking, so that an anonymous user can move to a lasting method. upstream's tests of it
stay.

**The component and the method changed with the accounts** (`c9b399d3`):
- `authAnonymous.accounts` is `{userId}`, with no index, since nothing looks it up again.
- `provider.createAnonymousAccount {userId}` → `null`; there is no UUID any more.
- `signInAnonymously` now calls `completeSignUp({profile: {}, authenticatedBy: component})` first, and then
  `createAnonymousAccount({userId})`.

**Examples and docs:**
- `react-minimal`, the anonymous example, is removed, along with its docs page.
- The Next.js example loses its anonymous button. `users.ts`'s `loggedInUser` returns `{id, name}`: the GitHub login
  or the username.

**Custom OAuth** (`fac21c92`) is hidden the same way, but bunvex has not built it.

### 1.15 No init command (`98efefd0`)

- The `bin` `{"@convex-dev/auth": "./dist/cli/init.js"}` is removed, with `src/cli/*` and its test.
- The dependencies `@babel/code-frame`, `chalk` and `commander` go with it.
- The reason: there is no key pair to generate any more.
- The docs now show the three files by hand.

### 1.16 The package (`packages/core/package.json`)

- `version` `2.0.0-beta.0` → `2.0.0`. `homepage` points to the docs on docs.convex.dev.
- **Removed:** the `bin` (§1.15), the anonymous entries (§1.14), and custom OAuth's 6 entries.
- **Added:** `./methods/username-passkey/react-custom` (passkeys, not built).
- **peerDependencies are unchanged in the range** (`convex ^1.48.0` predates `db15c82e`). The CHANGELOG's "upgrade
  `convex` to 1.48.0" is for apps coming from beta.0.
- **Dependencies:** `argon2id-wasm` → `password-hash-wasm 0.0.0`. `cookie 1.1.1` and `jose` are unchanged.

## 2. What an app can observe

### 2.1 Tables

The core's tables:
- `createdUserIds {userId}`, with the index `by_userId`;
- `sessions {userId, component}`;
- `refreshTokens` without `expiresAt`.

`authAnonymous.accounts` is `{userId}`, and the core has no `accounts` table.

The rows after a username + password sign-up:
- `auth/sessions {userId, component: "authPassword"}`;
- `auth/createdUserIds {userId}`;
- `authUsername/usernames`;
- `authPassword/passwords`.

### 2.2 The app's code

- The callbacks' validators take `method: {name: "usernamePassword", profile}`, with no `accountId`. An app with
  the old validator fails at its first sign-up, on argument validation.
- The setup options `refreshInactivityTimeoutSeconds` and `sessionMaxLifetimeSeconds` replace
  `refreshTokenTtlSeconds`. A bad configuration fails the push, with the message of the first failing check.
- The core mounted under any name but `auth` fails at the first sign-in. The provider function takes no options.
- The function paths `_internal_dangerous_*` show in `_generated`, the logs and the dashboard, and the core has
  `markUserIdCreated`. `getUserIdByAccount` is gone.
- The provider's `api` needs `isAuthenticated`. The Next.js client provider needs `isAuthenticatedFunctionName`, which
  the server provider passes.
- `RefreshResult` can be imported from the package root and from `./ssr`.

### 2.3 Sessions

- A session ends at the **sooner** of two deadlines: the inactivity timeout since its last refresh, and the max
  lifetime since its creation. At the defaults that means 30 days after sign-in, however often the client refreshes;
  before, each refresh pushed the end 30 days out.
- A lowered timeout or lifetime ends existing sessions at their next refresh, and a raised one extends them.
- `refreshTokenExpiresAt` never passes the max lifetime.
- A retry with a redeemed token is dated from the session's newest issued token.
- The 101st session of a user evicts the one refreshed longest ago, with the warning in the logs. Its holder's
  `getAuthUserId` turns null at once, and its client signs itself out (§2.5).
- A deleted session's token rows stay until `sessions:deleteSessionTokens` runs. A token presented in between gets
  `noSession`, without the reuse warning.
- `listSessions` has no `expiresAt`.

### 2.4 Methods

- Sign-in with a password under 8 characters gives `PASSWORD_TOO_SHORT {minimumLength: 8}`.
- A wrong password of 8 or 9 characters gives `INVALID_CREDENTIALS`. A stored one of that length verifies.
- New passwords through the method still need 10 characters.
- A username of more than 100 code points gives `USERNAME_TOO_LONG {maximumLength: 100}` on sign-up and
  `setUsername`, and `USER_NOT_FOUND` on sign-in.
- `changePassword` signed out gives `NOT_LOGGED_IN`.
- A component call to `setPassword` must use the new name and pass `minimumLength`. An out-of-range value throws
  before any write.
- The OAuth client's thrown errors are `OTHER_ERROR` with the error on `cause`.

### 2.5 The client

A signed-in client whose session is deleted on the server signs out at once, and under SSR its cookies are cleared,
instead of waiting for its access token to expire.

### 2.6 The package

- There is no `bin`.
- There are no anonymous entries.
- Under Next.js with Cache Components, the app wraps the server provider in `<Suspense>`.

## 3. How bunvex does it

Everything stays in `components/auth` (`@bunvex/auth`), in bunvex's names (C-4). What follows is what changes from
STUDY-201 and STUDY-202 as built.

### 3.1 The core

| v2.0.0 | bunvex today | To build |
|---|---|---|
| §1.1 schema | `src/component/schema.ts:21-44`: `accounts`, `sessions.accountId`, `refreshTokens.expiresAt` | v2's three tables |
| §1.2 `lib/ttl.ts` | `src/component/public.ts:22-26,77-86` (`ttlOf`: no finiteness check, db15c82e's messages); `src/server/setup.ts:105-119` (`refreshTokenTtlSeconds`, not validated at setup) | `src/lib/ttl.ts` with v2's defaults, checks and messages; `setupAuth` resolves at call time; the component's TTL arguments required |
| §1.3 expiry, `refresh`, `listSessions` | `public.ts:123-155,322-380,406,433`; `setup.ts:168-178` counts with `expiresAt` | `src/component/expiry.ts`; `issueRefreshToken` taking the session; `refresh` in v2's order; no `expiresAt` in the list; the count by both deadlines |
| §1.4 the cap | none (`startSession`, `public.ts:140-155`) | `MAX_SESSIONS_PER_USER`, the eviction, the warning |
| §1.5 batches | `deleteSession` deletes tokens inline (`public.ts:93-101`) | `src/component/sessions.ts` with the internal `deleteSessionTokens`; `_generated` regenerated |
| §1.6 accounts, callbacks, helpers | `lib/types.ts:114-210` (`providerName`, `providerAccountId`, `USE_USER_ID_AS_ACCOUNT_ID`, `resolveUserId`); `public.ts:55-59,158-280` | v2's claims, callbacks, helpers; `componentPathOf` (`src/lib/componentPath.ts`); `createdUserIds`, `markUserIdCreated` |
| §1.7 names | `public.signUp`/`signIn`/`signUpWithoutSession`; `bindProvider` (`setup.ts:83-85,147-228`) and db15c82e's duplicate message | `_internal_dangerous_*`; `bindMethod`; v2's message |
| §1.8 mount and audience | `bunvexAuthProvider({componentName?})` (`src/server/authProvider.ts:22-34`); no check after `signJwt` (`public.ts:135-137`); `AUDIENCE = "bunvex"` (`public.ts:21`, `authProvider.ts:29`) | `src/lib/coreComponent.ts` reading `BUNVEX_CLOUD_URL`; the check after every mint; no options; `"bunvex-auth"` (D-1) |

**`getAuthUserId`** keeps its optional component argument, as v2 does.

**The platform has what this needs:**
- scheduling from a component's mutation, also when the app calls it through `ctx.runMutation` (STUDY-157;
  `packages/server/test/component-scheduler.test.ts`);
- `internal` in a component's `_generated/api`;
- transaction limits that are always enforced (`packages/core/src/tx.ts:236,253`);
- `finishAllScheduledFunctions` in `@bunvex/testing`;
- the cloud URL in a component's environment (`componentEnv`, `packages/server/src/functions.ts:282-300`);
- the component issuer `<cloud>/components/<path>` (`packages/core/src/deployment-jwt.ts:200-203`);
- `atob`;
- `getFunctionAddress(...).reference` in the same `_reference/childComponent/<path>` form
  (`packages/server/src/components.ts:261-275`, `packages/protocol/src/api.ts:185-192`).

**Two things the build checks with a test:**
- that `process.env.BUNVEX_CLOUD_URL` read in a component equals the origin `signJwt` signs with, also with a
  canonical URL set (`canonical-urls.ts:43`). Otherwise the mount check would silently pass;
- that a bad `setupAuth` configuration fails `bunvex deploy` with the message.

### 3.2 The components and the methods

**`authPassword`:**
- `_internal_dangerous_setPassword` with `minimumLength`;
- `MIN_PASSWORD_LENGTH = 8` and the range check;
- `verifyPassword` against 8;
- `DEFAULT_MIN_PASSWORD_LENGTH = 10` in `src/lib/password.ts`, no longer equal to the component's floor;
- `components/auth/scripts/common-passwords.ts` with v2's two counters, then the list regenerated: 5 423 entries,
  the 10-or-more part unchanged.

**`authUsername`:** `MAX_USERNAME_LENGTH`, `USERNAME_TOO_LONG` first in the checks, and the early `null` in
`getUserIdByUsername`.

**The username + password method:**
- `"usernamePassword"` and `bindMethod`;
- `authenticatedBy: component`;
- `minimumLength` passed to the component;
- `NOT_LOGGED_IN`.

**Anonymous** (hidden, §3.4): `accounts {userId}`, `createAnonymousAccount {userId} → null`, and v2's order.

**AD-49's hasher is unchanged,** since v2.0.0 still verifies argon2id only. When v2 wires scrypt for imports from
v1, Bun's `node:crypto` `scrypt` verifies v1's vector off the JS thread, with `maxmem` raised above its 32 MiB
default (measured, Bun 1.4.4: 63 ms synchronous; 8 in parallel in 165 ms). That is for the study that follows it.

### 3.3 The client and SSR

- **`SessionWatcher`** goes in `src/react/client.tsx`:
  - `useBunvexAuth().isAuthenticated` is already the "server accepted the token" state (`packages/react/src/auth.ts:65`);
  - `useQuery` with `"skip"`;
  - it renders inside `BunvexProviderWithAuth` in `src/react/index.tsx` and `src/ssr/nextjs/client.tsx`.
- `AuthApi` (`src/lib/types.ts:108`) gains `isAuthenticated`.
- The Next.js client provider gains `isAuthenticatedFunctionName`, and the server provider (`src/ssr/nextjs/index.tsx:170-179`)
  passes `getFunctionName(config.isAuthenticated)`.
- `RefreshResult` is exported from `src/index.ts` and `src/ssr/index.ts`, with v2's JSDoc in bunvex's words.
- The inert OAuth client (`src/methods/oauth/client.ts:44,52,121-122,187`) drops `REJECTED` for
  `OTHER_ERROR {cause}`.
- bun's `mock.module` is process-wide. So the four `SessionWatcher` tests either run in their own file or drive a
  real `BunvexReactClient`, rather than mocking `@bunvex/react` under `provider.test.tsx`.

### 3.4 The package and the examples

**D-2, no init command.** Remove:
- `bin` (`components/auth/package.json:17-19`) and `src/cli/*`;
- `test/cli.test.ts` and `packages/differential/test/auth-init.test.ts`, which has nothing to run against at
  2.0.0;
- `.changeset/auth-init-command.md`, which is unreleased.

The README shows the three files by hand. DV-583 moves to *Resolved*.

**D-3, anonymous hidden.**
- Remove the six export entries, and mark the sources `@internal` as v2 does; their tests stay.
- Remove `examples/auth-anonymous`.
- Make `examples/auth-nextjs` username + password only: no GitHub yet, and `loggedInUser` returns the username.
- Fix the JSDoc examples in `src/ssr/setup.ts:37` and `src/test.ts:29`.
- Update `examples/README.md`, `apps/site/src/content.ts` (32 examples, two for built-in auth),
  `docs/parity/platform.md` and the README.
- Edit the three unreleased changesets that name anonymous.

**Cache Components.** `examples/auth-nextjs` gets the `<Suspense>` in its layout and `cacheComponents: true` next to
`transpilePackages`. Its end-to-end test builds the app, so it guards the regression. The README's Next.js section
shows the boundary and says where `proxy.ts` goes.

**`examples/auth-password`:**
- `isAuthenticated` in `api`;
- the `method` validators;
- `NOT_LOGGED_IN`;
- the `USERNAME_TOO_LONG` case;
- the `.gitignore` every other example has (`node_modules`, `dist`, `.env.local`, `.bunvex`). It was missing, and a
  local run left an untracked one.

### 3.5 The differential test and the pin

- `CONVEX_AUTH_PIN` (`packages/differential/harness/convex-auth.ts:22`) and `docs/parity/upstream.md:33` move to
  `f73ec439` (2.0.0).
- The differential app (`packages/differential/auth-app/`) follows v2.0.0's API: the `method` callbacks and the new
  TTL options.
- The app imports v2's anonymous method from its built files by path, since 2.0.0 no longer exports them. The
  anonymous scenario stays: the code is still in v2, and bunvex keeps it too.
- The scenarios gain:
  - the rows of `sessions.component` and `createdUserIds`;
  - the max-lifetime and lowered-timeout deadlines;
  - the 101st session;
  - the scheduled token erasure;
  - a username over 100;
  - a sign-in password of 8 or 9 characters;
  - `NOT_LOGGED_IN`;
  - the audience, `"bunvex-auth"` against `"convex-auth"` (DV-576).

### 3.6 The build, in PRs

1. **The package.** No init command (D-2), anonymous hidden (D-3), `examples/auth-anonymous` removed,
   `examples/auth-nextjs` password-only with Cache Components, and `examples/auth-password`'s `.gitignore`. This does
   not depend on the pin. Built:
   - the package has no `bin` and no anonymous entry; the anonymous sources are `@internal`;
   - the differential app's bunvex side imports the anonymous method from `components/auth/src`
     (`harness/convex-auth.ts`), so its scenario still runs on both sides;
   - `examples/auth-nextjs` builds with `cacheComponents: true` because of the boundary: without it, `next build`
     fails on the uncached cookies read, which its end-to-end test catches.
2. **The server side at the new pin.** §3.1, §3.2 and §3.5 together, because the differential compares against
   2.0.0 as a whole. It includes:
   - the ported upstream tests (§5);
   - the examples' server code;
   - a measurement of sign-in with the cap's extra range read, against `main`.
3. **The client.** §3.3, the examples' `api`, the README, and the parity rows.

## 4. Divergences

No new divergence.

**D-1** rewrites DV-576: `aud` and `applicationID` are `"bunvex-auth"`, where Convex Auth 2.0.0 has `"convex-auth"`
(rule 5). DV-576 was `"bunvex"` against `"convex"`.

**D-2** resolves DV-583: bunvex has no init command, as 2.0.0 has none.

**The new messages that name Convex's file or variable** follow the renames already decided: the mount error says
`bunvex.config.ts`, and the cloud-URL error names `BUNVEX_CLOUD_URL` (DV-179). The structure is v2's, the words are
bunvex's (C-4, rule 5):
- ``The auth component is mounted at "<path>", but it must be mounted at "auth". Use `app.use(auth)` in bunvex.config.ts, without a `name` option.``
- `The BUNVEX_CLOUD_URL environment variable is not set. The auth component needs it to check the issuer of a token.`

| # | Divergence | Why | Decision |
|---|---|---|---|
| D-1 | The access token's `aud` and the provider's `applicationID` are `"bunvex-auth"` (v2.0.0: `"convex-auth"`) | rule 5; v2's reason for a specific audience applies as is | DV-576, rewritten (owner, 2026-11-12) |

## 4b. Additions

None.

## 5. Tests

**Ported from upstream, at `f73ec439`:**
- **`component/core.test.ts`** gains about 22 tests and loses 8; several are renamed:
  - sessions and created user ids;
  - an empty `userId`;
  - the five lifetime cases;
  - a token whose session is gone;
  - the cap (5 tests on a virtual clock);
  - the 18 000-row revocation;
  - the max-lifetime cap on `refreshTokenExpiresAt`.

  The removed ones are the account tests and `getUserIdByAccount`.
- **`server/setup.test.ts`:** a lowered timeout counted as expired; a bad config refused at setup; `bindMethod`.
- **New suites:** `lib/ttl.test.ts` (5), `lib/coreComponent.test.ts` (5, with `BUNVEX_CLOUD_URL` set) and
  `lib/componentPath.test.ts` (6). `authProvider.test.ts` loses the `componentName` test.
- **The password suites:** `passwordProvider.test.ts`, the new `validation.test.ts` and `commonPasswords.test.ts`.
  Two bunvex assertions flip: `isCommonPassword("password")` becomes `true`, and the 10s become 8 where the component
  checks.
- **`username.test.ts`:** the maximum length and the too-long cases. They replace bunvex's 5 000-character test.
- **`anonymous.test.ts`:** "createAnonymousAccount records the user".
- **The example suites:** `react-password`'s `password.test.ts` with its 9-character sign-up.
- **The client:** the four `SessionWatcher` tests, the `api` with `isAuthenticated`, the Next.js provider with the
  new prop, and the OAuth client's `OTHER_ERROR`.

**Beyond upstream:**
- a component mounted under another name fails at sign-in, end to end;
- a bad `setupAuth` config fails `bunvex deploy`;
- the cloud URL check of §3.1;
- a revoked session signs a real client out, in `examples/auth-password`, whose account page can sign out other
  sessions.

**The differential test** covers the scenarios of §3.5.

**Sabotage checks:** for each of the following, break it and watch its test fail:
- the eviction;
- the session-null check in `refresh`;
- `lastIssued` against the presented token;
- the `Math.min` cap;
- the reschedule at 1000;
- `assertMountedAsCore`;
- the dedup of `createdUserIds`;
- the watcher's `"skip"`;
- the username cap's early `null`.

## 6. Not verified yet

- **A `$scrypt$` row in `authPassword`.** Read, not run: v2's argon2 WASM would answer `INVALID_CREDENTIALS`, where
  bunvex's verifier throws `unsupported algorithm scrypt` (`packages/server/src/password.ts:83-84`). Only an app that
  writes such a row itself reaches it. The build runs v2's WASM on one to confirm, and matches it if it differs.
- **GHSA-hmvv-g278-4x95 in v2's email component** (§1.0), when email is studied.
- **v2's planned "attestations"** (`createdUserIds`, the mount at `auth`) may change the sign-in functions' arguments
  again (`c9b399d3`'s "Known limit"). Daily triage catches it.

## 7. Questions for the owner

All three were decided by the owner on 2026-11-12: follow v2.0.0.

| # | Question | Decision |
|---|---|---|
| D-1 | **The audience.** v2.0.0 changed `"convex"` to `"convex-auth"`; bunvex has `"bunvex"` (DV-576) | Follow v2: `"bunvex-auth"`, DV-576 rewritten |
| D-2 | **The init command.** v2.0.0 removed `npx @convex-dev/auth`; bunvex built `bunx @bunvex/auth` (STUDY-201 C-8, DV-583) | Follow v2: remove it, DV-583 resolved |
| D-3 | **Anonymous.** v2.0.0 hides the method and its component until account linking, and removed its example; bunvex exports them and has `examples/auth-anonymous`, and `examples/auth-nextjs` uses them | Follow v2: hide them, remove the example, `auth-nextjs` username + password only |

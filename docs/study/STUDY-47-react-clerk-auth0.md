# STUDY-47 — React providers for Clerk and Auth0

- **Status:** accepted: X1–X2 as recommended (owner, 2026-10-03)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:** [STUDY-27](STUDY-27-auth.md) (`BunvexProviderWithAuth`, the client's token handling; A5 deferred
  these providers), [STUDY-46](STUDY-46-nextjs.md) (DV-241, scoped packages), [client-sync.md §12](../parity/client-sync.md).

## 1. How Convex does it

Both are thin adapters from an auth library's React hook to the `useAuth` that `ConvexProviderWithAuth`
(`npm-packages/convex/src/react/ConvexAuthState.tsx`) takes: `{ isLoading, isAuthenticated, fetchAccessToken }`,
where `fetchAccessToken({ forceRefreshToken })` returns a JWT or `null`. The client calls it with
`forceRefreshToken: false` first, and with `true` when the server refuses the token or before it expires.

**Clerk** (`npm-packages/convex/src/react-clerk/ConvexProviderWithClerk.tsx`, entry `convex/react-clerk`):

- Props `{ children, client, useAuth }`: the app passes the `useAuth` of whichever Clerk React SDK it uses
  (`@clerk/clerk-react`, `@clerk/react`, `@clerk/nextjs`, `@clerk/clerk-expo`). Convex types it structurally
  (`UseAuth`: `isLoaded`, `isSignedIn`, `getToken({ template?: "convex", skipCache? })`, `orgId`, `orgRole`,
  `sessionId`, `sessionClaims`); it imports no Clerk module.
- The adapter hook is built once per `useAuth` (`useMemo`). In it:
  - `fetchAccessToken`: if `sessionClaims?.aud === "convex"` (Clerk's native Convex integration, where the session
    token itself is for Convex) → `getToken({ skipCache: forceRefreshToken })`; else the JWT template →
    `getToken({ template: "convex", skipCache: forceRefreshToken })`. Any throw → `null`.
  - Its `useCallback` dependencies are `[orgId, orgRole, sessionId]`: switching organization, role or session makes a
    new fetcher, so `ConvexProviderWithAuth` calls `setAuth` again and the server sees the new claims. `getToken` is
    left out on purpose (Clerk's Expo hook is not memoized) and so is `sessionClaims`.
  - Returns `{ isLoading: !isLoaded, isAuthenticated: isSignedIn ?? false, fetchAccessToken }`, memoized on those.
- `package.json`: `@clerk/clerk-react` (`^4.12.8 || ^5.0.0`) and `@clerk/react` (`^6.4.3`) are optional peers.

**Auth0** (`npm-packages/convex/src/react-auth0/ConvexProviderWithAuth0.tsx`, entry `convex/react-auth0`):

- Props `{ children, client }`; it imports `useAuth0` from `@auth0/auth0-react` (optional peer `^2.0.1`), so it must
  be under `Auth0Provider`.
- `fetchAccessToken`: `getAccessTokenSilently({ detailedResponse: true, cacheMode: forceRefreshToken ? "off" : "on" })`
  and returns the response's `id_token` (the OIDC ID token, whose `aud` is the Auth0 client id that the deployment's
  `auth.config` names), not the access token. Any throw → `null`. Memoized on `getAccessTokenSilently`.
- Returns `{ isLoading, isAuthenticated, fetchAccessToken }` straight from `useAuth0`, memoized.

## 2. What an app can observe

- The component names and props; that Clerk's `useAuth` is passed in and Auth0's is not.
- The tokens asked of the library: the template name and the `aud` shortcut (Clerk), `skipCache` on forced refresh;
  `detailedResponse` + `cacheMode` and the ID token (Auth0). The library's dashboard must be configured to match
  (a Clerk JWT template of that name, or Clerk's integration setting that audience).
- A library error becomes "no token": the tree is unauthenticated, nothing throws.
- A new token fetch on organization, role or session change (Clerk).
- Everything else (loading/authenticated states, `Authenticated` / `Unauthenticated` / `AuthLoading`) is
  `BunvexProviderWithAuth`'s (STUDY-27).

## 3. How bunvex does it

- Two packages, written from scratch, each one file over `@bunvex/react`'s `BunvexProviderWithAuth`:
  - **`@bunvex/react-clerk`**: `BunvexProviderWithClerk({ children, client, useAuth })` and the `UseClerkAuth` type,
    the same logic as Convex's with the name "bunvex" (X1). Like Convex it imports no Clerk module, so it declares no
    Clerk peer: any Clerk React SDK's `useAuth` fits the structural type.
  - **`@bunvex/react-auth0`**: `BunvexProviderWithAuth0({ children, client })`, with `@auth0/auth0-react ^2.0.1` as a
    peer dependency (and pinned `2.28.2` as a dev dependency for its types).
- No JSX in the sources (`createElement`), but they type-check with React's DOM setup: own tsconfigs, like
  `packages/react`.
- `bunvex/react-clerk` and `bunvex/react-auth0` subpaths of the `bunvex` package come with the other client
  subpaths (separate PR).

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| X1 | The Clerk JWT template requested is named "bunvex", and the session-token shortcut checks `aud === "bunvex"` (Convex: "convex"). An app moving from Convex creates (or renames) a Clerk template "bunvex" | rule 5: no "convex" in shipped code | accepted (owner, 2026-10-03): DV-242 |
| X2 | Imported from `@bunvex/react-clerk` and `@bunvex/react-auth0` (Convex: subpaths `convex/react-clerk`, `convex/react-auth0` of one package) | the clients are scoped packages (DV-241) | accepted (owner, 2026-10-03): DV-243 |

## 5. Tests

`packages/sync-e2e/react/clerk-auth0.test.tsx`, **differential**: the same cases run on Convex's own
`ConvexProviderWithClerk` / `ConvexProviderWithAuth0` (from the `convex` package, the oracle) and on bunvex's, each
with a `ConvexReactClient` / `BunvexReactClient`, against one bunvex server with a real token issuer. Clerk's hook is
a fake passed as `useAuth`; Auth0's SDK is replaced with `mock.module("@auth0/auth0-react")` for both. The template
and audience name is the stack's ("convex" / "bunvex", X1).

- Clerk: signed in → `getToken({ template, skipCache: false })` and the identity reaches `ctx.auth`; the `aud` shortcut
  (no template); a refused cached token → `skipCache: true`; signed out → unauthenticated with no `getToken`;
  `getToken` throwing → unauthenticated; another `orgId` → a new token.
- Auth0: signed in → `{ detailedResponse: true, cacheMode: "on" }` and the ID token (the fake's access token is for
  another audience, so using it fails); a refused cached token → `cacheMode: "off"`; signed out; throwing.
- Sabotage (each caught): another template name; no `aud` shortcut; `skipCache` never set; `orgId` out of the
  dependencies; `isSignedIn` ignored; Auth0's access token instead of the ID token; `cacheMode` always "on".

## 6. Open questions

None.

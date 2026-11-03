# @bunvex/auth

Built-in auth for bunvex, as components. It is bunvex's version of [Convex Auth v2](https://github.com/get-convex/convex-auth)
(`@convex-dev/auth` 2.0.0-beta), with the same component names, tables and indexes, function paths, arguments,
results, defaults, messages and log lines, so a Convex export of its data imports unchanged.

> **Work in progress.** This version ships the server side (the components, `setupAuth`, the username + password and
> anonymous methods, `getAuthUserId`, the provider for `auth.config.ts`) and the clients (`@bunvex/auth/browser`,
> `@bunvex/auth/react` and the methods' hooks). Server rendering (Next.js) and more methods come later.

## Setup

Install the package, then let it write the three files below, as a start, from your project's root:

```sh
bun add @bunvex/auth
bunx @bunvex/auth
```

It writes `bunvex/auth.config.ts`, `bunvex/bunvex.config.ts` and `bunvex/auth.ts`, never over a file you have: for one
that exists, it prints what the file should contain. Then add a sign-in method, as below.

Mount the components your methods use:

```ts
// bunvex/bunvex.config.ts
import { defineApp } from "@bunvex/server";
import auth from "@bunvex/auth/bunvex.config.js";
import authPassword from "@bunvex/auth/components/password/bunvex.config.js";
import authUsername from "@bunvex/auth/components/username/bunvex.config.js";

const app = defineApp();
app.use(auth);
app.use(authPassword);
app.use(authUsername);
export default app;
```

Accept the tokens the auth component issues:

```ts
// bunvex/auth.config.ts
import type { AuthConfig } from "@bunvex/server";
import { bunvexAuthProvider } from "@bunvex/auth/server";

export default { providers: [bunvexAuthProvider()] } satisfies AuthConfig;
```

Export the session functions and the methods' functions, with your `createUser` (and, optionally, `onSignIn`):

```ts
// bunvex/auth.ts
import { setupAuth } from "@bunvex/auth/server";
import { setupUsernamePassword } from "@bunvex/auth/methods/username-password/server";
import { components, internal } from "./_generated/api";

const auth = setupAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const { signUpWithUsernamePassword, signInWithUsernamePassword, changePassword } = setupUsernamePassword(auth, {
  component: components.authPassword,
  usernameComponent: components.authUsername,
}).attachUserCallbacks({ createUser: internal.users.createUser });
```

```ts
// bunvex/users.ts
import { internalMutation } from "./_generated/server";
import { v } from "@bunvex/values";

export const createUser = internalMutation({
  args: { provider: v.object({ name: v.string(), accountId: v.string(), profile: v.any() }) },
  returns: v.id("users"),
  handler: async (ctx) => await ctx.db.insert("users", {}),
});
```

In the browser, put `BunvexAuthProvider` in place of `BunvexProvider` and sign in with a method's hooks:

```tsx
import { BunvexAuthProvider, useAuthActions } from "@bunvex/auth/react";
import { useSignInWithUsernamePassword } from "@bunvex/auth/methods/username-password/react";
import { BunvexReactClient, useBunvexAuth } from "@bunvex/react";
import { api } from "../bunvex/_generated/api";

const bunvex = new BunvexReactClient(import.meta.env.VITE_BUNVEX_URL);

export function Root({ children }: { children: React.ReactNode }) {
  return (
    <BunvexAuthProvider client={bunvex} api={{ refreshSession: api.auth.refreshSession, signOut: api.auth.signOut }}>
      {children}
    </BunvexAuthProvider>
  );
}

function SignIn() {
  const { signIn, pending } = useSignInWithUsernamePassword(api.auth);
  // `await signIn({ username, password })`: `{ status: "complete" }`, or `{ status: "error", userError }`.
}

function Account() {
  const { isAuthenticated } = useBunvexAuth();
  const { signOut } = useAuthActions();
}
```

Then, in any query, mutation or action, `await getAuthUserId(ctx)` (from `@bunvex/auth/server`) is the signed-in user's
id, or `null`. For anonymous sign-in, mount `authAnonymous` too and use `setupAnonymous` from
`@bunvex/auth/methods/anonymous/server`.

## The core component

The `auth` component keeps:

- **accounts**: each sign-in method's identity (`provider`, `providerAccountId`) and the id of the app user it belongs
  to. Your app owns its users table; the component only stores the id your `createUser` mutation returns;
- **sessions**, each with its **refresh tokens**. A refresh token is 32 random bytes, stored only as its SHA-256. Every
  refresh redeems the token presented and issues a new one; presenting a token that was already replaced (a leaked
  token) revokes the whole session. A client whose refresh answer was lost can retry with the token it holds.

Access tokens are signed by your deployment (`ctx.auth.signJwt`), with `iss` set to
`<your deployment's URL>/components/auth`, `aud: "bunvex"` and the session as their subject: your app finds the user
through the session, so a revoked session stops resolving to a user at once. They last 60 seconds by default (at most
an hour); refresh tokens last 30 days.

```ts
// bunvex/bunvex.config.ts
import { defineApp } from "@bunvex/server";
import auth from "@bunvex/auth/bunvex.config.js";

const app = defineApp();
app.use(auth);
export default app;
```

Its functions are only callable from your app (`components.auth.public.*`): `signUp`, `signIn`,
`signUpWithoutSession`, `refresh`, `signOut`, `getUserIdByAccount`, `getSession`, `listSessions` and
`revokeSessions`.

## The method components

Each mounts from `@bunvex/auth/components/<name>/bunvex.config.js`; the methods call them from your app.

- **`authPassword`** stores and checks passwords by user id. Hashes are argon2id (16 MiB, 3 passes, 1 lane) PHC
  strings, computed by your deployment off the JavaScript thread. A new password is 10 to 100 characters, with no
  leading or trailing whitespace, and not one of the 3000 most frequent passwords (any case); passwords compare in
  their NFC form. Checks are rate limited per user: 5 attempts, then one a minute. It mounts
  [`@bunvex/rate-limiter`](../rate-limiter) as `rateLimiter`.
- **`authUsername`** gives each user at most one username, unique across users whatever its case or Unicode
  normalization form, and kept as the user spelled it. Control, invisible and bidirectional characters, unusual spaces
  and a leading combining mark are refused.
- **`authAnonymous`** creates anonymous accounts, each a random UUID.

`@bunvex/auth/components/<name>/test` mounts each in a test deployment (`registerPasswordProvider`,
`registerUsername`, `registerAnonymousProvider`).

## The browser client

`@bunvex/auth/browser` holds the session on the client, without React (the React bindings build on it):

- `AuthClient` keeps the tokens a sign-in returned, hands the access token to your bunvex client, refreshes it under a
  lock shared across tabs (the Web Locks API) when asked, follows the other tabs, and reports `{ isLoading,
  isAuthenticated, token }` through `subscribe` / `getSnapshot`. In a single-page app it holds the refresh token; behind
  a server-rendering host, an httpOnly cookie does.
- Tokens are stored in `localStorage` by default (`defaultStorage()`), under `__bunvexAuthJWT_<namespace>` and
  `__bunvexAuthRefreshToken_<namespace>`, the namespace being your deployment's URL with only its letters and digits.
  Any `TokenStorage` will do, synchronous or not (`sessionStorage` for a session per tab, a secure store on React
  Native); without `localStorage` the session is kept in memory, with a warning.
- A sign-out the server fails still signs out locally.

## Server rendering

`@bunvex/auth/ssr` keeps the session in cookies on your app's server, for any framework that speaks WHATWG
`Request`/`Response`: the refresh token sits in an httpOnly, SameSite=Lax cookie and never reaches the page's
JavaScript, which holds the access token alone.

```ts
// auth.ts, on the server
import { setupBunvexAuthServer } from "@bunvex/auth/ssr";
import { api } from "./bunvex/_generated/api";

export const auth = setupBunvexAuthServer({
  bunvexUrl: process.env.BUNVEX_URL!,
  refreshSession: api.auth.refreshSession,
  signOut: api.auth.signOut,
  // Every function that signs a user in: the sign-in route serves these and nothing else.
  signIn: [api.auth.signInWithUsernamePassword, api.auth.signUpWithUsernamePassword],
  cookieOptions: { secure: process.env.NODE_ENV === "production" },
});
```

Mount `auth.bunvexProxyHandler`, `auth.refreshHandler` and `auth.signOutHandler` as `POST` routes (`/auth/signin`,
`/auth/refresh`, `/auth/signout` by default). The sign-in route speaks the HTTP client's wire, so a method's usual hook
works through it: point a `BunvexHttpClient` at `"/auth/signin?path="` and the route forwards each listed call to your
deployment, moving the refresh token it returns into the cookie. Every route refuses a request whose `Origin` is not
your app's (`allowedOrigins` adds others, for a proxy that rewrites `Host`). `createServerAuthChecker` asks the
deployment whether an access token names a live session; `ServerAuthSession` refreshes a request's cookies when its
access token is about to expire.

## Testing

`@bunvex/auth/test` mounts the component in a [`@bunvex/testing`](../../packages/testing) deployment and calls as a
signed-in session:

```ts
import { bunvexTest } from "@bunvex/testing";
import { registerCore, sessionIdentity } from "@bunvex/auth/test";

const t = bunvexTest();
registerCore(t);
// … sign in, then:
const asAlice = t.withIdentity(sessionIdentity(tokens));
```

Tokens verify against the test deployment's keys, `await t.jwks()`.

## Upgrading from 0.1.0-alpha.2

Up to 0.1.0-alpha.2, `@bunvex/auth` was the access-token verifier used inside `@bunvex/server`. That package is now
[`@bunvex/identity`](../../packages/identity); `@bunvex/server` depends on it, so an app has nothing to change.

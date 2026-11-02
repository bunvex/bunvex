# @bunvex/auth

Built-in auth for bunvex, as components. It is bunvex's version of [Convex Auth v2](https://github.com/get-convex/convex-auth)
(`@convex-dev/auth` 2.0.0-beta), with the same component names, tables and indexes, function paths, arguments,
results, defaults, messages and log lines, so a Convex export of its data imports unchanged.

> **Work in progress.** This version ships the server side: the components, `setupAuth`, the username + password and
> anonymous methods, `getAuthUserId` and the provider for `auth.config.ts`. The React and browser clients come next.

## Setup

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

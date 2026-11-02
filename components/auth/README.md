# @bunvex/auth

Built-in auth for bunvex, as components. It is bunvex's version of [Convex Auth v2](https://github.com/get-convex/convex-auth)
(`@convex-dev/auth` 2.0.0-beta), with the same component names, tables and indexes, function paths, arguments,
results, defaults, messages and log lines, so a Convex export of its data imports unchanged.

> **Work in progress.** This version ships the core component, `auth`. The sign-in methods (username + password,
> anonymous), `setupAuth`, `getAuthUserId`, the provider for `auth.config.ts` and the React and browser clients come
> next.

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

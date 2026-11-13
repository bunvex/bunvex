# Auth with a username and a password

bunvex's built-in auth, `@bunvex/auth` (its version of [Convex Auth](https://github.com/get-convex/convex-auth)), with
the username + password method:

- [bunvex.config.ts](bunvex/bunvex.config.ts) mounts the auth core, the password component and the username component;
- [auth.config.ts](bunvex/auth.config.ts) accepts the access tokens they issue, signed with the deployment's key;
- [auth.ts](bunvex/auth.ts) exports the session functions and the method's (`signUpWithUsernamePassword`,
  `signInWithUsernamePassword`, `changePassword`), with [users.ts](bunvex/users.ts)'s `createUser`;
- [currentUser.ts](bunvex/currentUser.ts) finds the signed-in user with `getAuthUserId`.

In the browser, `BunvexAuthProvider` keeps the session and refreshes its token; the sign-in form uses the method's hooks
and words each error code itself; the account page changes the password, optionally signing out the user's other
sessions, which the provider of each of those tabs sees at once: it is back at the sign-in form. A username is unique whatever its case; a password has at least 10 characters and is not one of the most
common ones; five wrong passwords in a minute and the next attempt waits.

## Run

```sh
bun install
bun run dev
```

## Test

```sh
bun test examples/auth-password
```

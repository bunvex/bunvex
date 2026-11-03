# Anonymous sign-in

bunvex's built-in auth, `@bunvex/auth` (its version of [Convex Auth](https://github.com/get-convex/convex-auth)), with
anonymous sign-in: a session with no credentials asked. Each sign-in is a new user ([users.ts](bunvex/users.ts)'s
`createUser`), who can call the app's functions as themselves (`visit` counts on their own row, found with
`getAuthUserId`); signing out ends that user, and there is no way back to them.

[bunvex.config.ts](bunvex/bunvex.config.ts) mounts the auth core and the anonymous component, [auth.config.ts](bunvex/auth.config.ts)
accepts their access tokens, and [auth.ts](bunvex/auth.ts) exports the session functions and
`signInAnonymously`.

## Run

```sh
bun install
bun run dev
```

## Test

```sh
bun test examples/auth-anonymous
```

# Auth under Next.js

bunvex's built-in auth, `@bunvex/auth` (its version of [Convex Auth](https://github.com/get-convex/convex-auth)), in a
Next.js App Router app that renders pages signed in. The refresh token lives in an httpOnly cookie and never reaches the
page's JavaScript, which holds the access token alone.

- [bunvex/](bunvex) is the backend: the auth core, the password, username and anonymous components, and
  [users.ts](bunvex/users.ts)'s `createUser` and `loggedInUser`.
- [lib/serverAuth.ts](lib/serverAuth.ts) configures the session's routes with `setupBunvexAuthServer`, listing the
  functions that sign a user in; [app/auth/](app/auth) mounts them: `signin` (the sign-in route, which forwards those
  functions and keeps the refresh token in its cookie), `refresh` and `signout`.
- [lib/bunvexAuth.tsx](lib/bunvexAuth.tsx) sets up Next.js's side with `setupBunvexAuthNextjs`:
  [proxy.ts](proxy.ts) refreshes the access token before each page and redirects to `/signin` when signed out;
  [app/page.tsx](app/page.tsx), a Server Component, reads the user with the cookie's token (`preloadQuery`), so the
  page arrives signed in; [app/layout.tsx](app/layout.tsx) hands the token to the client provider.
- [app/signin/page.tsx](app/signin/page.tsx) uses the methods' usual hooks, as a single-page app does: under the
  Next.js provider their calls go through the sign-in route.

Adding a sign-in method is adding its function to the list in `lib/serverAuth.ts`: no route, no client code.

## Run

```sh
bun install
bun run dev
```

## Test

```sh
bun test examples/auth-nextjs
```

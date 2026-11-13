---
"@bunvex/auth": minor
---

`@bunvex/auth/ssr/nextjs`: the session under Next.js's App Router (Next 16). `setupBunvexAuthNextjs` gives the proxy that refreshes the access token before each page and runs an app's redirects, the access token for Server Components and Server Actions, `isAuthenticatedNextjs`, and the providers, so a page renders signed in, the methods' usual hooks sign in through the app's own route, and a session revoked on the server signs the page out at once and clears its cookies (the client provider subscribes to the config's `isAuthenticated`, whose name it takes as `isAuthenticatedFunctionName`).

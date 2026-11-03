---
"@bunvex/auth": minor
---

`@bunvex/auth/ssr/nextjs`: the session under Next.js's App Router (Next 16). `setupBunvexAuthNextjs` gives the proxy that refreshes the access token before each page and runs an app's redirects, the access token for Server Components and Server Actions, `isAuthenticatedNextjs`, and the providers, so a page renders signed in and the methods' usual hooks sign in through the app's own route.

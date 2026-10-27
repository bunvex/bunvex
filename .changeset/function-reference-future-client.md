---
"@bunvex/client": patch
"@bunvex/react": patch
"@bunvex/nextjs": patch
---

The client side takes a `FunctionReference_future`, as `convex` 1.48 does: the React hooks and `BunvexReactClient`, `BunvexClient`, `BunvexHttpClient`, optimistic updates' local store, `QueryOptions`, and `bunvex/nextjs`'s `fetchQuery` / `fetchMutation` / `fetchAction` / `preloadQuery`. Arguments and results are typed by the reference's `_fn`. `@bunvex/client` re-exports `AnyReference` and `FunctionReference_future`.

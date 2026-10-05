---
"@bunvex/client": minor
"@bunvex/react": minor
---

`QueryOptions` and `bunvexQueryOptions` (Convex's `convexQueryOptions`, `@internal` as there), from `@bunvex/client` and `@bunvex/react`. `BunvexReactClient.prewarmQuery` takes `QueryOptions` plus `extendSubscriptionFor`, so its `args` is required in its type, as Convex's; a missing one still subscribes with `{}` (STUDY-102, DV-348).

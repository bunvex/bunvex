# @bunvex/react

## 0.1.0-alpha.2

### Patch Changes

- f710604: The client side takes a `FunctionReference_future`, as `convex` 1.48 does: the React hooks and `BunvexReactClient`, `BunvexClient`, `BunvexHttpClient`, optimistic updates' local store, `QueryOptions`, and `bunvex/nextjs`'s `fetchQuery` / `fetchMutation` / `fetchAction` / `preloadQuery`. Arguments and results are typed by the reference's `_fn`. `@bunvex/client` re-exports `AnyReference` and `FunctionReference_future`.
- Updated dependencies [7af9a1f]
- Updated dependencies [f710604]
- Updated dependencies [8700316]
- Updated dependencies [3b82fa1]
- Updated dependencies [6d4fc1f]
- Updated dependencies [06c53d7]
- Updated dependencies [c2ac7a5]
  - @bunvex/values@0.1.0-alpha.2
  - @bunvex/client@0.1.0-alpha.2

## 0.1.0-alpha.1

### Minor Changes

- dfdbb9b: `QueryOptions` and `bunvexQueryOptions` (Convex's `convexQueryOptions`, `@internal` as there), from `@bunvex/client` and `@bunvex/react`. `BunvexReactClient.prewarmQuery` takes `QueryOptions` plus `extendSubscriptionFor`, so its `args` is required in its type, as Convex's; a missing one still subscribes with `{}` (STUDY-102, DV-348).

### Patch Changes

- b769816: `BunvexReactClient.logger` is a `Logger`, as Convex's `ConvexReactClient.logger`: the one passed, a silent one for `logger: false`, or the console. `usePaginatedQuery` and `usePaginatedQuery_experimental` warn through it when they reset after an `InvalidCursor` error, so `logger: false` silences that warning and a custom logger receives it. `@bunvex/client` exports the logger factories (`@internal`) for this.
- 2ec40f0: `useQueries` (and so `useQuery`) moves a query to a new client with its journal only when there is one, as Convex. A `null` journal, which most queries have, used to be passed on, so the new client's `Add` carried `journal: null` where Convex's carries none.
- Updated dependencies [f55e37c]
- Updated dependencies [5d0a395]
- Updated dependencies [de1140c]
- Updated dependencies [4fb5d5e]
- Updated dependencies [f280986]
- Updated dependencies [f2e3c4b]
- Updated dependencies [f1cf707]
- Updated dependencies [1a4930f]
- Updated dependencies [c6f5fd8]
- Updated dependencies [899b394]
- Updated dependencies [039d52d]
- Updated dependencies [dfdbb9b]
- Updated dependencies [b769816]
- Updated dependencies [f166aa2]
- Updated dependencies [3cc30f0]
- Updated dependencies [a177c47]
- Updated dependencies [dc97491]
  - @bunvex/values@0.1.0-alpha.1
  - @bunvex/client@0.1.0-alpha.1

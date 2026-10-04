---
"@bunvex/client": patch
"@bunvex/react": patch
---

`BunvexReactClient.logger` is a `Logger`, as Convex's `ConvexReactClient.logger`: the one passed, a silent one for `logger: false`, or the console. `usePaginatedQuery` and `usePaginatedQuery_experimental` warn through it when they reset after an `InvalidCursor` error, so `logger: false` silences that warning and a custom logger receives it. `@bunvex/client` exports the logger factories (`@internal`) for this.

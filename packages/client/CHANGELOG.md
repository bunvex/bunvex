# @bunvex/client

## 0.1.0-alpha.1

### Minor Changes

- de1140c: The client announces its own package version (0.x) instead of the Convex client version it followed (1.46.0).
  The server no longer applies Convex's client deprecation thresholds (bunvex sets none of its own yet; a version
  that does not parse is still a 400), and it splits big transitions into chunks for every client
  (STUDY-139 P1–P3, DV-442).
- dfdbb9b: `QueryOptions` and `bunvexQueryOptions` (Convex's `convexQueryOptions`, `@internal` as there), from `@bunvex/client` and `@bunvex/react`. `BunvexReactClient.prewarmQuery` takes `QueryOptions` plus `extendSubscriptionFor`, so its `args` is required in its type, as Convex's; a missing one still subscribes with `{}` (STUDY-102, DV-348).

### Patch Changes

- 5d0a395: Value formats and the isolate compute metric carry bunvex's names (DV-307, DV-308). `format` (HTTP function API and streaming export) accepts `json` or `clean_json`, `encoded_json` and `export_json`; Convex's `convex_encoded_json`, `convex_clean_json` and `convex_json` are now a 400 `BadFormat`. `BunvexHttpClient` and the CLI ask for `encoded_json`, so a client and a server from before this change do not mix. The usage-limit metric `actionComputeConvexGbHours` is now `actionComputeIsolateGbHours`.
- c6f5fd8: The client warns about large and slow transitions, as Convex's `reportLargeTransition`. It logs a frame over 20 MB, or else a transition that took more than 20 s to arrive. The transit is measured from the `clientClockSkew` and `serverTs` the server sends, and a verbose line is always logged (STUDY-103; "more than" for Convex's "more that", DV-349).
- b769816: `BunvexReactClient.logger` is a `Logger`, as Convex's `ConvexReactClient.logger`: the one passed, a silent one for `logger: false`, or the console. `usePaginatedQuery` and `usePaginatedQuery_experimental` warn through it when they reset after an `InvalidCursor` error, so `logger: false` silences that warning and a custom logger receives it. `@bunvex/client` exports the logger factories (`@internal`) for this.
- Updated dependencies [f55e37c]
- Updated dependencies [4fb5d5e]
- Updated dependencies [f280986]
- Updated dependencies [f2e3c4b]
- Updated dependencies [da1ea24]
- Updated dependencies [f1cf707]
- Updated dependencies [1a4930f]
- Updated dependencies [899b394]
- Updated dependencies [039d52d]
- Updated dependencies [f166aa2]
- Updated dependencies [3cc30f0]
- Updated dependencies [a177c47]
- Updated dependencies [dc97491]
  - @bunvex/values@0.1.0-alpha.1
  - @bunvex/protocol@0.1.0-alpha.1

# STUDY-102 — `QueryOptions` and `bunvexQueryOptions`

- **Status:** implemented; the name and `prewarmQuery`'s required `args` decided by the owner (2026-10-05, DV-348)
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-05; the `convex` npm package
  1.46.0 as the oracle
- **Related:** [STUDY-26](STUDY-26-sync-client.md) (the React client, `prewarmQuery`),
  [STUDY-55](STUDY-55-react-query.md) (TanStack Query, a different integration)

## 1. How Convex does it

`npm-packages/convex/src/browser/query_options.ts` (lines 15–53) has two things:

- **`QueryOptions<Query>`**, a public type: `{ query: Query; args: FunctionArgs<Query> }`. `Query` is a query
  reference (`FunctionReference<"query">` or `FunctionReference_future<"query">`). `args` is required.
- **`convexQueryOptions(options)`**, marked `@internal`. It returns `options` itself: no copy, no check, no
  default. It exists only so TypeScript infers `Query` where the object is written.

Both are exported from `convex/browser` (`browser/index.ts:46-47`) and re-exported from `convex/react`
(`react/index.ts:99-100`), the same function object. Because the function is `@internal`, it is in the
JavaScript of the npm package but not in its published `.d.ts` (checked on 1.46.0).

The consumer is `ConvexReactClient.prewarmQuery` (`react/client.ts:577-588`). It takes
`QueryOptions<Query> & { extendSubscriptionFor?: number }`, so `args` is required in its type. At runtime it
watches the query with `queryOptions.args || {}` and holds the subscription for `extendSubscriptionFor` ms
(5 000 by default, `DEFAULT_EXTEND_SUBSCRIPTION_FOR`).

`useQuery`'s object form has its own `UseQueryOptions` type (`react/client.ts:870`), with `"skip"` and
`throwOnError`; it does not use `QueryOptions`.

## 2. What an app can observe

- `import { type QueryOptions } from "convex/browser"` (or `"convex/react"`), and `convexQueryOptions` at
  runtime (untyped, as it is `@internal`).
- `convexQueryOptions(x) === x`.
- `prewarmQuery({ query })` without `args` is a type error; at runtime it subscribes with `{}`.

## 3. How bunvex does it

- `packages/client/src/query-options.ts` has `QueryOptions<Query>` (a query reference, `args` required) and
  `bunvexQueryOptions`, which returns its argument. `@bunvex/client` exports both, so `bunvex/browser` has them.
  `@bunvex/react` re-exports the same objects, so `bunvex/react` has them too.
- `bunvexQueryOptions` is marked `@internal` in its doc comment, as Convex's. bunvex ships its TypeScript
  source, so the function is typed for an app that uses it anyway.
- `BunvexReactClient.prewarmQuery` takes `QueryOptions<Q> & { extendSubscriptionFor?: number }`. Its `args`
  was optional before, and is required now, as Convex. A missing `args` still subscribes with `{}`
  (`opts.args || {}`, as Convex).
- bunvex has no `FunctionReference_future`; its query references are `FunctionReference<"query">`.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| QO1 | Convex's `convexQueryOptions` is `bunvexQueryOptions` (`bunvex/browser`, `bunvex/react`): an `import { convexQueryOptions }` fails | Rule 5: no "convex" in shipped names, as `valueSize` for `getConvexSize` (DV-347) | owner, 2026-10-05: `bunvexQueryOptions` (DV-348) |

`prewarmQuery`'s `args` becoming required matches Convex, so it is not a divergence. It is a breaking change
in types for a bunvex app that left `args` out; such an app writes `args: {}`, as on Convex.

## 4b. Additions (beyond Convex)

None.

## 5. Tests

`packages/sync-e2e/test/query-options.test.ts`:

- **Runtime, against the oracle.** `bunvexQueryOptions` and the official `convexQueryOptions` return the same
  object for four inputs: no args, some args, an extra field, `args` undefined. `@bunvex/react`'s function is
  `@bunvex/client`'s, as `convex/react`'s is `convex/browser`'s.
- **Types, checked by `tsc`** (the root tsconfig covers the file):
  - the query's type is inferred;
  - the result is assignable to `QueryOptions<typeof query>`, and `prewarmQuery` takes it;
  - `@ts-expect-error` for a missing `args`, wrong args, a mutation reference, an extra field, and
    `prewarmQuery` without `args`.
- **`prewarmQuery`, differential.** `BunvexReactClient` and the official `ConvexReactClient` prewarm a query
  without args and one with args, for 100 ms, against a fake sync server. Both send the same query set
  changes: two `Add`s (args `[{}]` and `[{ id: "x" }]`), then two `Remove`s.

Sabotage checks, each caught:

- `bunvexQueryOptions` returns a copy: the runtime test fails;
- `QueryOptions.args` optional: `tsc` fails on two unused `@ts-expect-error`s;
- `prewarmQuery` takes `args?` again: `tsc` fails;
- a missing `args` defaults to something other than `{}`: the differential fails;
- `extendSubscriptionFor` ignored: the differential fails (no `Remove`).

## 6. Open questions

None.

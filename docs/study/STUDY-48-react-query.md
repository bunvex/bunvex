# STUDY-48 — TanStack Query: `@bunvex/react-query`, as Convex's `@convex-dev/react-query`

- **Status:** accepted: R1–R4 as recommended (owner, 2026-10-03); R4 (pagination) built in a follow-up PR
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
  (`npm-packages/@convex-dev/react-query`, published as `@convex-dev/react-query@0.1.0`; also on
  github.com/get-convex/convex-react-query)
- **Related:** [STUDY-26](STUDY-26-sync-client.md) (`watchQuery`, the HTTP client's `consistentQuery`),
  [STUDY-46](STUDY-46-nextjs.md) (the other server-rendering path), [STUDY-40](STUDY-40-local-backend-and-local-deployments.md)
  (one copy of each package).

## 1. How Convex does it

A package of its own, `@convex-dev/react-query` (peers `@tanstack/react-query ^5` and `convex`), one file
(`src/index.ts`). It is not part of `convex`. `convex/react`'s `convexQueryOptions` is unrelated: an identity
function typing `{ query, args }` for `prewarmQuery` (`browser/query_options.ts`, `@internal`).

**`ConvexQueryClient`** joins a `ConvexReactClient` to a TanStack `QueryClient`:

- `new ConvexQueryClient(clientOrUrl, options)`: a `ConvexReactClient`, or a URL to build one with the
  `ConvexReactClientOptions` in `options`. Its own options: `queryClient` (or call `connect(queryClient)`
  later; a second `connect` throws "already subscribed!"), `serverFetch` (the fetch for server-side requests),
  `dangerouslyUseInconsistentQueriesDuringSSR`.
- `isServer = typeof window === "undefined"`, decided when the module loads. On the server it builds a
  `ConvexHttpClient(convexClient.url, { fetch: serverFetch })` and never subscribes to the cache.
- `connect` subscribes to the `QueryCache`. For keys whose first element is `"convexQuery"` (not `"skip"`):
  - `added`: `convexClient.watchQuery(func, args, {})`, and on each update `onUpdateQueryKeyHash(hash)`;
  - `removed` (the query was garbage-collected, `gcTime` after its last observer left): unsubscribe;
  - other events do nothing.
- `onUpdateQueryKeyHash`: reads `watch.localQueryResult()`. A value → `queryClient.setQueryData(key, prev =>
  prev === undefined ? undefined : value)` (never creates an entry). A thrown error → `query.setState({ error,
  errorUpdateCount + 1, errorUpdatedAt: Date.now(), fetchFailureCount + 1, fetchFailureReason: error,
  fetchStatus: "idle", status: "error" })`. A hash it has no subscription for throws
  "Internal ConvexQueryClient error: onUpdateQueryKeyHash called for <hash>".
- `queryFn(otherFetch = throws "Query key is not for a Convex Query: <key>")`: a `"skip"` key throws
  "Skipped query should not actually be run, should { enabled: false }"; a query key runs
  `convexClient.query(func, args)` in the browser, `serverHttpClient.consistentQuery` on the server (or `query`
  when inconsistent); an `"convexAction"` key runs `action` on either; anything else goes to `otherFetch`.
- `hashFn(otherHashKey = hashKey)`: a query key hashes to `` `convexQuery|${name}|${JSON.stringify(convexToJson(args))}` ``;
  others to `otherHashKey`. It must be set as the `QueryClient`'s default `queryKeyHashFn` (TanStack cannot take
  it per query).
- `queryOptions(func, args)`: `{ queryKey, queryFn: this.queryFn(), staleTime: Infinity }`.

**Factories:**

- `convexQuery(func, args | "skip")` → `{ queryKey: ["convexQuery", getFunctionName(func), args ?? {} | "skip"],
  staleTime: Infinity, enabled: false if skipped }`. The name, not the reference, so the key is serializable.
  Args are put in the key as given: "TODO bigints are not serializable".
- `convexAction(func, args | "skip")` → `["convexAction", name, args or {} when skipped]`, the same options.
  Not reactive: TanStack's own refetching applies.

**Re-exports** under TanStack-friendly names, so apps never import `convex/react`'s `useQuery` by accident:
`useConvexQuery`, `useConvexQueries`, `useConvexPaginatedQuery`, `useConvexMutation`, `useConvexAction`,
`useConvex`, `useConvexAuth`, `optimisticallyUpdateValueInPaginatedQuery`.

**Setup** (README): `queryKeyHashFn: convexQueryClient.hashFn()` and `queryFn: convexQueryClient.queryFn()` as
the `QueryClient`'s defaults, then `convexQueryClient.connect(queryClient)`; `useQuery(convexQuery(api.x.y, args))`,
`useSuspenseQuery` too. The README's TODO: auth (works through the Convex provider), paginated queries.

## 2. What an app can observe

- The setup, class, factory and hook names; the key shape `[prefix, name, args]` (devtools, `invalidateQueries`
  by prefix, `setQueryData`); `staleTime: Infinity`.
- Live updates pushed into the cache with no refetch; one WebSocket subscription per cached query, dropped
  `gcTime` after it is unused; errors as TanStack error states.
- On the server: a consistent snapshot for every query of a render, over HTTP; so `prefetchQuery` + `dehydrate`
  in a Server Component (Next.js App Router, TanStack Start) and `HydrationBoundary` on the client.
- The error messages above.

## 3. How bunvex does it

A new package **`@bunvex/react-query`** (`packages/react-query`, peer `@tanstack/react-query ^5`, depending on
`@bunvex/react`, `@bunvex/client`, `@bunvex/values`), as `@bunvex/nextjs` and `@bunvex/react-clerk`: not in
`@bunvex/react` (every React app would carry TanStack's peer), and in this repository, not a repository of its
own (one version for every package, so one copy of `@bunvex/react`; CI against a real server; the official
package as an oracle in `sync-e2e`). The same design over existing pieces: `BunvexReactClient.watchQuery`
(`onUpdate`, `localQueryResult`), `BunvexHttpClient.consistentQuery`, `toJsonValue` / `fromJsonValue`. No server
change.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| R1 | Names: `BunvexQueryClient`, `bunvexQuery`, `bunvexAction`, `useBunvexQuery`, `useBunvexQueries`, `useBunvexPaginatedQuery`, `useBunvexMutation`, `useBunvexAction` (plus `@bunvex/react`'s `useBunvex`, `useBunvexAuth`); the messages name `BunvexQueryClient` | rule 5 | accepted (owner, 2026-10-03): DV-260 |
| R2 | The key prefixes are `"bunvexQuery"` / `"bunvexAction"`, so hashes start `bunvexQuery\|` | rule 5; visible in devtools and prefix invalidation | accepted (owner, 2026-10-03): DV-261 |
| R3 | The args in a key are their JSON encoding (`toJsonValue`), decoded for the call: a bigint, bytes or a special float survives `dehydrate`, persisters and devtools. For plain JSON args the key is the same as Convex's | an extension: Convex's open TODO ("bigints are not serializable") | accepted (owner, 2026-10-03): DV-262 |
| R4 | Paginated queries through TanStack Query (on the paginated client of STUDY-26 P2) | an extension: Convex's open TODO; built in a follow-up PR | accepted (owner, 2026-10-03): DV-263 |

## 5. Tests

- `sync-e2e/react/react-query.test.tsx`, against a real server: `useQuery(bunvexQuery(…))` loads, then follows
  every change with no refetch; one subscription per key, kept while observed and dropped `gcTime` after;
  `"skip"`; a query error as `status: "error"`; `bunvexAction`; `useMutation({ mutationFn: useBunvexMutation(…) })`;
  `useSuspenseQuery`; bigint/bytes args (R3); the same scenario on the official `@convex-dev/react-query`
  (oracle).
- `sync-e2e/test/react-query.test.ts` (no DOM, so the server path): `prefetchQuery` reads over HTTP with
  `consistentQuery` (one snapshot for all), or `query` when inconsistent; nothing subscribes; `dehydrate` holds
  the values; `queryFn` and `hashFn` errors and fallbacks.
- Sabotage: no `setQueryData` on update, no unsubscribe on `removed`, `query` instead of `consistentQuery` on
  the server, args unencoded in the key.

## 6. Open questions

None.

# STUDY-198 — TanStack Start with server-side rendering
<!-- index: TanStack Start with SSR: `examples/tanstack-start`, after Convex's `template-tanstack-start` and its quickstart, through `@bunvex/react-query`; nothing new in the packages | built (owner, 2026-10-30) -->

- **Status:** built (owner, 2026-10-30)
- **Convex source read:**
  - get-convex/convex-backend at `db19afd4a`: `npm-packages/docs/docs/client/tanstack/tanstack-start/index.mdx`, `npm-packages/docs/docs/quickstart/tanstack-start.mdx`, `npm-packages/private-demos/quickstarts/tanstack-start/` (the quickstart's app), `npm-packages/@convex-dev/react-query/src/index.ts`;
  - get-convex/templates at `34364d1`: `template-tanstack-start/` (also `-clerk` and `-authkit`, not built here).
- **Related:** [STUDY-55](STUDY-55-react-query.md) (`@bunvex/react-query`, SSR at one snapshot), [STUDY-46](STUDY-46-nextjs.md) (the other server-rendering path), [STUDY-90](STUDY-90-examples.md) (the examples).

## 1. How Convex does it

Convex has nothing specific to TanStack Start in its backend or client. The integration is TanStack Query's, through
`@convex-dev/react-query` (STUDY-55), and TanStack Router's SSR integration for Query:

- **The router** (`src/router.tsx` of the quickstart's app): a `ConvexQueryClient(VITE_CONVEX_URL)`, a `QueryClient`
  whose `queryKeyHashFn` and `queryFn` are the Convex client's (`hashFn()`, `queryFn()`), `connect(queryClient)`,
  then `createRouter({ routeTree, defaultPreload: "intent", context: { queryClient }, Wrap: ConvexProvider })` and
  `setupRouterSsrQueryIntegration({ router, queryClient })` from `@tanstack/react-router-ssr-query`. The older
  `template-tanstack-start` uses `routerWithQueryClient` from `@tanstack/react-router-with-query` instead; the
  quickstart moved to the SSR integration package.
- **The root route** is `createRootRouteWithContext<{ queryClient: QueryClient }>()`.
- **Pages** read with `useSuspenseQuery(convexQuery(api.x, args))`, which fetches during the server's render; a
  route's `loader` may start the query first (`queryClient.ensureQueryData` / `queryClient.query`), so a client-side
  navigation, or a hover with `defaultPreload: "intent"`, preloads it. Mutations use `useMutation` from
  `convex/react`.
- **On the server** the query client reads over HTTP with `ConvexHttpClient.consistentQuery`: every query of a render at
  one timestamp (`dangerouslyUseInconsistentQueriesDuringSSR` opts out). The results are dehydrated into the page;
  in the browser the same queries continue as live subscriptions, with no loading state.
- The docs call TanStack Start a Release Candidate.

## 2. What an app can observe

- The page's HTML holds the queries' results (rendered on the server), and the dehydrated query state under each
  query's key.
- After hydration the page updates live: a write from anywhere reaches it through the subscription.
- The queries of one render read one snapshot.

## 3. How bunvex does it

Everything is already built (STUDY-55): `BunvexQueryClient` (`hashFn`, `queryFn`, `connect`, `bunvexClient`),
`bunvexQuery`, the server's `consistentQuery` at one snapshot, `BunvexProvider` and `useMutation` from
`@bunvex/react`, and `bunvex dev`'s `VITE_BUNVEX_URL`. Nothing changes in the packages.

`examples/tanstack-start` is the tutorial's chat on TanStack Start 1.169, after the quickstart's router: a `loader`
that ensures the query, `useSuspenseQuery` in the page, `setupRouterSsrQueryIntegration`.

In this repository the example runs Vite under Bun (`bun --bun vite`), as `apps/site` does: the workspace's
`@bunvex/*` are TypeScript sources, and the server render loads them as they are. An app on the npm packages gets
their compiled JavaScript and may run Vite under Node too.

The random user name is picked in the browser after mount (`useEffect`): picked during the render, the server's and
the browser's differ and React refuses the hydration.

## 4. Divergences

None: an example, and no package change.

## 4b. Additions (beyond Convex)

None.

## 5. Tests

- `examples/tanstack-start/test/e2e.test.ts`: the functions deployed to a fresh backend; the app typechecked and built
  (the harness checks the client bundle holds nothing of the server); the built app served by `vite preview`; a page
  request's HTML holds a message written before it, and the dehydrated state under `bunvexQuery|messages:list|{}`.
- `examples/_browser/tanstack-start.browser.ts`: the HTML holds the message before any script runs; two tabs chat live
  once hydrated; a write from the server reaches both; no page or console error, so no hydration mismatch. The
  harness starts a TanStack Start app's dev server under Bun.

## 6. Open questions

None. Sign-in on TanStack Start (Convex's `-clerk` and `-authkit` templates) can follow as its own example.

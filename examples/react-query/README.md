# TanStack Query

The chat with TanStack Query (`@bunvex/react-query`). `src/main.tsx` connects a `BunvexQueryClient` to the
`QueryClient`; `src/App.tsx` uses TanStack's `useQuery(bunvexQuery(api.messages.list, {}))` and
`useMutation({ mutationFn: useBunvexMutation(api.messages.send) })`. No refetching or invalidation: bunvex
pushes every new result into the cache. On the server (no `window`), `prefetchQuery` reads over HTTP, every query
of one render at one snapshot, so it fits server rendering with `dehydrate`.

```sh
bun install
bun run dev   # starts a local deployment, pushes the functions, opens the page
```

Its end-to-end test (`test/e2e.test.ts`) deploys it to a fresh backend and checks the same behaviour through
the client.

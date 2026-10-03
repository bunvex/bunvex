# @bunvex/react-query

TanStack Query integration (STUDY-55), the counterpart of Convex's `@convex-dev/react-query`. Each cached
`bunvexQuery` is one live subscription: new results are pushed into the `QueryClient`'s cache (no refetch, so
`staleTime` is `Infinity`), and the subscription is dropped `gcTime` after the last `useQuery` using it unmounts.

```tsx
import { anyApi as api } from "@bunvex/client";
import { BunvexProvider, BunvexReactClient } from "@bunvex/react";
import { BunvexQueryClient, bunvexQuery, useBunvexMutation } from "@bunvex/react-query";
import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";

const bunvex = new BunvexReactClient(import.meta.env.VITE_BUNVEX_URL);
const bunvexQueryClient = new BunvexQueryClient(bunvex);
const queryClient = new QueryClient({
  defaultOptions: { queries: { queryKeyHashFn: bunvexQueryClient.hashFn(), queryFn: bunvexQueryClient.queryFn() } },
});
bunvexQueryClient.connect(queryClient);

function Messages() {
  const { data } = useQuery({ ...bunvexQuery(api.messages.list, {}), gcTime: 10_000 });
  const { mutate } = useMutation({ mutationFn: useBunvexMutation(api.messages.send) });
  return <button onClick={() => mutate({ body: "hi" })}>{data?.length ?? "…"}</button>;
}

export const App = () => (
  <BunvexProvider client={bunvex}>
    <QueryClientProvider client={queryClient}>
      <Messages />
    </QueryClientProvider>
  </BunvexProvider>
);
```

- `bunvexQuery(fn, args | "skip")`, `useSuspenseQuery` too; `bunvexAction(fn, args)` runs an action as a
  (non-live) query.
- **Server rendering** (Next.js App Router, TanStack Start): without `window`, `queryFn` reads over HTTP, every
  query of the render at one snapshot (`dangerouslyUseInconsistentQueriesDuringSSR` reads each at the latest);
  `prefetchQuery` + `dehydrate` on the server, `HydrationBoundary` on the client. `serverFetch` sets the fetch.
- Args are JSON-encoded in the key, so bigints and bytes survive `dehydrate` and persisters.
- The bunvex hooks are re-exported as `useBunvexQuery`, `useBunvexMutation`, `useBunvexAction`, … so they never
  clash with TanStack's.

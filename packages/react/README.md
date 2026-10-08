# @bunvex/react

React bindings (STUDY-26 §7), the counterpart of Convex's `convex/react`.

```tsx
import { anyApi as api } from "@bunvex/client";
import { BunvexProvider, BunvexReactClient, useMutation, useQuery } from "@bunvex/react";

const client = new BunvexReactClient("http://localhost:3210");

function Messages() {
  const messages = useQuery(api.messages.list); // undefined while loading, then kept up to date
  const send = useMutation(api.messages.send);
  return <button onClick={() => send({ body: "hi" })}>{messages?.length ?? "…"}</button>;
}

export const App = () => (
  <BunvexProvider client={client}>
    <Messages />
  </BunvexProvider>
);
```

- `useQuery(query, args | "skip")`, `useQuery_experimental`, `useQueries`;
- `useMutation(ref)` (and `.withOptimisticUpdate(fn)`), `useAction(ref)`;
- `useBunvexConnectionState()`, `useBunvex()`;
- `usePaginatedQuery(query, args, { initialNumItems })`, with the `insertAtTop` / `insertAtPosition` /
  `optimisticallyUpdateValueInPaginatedQuery` helpers;
- `BunvexProviderWithAuth`, `useBunvexAuth()`, `<Authenticated>` / `<Unauthenticated>` / `<AuthLoading>`;
- `usePreloadedQuery(preloaded)`, for a query preloaded on the server with `@bunvex/nextjs`.

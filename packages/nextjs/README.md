# @bunvex/nextjs

Next.js and server rendering (STUDY-46), the counterpart of Convex's `convex/nextjs`. Every function reads the
deployment URL from `NEXT_PUBLIC_BUNVEX_URL` (which `bunvex dev` writes to `.env.local`) unless `url` is given,
and its requests are never cached by Next.js (`cache: "no-store"`).

Load data in a Server Component, Server Action or Route Handler:

```ts
import { anyApi as api } from "@bunvex/client";
import { fetchMutation, fetchQuery } from "@bunvex/nextjs";

const messages = await fetchQuery(api.messages.list, {}, { token }); // `token`: the user's JWT, if any
await fetchMutation(api.messages.send, { body: "hi" });
```

Or preload a query on the server and keep it live on the client:

```tsx
// Server Component
import { preloadQuery } from "@bunvex/nextjs";

export async function Page() {
  const preloaded = await preloadQuery(api.messages.list);
  return <Messages preloaded={preloaded} />;
}

// Client Component ("use client"), under BunvexProvider
import { type Preloaded, usePreloadedQuery } from "@bunvex/react";

export function Messages(props: { preloaded: Preloaded<typeof api.messages.list> }) {
  const messages = usePreloadedQuery(props.preloaded); // the server's value first, then live
  return <ul>{messages.map((m) => <li key={m}>{m}</li>)}</ul>;
}
```

Options: `token`, `url`, `skipDeploymentUrlCheck`.

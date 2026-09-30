# @bunvex/client

The bunvex sync client (STUDY-26): one WebSocket that reconnects by itself, every subscription of the
client advancing together, mutations that resolve once their write is visible, and optimistic updates. It
speaks Convex's sync protocol v1 (STUDY-23), so the official `convex` client also works against a bunvex
server; `packages/sync-e2e` checks both.

```ts
import { anyApi as api, BunvexClient } from "@bunvex/client";

const client = new BunvexClient("http://localhost:3210");
client.onUpdate(api.messages.list, {}, (messages) => console.log(messages));
await client.mutation(api.messages.send, { body: "hi" }); // the list above already shows it
```

- `BaseBunvexClient`: the protocol (subscribe, mutation, action, optimistic updates, connection state).
- `BunvexClient`: callbacks, one-shot `query()`, for code that is not React.

Next: `@bunvex/react`, paginated queries, `setAuth` (with `@bunvex/auth`), and the HTTP client.

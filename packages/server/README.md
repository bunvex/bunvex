# @bunvex/server

The bunvex server: what an app's functions import (the query, mutation and action builders, the schema, the
HTTP router, crons), and the runtime that runs them (the function runtime, the HTTP API, WebSocket sync,
the scheduler, file storage and configuration). It follows Convex's `convex/server`.

```sh
bun add @bunvex/server @bunvex/values
bun add -d @bunvex/cli
```

```ts
// bunvex/messages.ts
import { mutation, query } from "@bunvex/server";
import { v } from "@bunvex/values";

export const list = query({ args: {}, handler: (ctx) => ctx.db.query("messages").collect() });
export const send = mutation({
  args: { body: v.string() },
  handler: (ctx, { body }) => ctx.db.insert("messages", { body }),
});
```

What an app's code uses:

- `query`, `mutation`, `action`, their `internal*` forms and `httpAction`: the function builders (STUDY-35);
- `defineSchema`, `defineTable`: the schema (STUDY-14);
- `httpRouter`: HTTP actions' routes (STUDY-31); `cronJobs`: cron jobs (STUDY-30);
- `paginationOptsValidator`, `createFunctionHandle`, `anyApi`, `makeFunctionReference`, `getFunctionName`, and
  the data model types (`GenericQueryCtx`, `DataModelFromSchemaDefinition`, …) that `_generated/` imports.

Outside Bun (a browser bundle, Next.js, Vite's server), the package resolves to those alone (STUDY-91).

What runs a deployment, on Bun:

- `createServer`: the HTTP API and the WebSocket sync on an engine, for embedding;
- `startLocalBackend` / `localBackendMain`: the `bunvex-local-backend` executable;
- `openPersistence`, `persistenceConfigFromEnv`: the database chosen by configuration (SQLite, memory,
  Postgres, MySQL, MongoDB through [`@bunvex/persistence`](../persistence));
- `issueAdminKey`, `checkAdminKey`: admin keys, byte for byte Convex's (STUDY-34).

Most apps never call these: `bunvex dev` ([`@bunvex/cli`](../cli/README.md)) runs a local deployment, and
[docker/README.md](../../docker/README.md) self-hosts one. What is built and what is next:
[ARCHITECTURE.md](../../ARCHITECTURE.md).

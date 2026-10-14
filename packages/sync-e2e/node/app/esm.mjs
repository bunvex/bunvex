// Run by `node` (../npm-packages.node.ts) in a directory whose node_modules holds the packages as npm ships
// them: what an app on Node.js does with them, as ES modules. Prints one JSON line.
import { anyApi, BunvexClient, BunvexHttpClient, VERSION } from "@bunvex/client";
import { fetchQuery } from "@bunvex/nextjs";
import { BunvexReactClient, useQuery } from "@bunvex/react";
import { BunvexProviderWithAuth0 } from "@bunvex/react-auth0";
import { BunvexProviderWithClerk } from "@bunvex/react-clerk";
import { BunvexQueryClient } from "@bunvex/react-query";
import { defineSchema, defineTable, makeFunctionReference } from "@bunvex/server";
import { BunvexError, v } from "@bunvex/values";

const url = process.argv[2];
const http = new BunvexHttpClient(url);
const sent = await http.mutation(anyApi.messages.send, { body: "from node" });
const listed = await http.query(makeFunctionReference("messages:list"), {});
const echoed = await http.action(anyApi.messages.echo, { x: { n: 5n } });
const error = await http.mutation(anyApi.messages.fail, {}).catch((e) => e);
const fetched = await fetchQuery(anyApi.messages.count, {}, { url });

// The sync client over Node's global WebSocket (Node 22+).
const client = new BunvexClient(url);
const live = await new Promise((resolve) => client.onUpdate(anyApi.messages.list, {}, resolve));
await client.close();

const schema = defineSchema({ messages: defineTable({ body: v.string() }) });
console.log(
  JSON.stringify({
    version: VERSION,
    sent,
    listed,
    echoed: typeof echoed.n === "bigint" ? `${echoed.n}n` : echoed.n,
    error: { bunvexError: error instanceof BunvexError, code: error.data?.code, n: `${error.data?.n}` },
    fetched,
    live,
    tables: Object.keys(schema.tables),
    exports: [BunvexReactClient, useQuery, BunvexProviderWithAuth0, BunvexProviderWithClerk, BunvexQueryClient].map(
      (f) => typeof f,
    ),
  }),
);
process.exit(0);

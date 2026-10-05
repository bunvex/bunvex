// `bunvexQueryOptions` and `QueryOptions` (STUDY-102), as Convex's `browser/query_options.ts`: an identity
// function that only types `{ query, args }`, and the shape `prewarmQuery` takes, `args` required. The runtime
// is checked against the official `convexQueryOptions`, and `prewarmQuery` against the official
// `ConvexReactClient.prewarmQuery` on a fake sync server; the types are checked by `tsc` (the root tsconfig
// covers this file).
import { afterEach, describe, expect, test } from "bun:test";
import { anyApi, bunvexQueryOptions, makeFunctionReference, type QueryOptions } from "@bunvex/client";
import { BunvexReactClient, bunvexQueryOptions as reactBunvexQueryOptions } from "@bunvex/react";
import * as oracleBrowser from "convex/browser";
import * as oracleReact from "convex/react";
import { ConvexReactClient } from "convex/react";
import { anyApi as oracleApi } from "convex/server";

// `@internal` in Convex: exported at runtime, left out of its published types.
type Identity = <T>(options: T) => T;
const convexQueryOptions = (oracleBrowser as unknown as { convexQueryOptions: Identity }).convexQueryOptions;
const reactConvexQueryOptions = (oracleReact as unknown as { convexQueryOptions: Identity }).convexQueryOptions;

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

describe("bunvexQueryOptions", () => {
  test("returns the object it was given, as the official convexQueryOptions", () => {
    const inputs = [
      { query: anyApi.messages.list, args: {} },
      { query: anyApi.messages.get, args: { id: "x", n: 1 } },
      { query: anyApi.messages.list, args: {}, extra: true },
      { query: "messages:list", args: undefined },
    ];
    for (const input of inputs) {
      const ours = bunvexQueryOptions(input as never);
      const theirs = convexQueryOptions(input as never);
      expect(ours).toBe(input as never);
      expect(theirs).toBe(input as never);
      expect(Object.keys(ours)).toEqual(Object.keys(theirs));
    }
  });

  test("@bunvex/react exports the same function, as convex/react re-exports convex/browser's", () => {
    expect(reactBunvexQueryOptions).toBe(bunvexQueryOptions);
    expect(reactConvexQueryOptions).toBe(convexQueryOptions);
  });
});

// Type-level checks: never run, only compiled.
const getById = makeFunctionReference<"query", { id: string }, { name: string }>("users:getById");
const addUser = makeFunctionReference<"mutation", { name: string }, string>("users:add");
function typeChecks(client: BunvexReactClient) {
  // The query's type is inferred from the object.
  const opts = bunvexQueryOptions({ query: getById, args: { id: "u1" } });
  const typed: QueryOptions<typeof getById> = opts;
  client.prewarmQuery(typed);
  client.prewarmQuery({ ...opts, extendSubscriptionFor: 1_000 });
  // @ts-expect-error `args` is required, as in Convex's QueryOptions.
  bunvexQueryOptions({ query: getById });
  // @ts-expect-error the args must be the query's.
  bunvexQueryOptions({ query: getById, args: { id: 1 } });
  // @ts-expect-error only a query.
  bunvexQueryOptions({ query: addUser, args: { name: "a" } });
  // @ts-expect-error `prewarmQuery` takes `QueryOptions`: `args` is required.
  client.prewarmQuery({ query: getById });
  // @ts-expect-error a QueryOptions has no other fields.
  const extra: QueryOptions<typeof getById> = { query: getById, args: { id: "u1" }, other: 1 };
  return extra;
}
void typeChecks;

/** A sync server that records every message it gets. */
function server() {
  const got: { type: string; modifications?: unknown[] }[] = [];
  const s = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return;
      return new Response("not a socket", { status: 400 });
    },
    websocket: {
      message(_ws, data) {
        got.push(JSON.parse(String(data)));
      },
    },
  });
  cleanup.push(() => s.stop(true));
  return { address: `http://127.0.0.1:${s.port}`, got };
}

type Prewarmer = {
  prewarmQuery(opts: { query: unknown; args?: unknown; extendSubscriptionFor?: number }): void;
  close(): Promise<void>;
};
const clients: [string, (address: string) => Prewarmer, Record<string, Record<string, unknown>>][] = [
  ["BunvexReactClient", (a) => new BunvexReactClient(a, { unsavedChangesWarning: false }) as never, anyApi],
  [
    "official ConvexReactClient",
    (a) => new ConvexReactClient(a, { unsavedChangesWarning: false }) as never,
    oracleApi as never,
  ],
];

/** What each client sends for a prewarm, held for 100 ms: its query set changes. */
async function prewarmMessages(make: (a: string) => Prewarmer, api: Record<string, Record<string, unknown>>) {
  const s = server();
  const client = make(s.address);
  cleanup.push(() => client.close());
  client.prewarmQuery({ query: api.messages!.list, args: undefined, extendSubscriptionFor: 100 });
  client.prewarmQuery({ query: api.messages!.get, args: { id: "x" }, extendSubscriptionFor: 100 });
  const changes = () => s.got.flatMap((m) => (m.type === "ModifyQuerySet" ? m.modifications! : []));
  for (let i = 0; i < 400 && changes().length < 4; i++) await Bun.sleep(5);
  return changes();
}

describe("prewarmQuery", () => {
  test("subscribes with the args (`{}` when missing) and unsubscribes after extendSubscriptionFor, as Convex", async () => {
    const results = [];
    for (const [, make, api] of clients) results.push(await prewarmMessages(make, api));
    const [ours, theirs] = results;
    expect(ours).toEqual(theirs!);
    expect(ours).toEqual([
      { type: "Add", queryId: 0, udfPath: "messages:list", args: [{}] },
      { type: "Add", queryId: 1, udfPath: "messages:get", args: [{ id: "x" }] },
      { type: "Remove", queryId: 0 },
      { type: "Remove", queryId: 1 },
    ]);
  });
});

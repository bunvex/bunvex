// How the base client folds server transitions and optimistic updates into its results (STUDY-65 G-C20, G-C22),
// as Convex's `browser/sync/client.test.ts` and `client_node.test.ts` pin it, differential: each scenario runs
// with the official BaseConvexClient (the oracle) and with BaseBunvexClient against a sync server the test
// scripts, and both must report the same updates and local results:
// - an optimistic value for a query never subscribed to is a local result, until its mutation is reflected;
// - a transition that answers a query the announced query set does not have yet is still taken;
// - a `QueryRemoved` drops the result without telling listeners (Convex characterizes this as behaviour it "may
//   want to change"); a later result for it is taken again, as the published client (1.46) does.
import { afterEach, describe, expect, test } from "bun:test";
import { anyApi, BaseBunvexClient } from "@bunvex/client";
import { v1 } from "@bunvex/protocol";
import { BaseConvexClient } from "convex/browser";
import { anyApi as oracleApi } from "convex/server";

type AnyBaseClient = {
  subscribe(name: string, args?: Record<string, unknown>): unknown;
  mutation(
    name: string,
    args: object,
    options?: {
      optimisticUpdate?: (store: { getQuery(...a: unknown[]): unknown; setQuery(...a: unknown[]): void }) => void;
    },
  ): Promise<unknown>;
  localQueryResult(name: string, args?: Record<string, unknown>): unknown;
  localQueryResultByToken(token: string): unknown;
  close(): Promise<void>;
};

class NeverSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  readyState = 0;
  constructor(readonly url: string) {}
  send() {}
  close() {}
}

const quiet = { logVerbose() {}, log() {}, warn() {}, error() {} };
type Make = (address: string, onTransition: (tokens: string[]) => void, offline?: boolean) => AnyBaseClient;
const clients: [string, Make, Record<string, Record<string, unknown>>][] = [
  [
    "official client",
    (address, onTransition, offline) =>
      new BaseConvexClient(address, onTransition as never, {
        unsavedChangesWarning: false,
        logger: quiet,
        ...(offline ? { webSocketConstructor: NeverSocket as never } : {}),
      }) as unknown as AnyBaseClient,
    oracleApi as never,
  ],
  [
    "BaseBunvexClient",
    (address, onTransition, offline) =>
      new BaseBunvexClient(address, onTransition as never, {
        unsavedChangesWarning: false,
        logger: quiet,
        ...(offline ? { webSocketConstructor: NeverSocket as never } : {}),
      }) as unknown as AnyBaseClient,
    anyApi as never,
  ],
];

/** A sync server the scenario scripts: it records what the client sends and sends what it is told. */
function scriptedServer() {
  const seen: Record<string, unknown>[] = [];
  let ws: Bun.ServerWebSocket<unknown> | null = null;
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return;
      return new Response("not a socket", { status: 400 });
    },
    websocket: {
      open(socket) {
        ws = socket;
      },
      message(_ws, data) {
        const m = JSON.parse(String(data)) as Record<string, unknown>;
        if (m.type !== "Event") seen.push(m);
      },
    },
  });
  let read = 0;
  return {
    address: `http://127.0.0.1:${server.port}`,
    async receive(): Promise<Record<string, unknown>> {
      for (let i = 0; i < 400 && read >= seen.length; i++) await Bun.sleep(5);
      if (read >= seen.length) throw new Error("no message");
      return seen[read++]!;
    },
    send: (m: v1.ServerMessage) => ws!.send(v1.encodeServerMessage(m)),
    stop: () => server.stop(true),
  };
}

const version = (querySet: number, ts: number) => ({ querySet, identity: 0, ts: BigInt(ts) });
const updated = (queryId: number, value: string): v1.StateModification => ({
  type: "QueryUpdated",
  queryId,
  value,
  logLines: [],
  journal: null,
});
const token = (udfPath: string) => JSON.stringify({ udfPath, args: {} });

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

for (const [name, make, api] of clients)
  describe(name, () => {
    /** Every onTransition call, as Convex's tests' UpdateQueue records it: token → local result. */
    function setup() {
      const server = scriptedServer();
      cleanup.push(server.stop);
      const updates: Record<string, unknown>[] = [];
      let client!: AnyBaseClient;
      client = make(server.address, (tokens) => {
        updates.push(Object.fromEntries(tokens.map((t) => [t, client.localQueryResultByToken(t)])));
      });
      cleanup.push(() => client.close());
      const updatesAfter = async (n: number) => {
        for (let i = 0; i < 400 && updates.length < n; i++) await Bun.sleep(5);
        return updates;
      };
      return { server, client, updates, updatesAfter };
    }

    test("an optimistic value is a local result, also for a query never subscribed to (G-C20)", () => {
      const client = make("http://127.0.0.1:1", () => {}, true);
      expect(client.localQueryResult("myUdf", {})).toBeUndefined();
      void client
        .mutation("myUdf", {}, { optimisticUpdate: (store) => store.setQuery(api.myUdf!.default, {}, true) })
        .catch(() => {});
      expect(client.localQueryResult("myUdf", {})).toBe(true);
      void client.close();
    });

    test("optimistic values for a subscribed and an unsubscribed query, through the server's answers", async () => {
      const { server, client, updatesAfter } = setup();
      client.subscribe("queries:a", {});
      expect((await server.receive()).type).toBe("Connect");
      expect((await server.receive()).type).toBe("ModifyQuerySet");
      const done = client.mutation(
        "mutations:z",
        {},
        {
          optimisticUpdate: (store) => {
            const a = store.getQuery(api.queries!.a, {});
            store.setQuery(api.queries!.a, {}, a === undefined ? "a local" : `${a} with a local applied`);
            const b = store.getQuery(api.queries!.b, {});
            store.setQuery(api.queries!.b, {}, b === undefined ? "b local" : `${b} with b local applied`);
          },
        },
      );
      expect(client.localQueryResult("queries:a", {})).toBe("a local");
      expect(client.localQueryResult("queries:b", {})).toBe("b local");
      server.send({
        type: "Transition",
        startVersion: version(0, 0),
        endVersion: version(1, 100),
        modifications: [updated(0, "a server")],
      });
      expect((await server.receive()).type).toBe("Mutation");
      server.send({ type: "MutationResponse", requestId: 0, success: true, result: null, ts: 200n, logLines: [] });
      server.send({
        type: "Transition",
        startVersion: version(1, 100),
        endVersion: version(1, 200),
        modifications: [updated(0, "a server")],
      });
      await done;
      expect(await updatesAfter(3)).toEqual([
        { [token("queries:a")]: "a local", [token("queries:b")]: "b local" },
        { [token("queries:a")]: "a server with a local applied", [token("queries:b")]: "b local" },
        { [token("queries:a")]: "a server", [token("queries:b")]: undefined },
      ]);
    });

    test("a result for a query the announced query set does not have yet is still taken (G-C22)", async () => {
      const { server, client, updatesAfter } = setup();
      client.subscribe("queries:slow", {});
      expect((await server.receive()).type).toBe("Connect");
      expect((await server.receive()).type).toBe("ModifyQuerySet");
      client.subscribe("queries:fast", {});
      expect((await server.receive()).type).toBe("ModifyQuerySet");
      server.send({
        type: "Transition",
        startVersion: version(0, 0),
        endVersion: version(1, 100),
        modifications: [updated(1, "fast result from malformed transition")],
      });
      expect(await updatesAfter(1)).toEqual([{ [token("queries:fast")]: "fast result from malformed transition" }]);
      expect(client.localQueryResult("queries:slow", {})).toBeUndefined();
      server.send({
        type: "Transition",
        startVersion: version(1, 100),
        endVersion: version(2, 200),
        modifications: [updated(0, "slow result")],
      });
      expect((await updatesAfter(2))[1]).toEqual({ [token("queries:slow")]: "slow result" });
      expect(client.localQueryResult("queries:fast", {})).toBe("fast result from malformed transition");
    });

    test("QueryRemoved drops the result without telling listeners; a later result is taken again (G-C22)", async () => {
      const { server, client, updates, updatesAfter } = setup();
      client.subscribe("queries:test", {});
      expect((await server.receive()).type).toBe("Connect");
      expect((await server.receive()).type).toBe("ModifyQuerySet");
      server.send({
        type: "Transition",
        startVersion: version(0, 0),
        endVersion: version(1, 100),
        modifications: [updated(0, "test result")],
      });
      expect(await updatesAfter(1)).toEqual([{ [token("queries:test")]: "test result" }]);
      server.send({
        type: "Transition",
        startVersion: version(1, 100),
        endVersion: version(1, 200),
        modifications: [{ type: "QueryRemoved", queryId: 0 }],
      });
      expect((await updatesAfter(2))[1]).toEqual({});
      expect(client.localQueryResult("queries:test", {})).toBeUndefined();
      server.send({
        type: "Transition",
        startVersion: version(1, 200),
        endVersion: version(1, 300),
        modifications: [updated(0, "new test result")],
      });
      // The test snapshot (April 2026) expected this result to be ignored; the published client (1.46) takes it,
      // and so does bunvex.
      expect(await updatesAfter(3)).toHaveLength(3);
      expect(updates[2]).toEqual({ [token("queries:test")]: "new test result" });
      expect(client.localQueryResult("queries:test", {})).toBe("new test result");
    });
  });

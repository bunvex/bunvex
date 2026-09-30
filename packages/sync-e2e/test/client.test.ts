// The bunvex client against a real bunvex server (STUDY-26 §5).
import { afterEach, describe, expect, test } from "bun:test";
import { anyApi, BunvexClient } from "@bunvex/client";
import { BunvexError } from "@bunvex/values";
import { startServer, until } from "./harness.ts";

const api = anyApi;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function setup() {
  const h = await startServer();
  cleanup.push(h.stop);
  const client = (opts = {}) => {
    const c = new BunvexClient(h.url, {
      logger: false,
      webSocket: { defaultInitialBackoffMs: 20, maxBackoffMs: 100 },
      ...opts,
    });
    cleanup.push(() => c.close());
    return c;
  };
  return { h, client };
}

describe("BunvexClient", () => {
  test("onUpdate delivers the current result, then every change", async () => {
    const { client } = await setup();
    const c = client();
    const seen: unknown[] = [];
    c.onUpdate(api.messages.list, {}, (v) => seen.push(v));
    await until(() => seen.length === 1, "first result");
    expect(seen).toEqual([[]]);
    await c.mutation(api.messages.send, { body: "hi" });
    await until(() => seen.length === 2, "update");
    expect(seen[1]).toEqual(["hi"]);
  });

  test("two queries a mutation changes move in ONE transition", async () => {
    const { client } = await setup();
    const c = client();
    const transitions: string[][] = [];
    c.client.addOnTransitionHandler((t) => transitions.push(t.queries.map((q) => q.token)));
    c.onUpdate(api.messages.list, {}, () => {});
    c.onUpdate(api.messages.count, {}, () => {});
    await until(() => c.client.localQueryResult("messages:count") === 0, "both loaded");
    transitions.length = 0;
    await c.mutation(api.messages.send, { body: "x" });
    const withBoth = transitions.filter((t) => t.length > 0);
    expect(withBoth).toHaveLength(1);
    expect(withBoth[0]).toHaveLength(2);
  });

  test("read-your-writes: once `await mutation()` returns, every subscription already shows the write", async () => {
    const { client } = await setup();
    const c = client();
    c.onUpdate(api.messages.count, {}, () => {});
    await until(() => c.client.localQueryResult("messages:count") === 0, "loaded");
    for (let i = 1; i <= 20; i++) {
      expect(await c.mutation(api.messages.send, { body: `m${i}` })).toBe(`M${i}`);
      expect(c.client.localQueryResult("messages:count")).toBe(i);
    }
  });

  test("a failed mutation rejects at once with a BunvexError carrying the server's data", async () => {
    const { client } = await setup();
    const c = client();
    const e = (await c.mutation(api.messages.fail, {}).catch((x) => x)) as BunvexError<Record<string, bigint | string>>;
    expect(e).toBeInstanceOf(BunvexError);
    expect(e.data).toEqual({ code: "nope", n: 7n });
    expect(e.message).toStartWith("[BUNVEX M(messages:fail)] [Request ID: ");
    expect(e.message).toEndWith("\n  Called by client");
  });

  test("a failed query reaches onError; without onError, getCurrentValue throws it", async () => {
    const { client } = await setup();
    const c = client();
    const errors: Error[] = [];
    const sub = c.onUpdate(
      api.messages.broken,
      {},
      () => {},
      (e) => errors.push(e),
    );
    await until(() => errors.length === 1, "error");
    expect(errors[0]).toBeInstanceOf(BunvexError);
    expect((errors[0] as BunvexError<string>).data).toBe("query says no");
    expect(() => sub.getCurrentValue()).toThrow("[BUNVEX Q(messages:broken)]");
  });

  test("a request made before the socket is open is sent once it opens", async () => {
    const { client } = await setup();
    const c = client();
    expect(c.connectionState().isWebSocketConnected).toBe(false);
    expect(await c.action(api.messages.echo, { x: "early" })).toBe("early");
  });

  test("query() is one-shot; action() answers", async () => {
    const { client } = await setup();
    const c = client();
    await c.mutation(api.messages.send, { body: "a" });
    expect(await c.query(api.messages.list, {})).toEqual(["a"]);
    expect(await c.action(api.messages.echo, { x: { deep: [1n, "two"] } })).toEqual({ deep: [1n, "two"] });
  });

  test("an optimistic update shows at once and gives way to the server's value without flicker", async () => {
    const { h, client } = await setup();
    const c = client();
    const seen: unknown[] = [];
    c.onUpdate(api.messages.list, {}, (v) => seen.push(v));
    await until(() => seen.length === 1, "loaded");
    const open = h.gate("slow");
    const done = c.mutation(
      api.messages.send,
      { body: "slow" },
      {
        optimisticUpdate: (store, args) => {
          const cur = store.getQuery(api.messages.list, {}) as string[] | undefined;
          if (cur) store.setQuery(api.messages.list, {}, [...cur, `${args.body} (pending)`]);
        },
      },
    );
    await until(() => seen.length === 2, "optimistic value");
    expect(seen[1]).toEqual(["slow (pending)"]);
    open();
    await done;
    expect(seen.at(-1)).toEqual(["slow"]);
    // Never back to the empty list in between.
    expect(seen.slice(1).some((v) => (v as string[]).length === 0)).toBe(false);
  });

  test("a restart: subscriptions come back, and a mutation whose answer was lost runs once", async () => {
    const { h, client } = await setup();
    const c = client();
    const seen: unknown[] = [];
    c.onUpdate(api.messages.list, {}, (v) => seen.push(v));
    await until(() => seen.length === 1, "loaded");
    // The server commits, then every socket drops before the answer goes out.
    let dropped = false;
    h.engine.committer.onCommit(() => {
      if (dropped) return;
      dropped = true;
      h.restart();
    });
    const result = await c.mutation(api.messages.send, { body: "once" });
    expect(result).toBe("ONCE");
    expect(dropped).toBe(true);
    expect(h.runs.filter((r) => r === "once")).toHaveLength(1);
    expect(c.client.localQueryResult("messages:list")).toEqual(["once"]);
    expect(c.connectionState().connectionCount).toBeGreaterThanOrEqual(2);
  });

  test("an action in flight when the connection drops fails; the client keeps working", async () => {
    const { h, client } = await setup();
    const c = client();
    await until(() => c.connectionState().isWebSocketConnected, "connected");
    const open = h.gate("action");
    const pending = c.action(api.messages.echo, { x: 1 }).catch((e) => e as Error);
    await until(() => c.connectionState().inflightActions === 1, "action sent");
    h.restart();
    const e = await pending;
    open();
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toContain("Connection lost while action was in flight");
    expect(await c.action(api.messages.echo, { x: 2 })).toBe(2);
  });

  test("connectionState reports the socket and the requests in flight", async () => {
    const { h, client } = await setup();
    const c = client();
    await until(() => c.connectionState().isWebSocketConnected, "connected");
    const open = h.gate("held");
    const p = c.mutation(api.messages.send, { body: "held" });
    await until(() => c.connectionState().inflightMutations === 1, "in flight");
    expect(c.connectionState()).toMatchObject({
      hasInflightRequests: true,
      hasEverConnected: true,
      connectionCount: 1,
    });
    open();
    await p;
    expect(c.connectionState()).toMatchObject({ hasInflightRequests: false, inflightMutations: 0 });
  });
});

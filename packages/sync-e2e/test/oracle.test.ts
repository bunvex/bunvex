// The protocol oracle (STUDY-23 P1, STUDY-26 C7): the official client, unmodified, against a bunvex server.
// If it subscribes, reads its own writes, reconnects and resends exactly as it does against Convex, bunvex
// speaks the protocol.
import { afterEach, describe, expect, test } from "bun:test";
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";
import { ConvexError } from "convex/values";
import { startServer, until } from "./harness.ts";

const api = anyApi;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function setup() {
  const h = await startServer();
  cleanup.push(h.stop);
  const logged: string[] = [];
  const keep = (...a: unknown[]) => logged.push(a.map(String).join(" "));
  const logger = { log: keep, warn: keep, error: keep, logVerbose: () => {} };
  const c = new ConvexClient(h.url, { skipConvexDeploymentUrlCheck: true, logger });
  cleanup.push(() => c.close());
  // The client warns about slow or huge transitions from serverTs and clientClockSkew: there must be none.
  cleanup.push(() => expect(logged.filter((l) => l.includes("received query results"))).toEqual([]));
  return { h, c };
}

describe("the official client against bunvex", () => {
  test("subscribes, and sees every change", async () => {
    const { c } = await setup();
    const seen: unknown[] = [];
    c.onUpdate(api.messages.list, {}, (v) => seen.push(v));
    await until(() => seen.length === 1, "first result");
    await c.mutation(api.messages.send, { body: "hi" });
    await until(() => seen.length === 2, "update");
    expect(seen).toEqual([[], ["hi"]]);
  });

  test("read-your-writes: after `await mutation()` the subscription already shows it", async () => {
    const { c } = await setup();
    const sub = c.onUpdate(api.messages.count, {}, () => {});
    await until(() => sub.getCurrentValue() === 0, "loaded");
    for (let i = 1; i <= 10; i++) {
      await c.mutation(api.messages.send, { body: `m${i}` });
      expect(sub.getCurrentValue()).toBe(i);
    }
  });

  test("errors carry the server's data as ConvexError.data; int64 values round-trip", async () => {
    const { c } = await setup();
    const e = (await c.mutation(api.messages.fail, {}).catch((x) => x)) as ConvexError<{ code: string; n: bigint }>;
    expect(e).toBeInstanceOf(ConvexError);
    expect(e.data).toEqual({ code: "nope", n: 7n });
    expect(await c.action(api.messages.echo, { x: [1n, 2.5, "s"] })).toEqual([1n, 2.5, "s"]);
  });

  test("a restart between commit and answer: it reconnects, resends, and the mutation ran once", async () => {
    const { h, c } = await setup();
    const sub = c.onUpdate(api.messages.list, {}, () => {});
    await until(() => Array.isArray(sub.getCurrentValue()), "loaded");
    let dropped = false;
    h.engine.committer.onCommit(() => {
      if (dropped) return;
      dropped = true;
      h.restart();
    });
    expect(await c.mutation(api.messages.send, { body: "once" })).toBe("ONCE");
    expect(dropped).toBe(true);
    expect(h.runs.filter((r) => r === "once")).toHaveLength(1);
    expect(sub.getCurrentValue()).toEqual(["once"]);
  }, 15_000);
});

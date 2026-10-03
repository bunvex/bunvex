// Per-kind concurrency limits (STUDY-68), as Convex's limiters: queries and mutations have their own
// (a run waits up to the timeout, then `TooManyConcurrentRequests`, HTTP 429; the sync protocol closes with
// "try again"); a cached query and a call inside another function's transaction take no permit; actions and
// HTTP actions share one; scheduled actions wait as long as it takes.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { functionLimitsFromEnv } from "../src/action-permits.ts";
import { action, Functions, internalAction, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { add, syncUrl, v1Client } from "./v1-client.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

/** Gates the functions wait on, opened by the test. */
const gates = new Map<string, { promise: Promise<void>; open: () => void }>();
const gate = (name: string) => {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  gates.set(name, { promise, open });
  return open;
};
const waitFor = (name: string) => gates.get(name)?.promise ?? Promise.resolve();

async function setup() {
  const engine = await new Engine(
    defineSchema({ log: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const limits = functionLimitsFromEnv({
    APPLICATION_MAX_CONCURRENT_QUERIES: "1",
    APPLICATION_MAX_CONCURRENT_MUTATIONS: "1",
    APPLICATION_MAX_CONCURRENT_V8_ACTIONS: "1",
    APPLICATION_FUNCTION_RUNNER_SEMAPHORE_TIMEOUT: "40",
    APPLICATION_FUNCTION_RUNNER_ACTION_SEMAPHORE_TIMEOUT: "40",
  });
  const functions = new Functions(engine, { limits }).register("m", {
    slowQuery: query(async (_ctx, { g }: { g: string }) => {
      await waitFor(g);
      return g;
    }),
    fast: query((_ctx, { n }: { n: number }) => n),
    slowMutation: mutation(async ({ db }, { g }: { g: string }) => {
      await waitFor(g);
      await db.insert("log", { g });
    }),
    nested: mutation(async ({ runQuery }) => runQuery("m:fast" as never, { n: 7 })),
    slowAction: action(async (_ctx, { g }: { g: string }) => {
      await waitFor(g);
      return g;
    }),
    later: mutation(({ scheduler }) => scheduler.runAfter(0, "m:note" as never, {})),
    note: internalAction(async ({ runMutation }) => runMutation("m:write" as never, {})),
    write: mutation(({ db }) => db.insert("log", { g: "scheduled" })),
    count: query(async ({ db }) => (await db.query("log").collect()).length),
  });
  const s = createServer({ engine, functions, port: 0 });
  stops.push(() => s.stop());
  const api = `http://127.0.0.1:${s.server.port}/api`;
  const call = async (kind: string, path: string, args: object = {}) => {
    const r = await fetch(`${api}/${kind}`, { method: "POST", body: JSON.stringify({ path, args }) });
    return { status: r.status, body: (await r.json()) as any };
  };
  return { s, call, limits };
}

const tooMany = (n: number, kind: string, knob: string) => ({
  code: "TooManyConcurrentRequests",
  message: `Too many concurrent requests. Your backend is limited to ${n} concurrent ${kind}s. To raise the limit, set ${knob}.`,
});

test("queries: one permit; a cached result and a query inside a mutation need none; the next waits, then 429", async () => {
  const t = await setup();
  expect((await t.call("query", "m:fast", { n: 1 })).body.value).toBe(1); // cached now
  const open = gate("q");
  const held = t.call("query", "m:slowQuery", { g: "q" });
  await Bun.sleep(10);
  expect(t.limits.query.outstanding.running).toBe(1);
  // Convex's message, "querys" included (`to_lowercase_string() + "s"`).
  expect(await t.call("query", "m:fast", { n: 2 })).toEqual({
    status: 429,
    body: tooMany(1, "query", "APPLICATION_MAX_CONCURRENT_QUERIES"),
  });
  expect((await t.call("query", "m:fast", { n: 1 })).body.value).toBe(1); // the cache answers
  expect((await t.call("mutation", "m:nested")).body.value).toBe(7); // in the mutation's transaction
  open();
  expect((await held).body.value).toBe("q");
  expect((await t.call("query", "m:fast", { n: 3 })).body.value).toBe(3);
});

test("mutations have their own limit; a waiter gets the freed permit before its timeout", async () => {
  const t = await setup();
  const open = gate("m");
  const held = t.call("mutation", "m:slowMutation", { g: "m" });
  await Bun.sleep(10);
  expect(await t.call("mutation", "m:slowMutation", { g: "none" })).toEqual({
    status: 429,
    body: tooMany(1, "mutation", "APPLICATION_MAX_CONCURRENT_MUTATIONS"),
  });
  const waiter = t.call("mutation", "m:slowMutation", { g: "none" });
  await Bun.sleep(5);
  open();
  expect((await held).body.status).toBe("success");
  expect((await waiter).body.status).toBe("success");
});

test("a scheduled action waits for a permit as long as it takes (no timeout)", async () => {
  const t = await setup();
  const open = gate("a");
  const held = t.call("action", "m:slowAction", { g: "a" });
  await Bun.sleep(10);
  await t.call("mutation", "m:later");
  await Bun.sleep(150); // well past the 40 ms timeout
  expect((await t.call("query", "m:count")).body.value).toBe(0);
  open();
  await held;
  for (let i = 0; i < 100 && (await t.call("query", "m:count")).body.value === 0; i++) await Bun.sleep(10);
  expect((await t.call("query", "m:count")).body.value).toBe(1);
});

test('the sync protocol: a query without a permit closes the session with "try again"', async () => {
  const t = await setup();
  const open = gate("s");
  const held = t.call("query", "m:slowQuery", { g: "s" });
  await Bun.sleep(10);
  const c = await v1Client(syncUrl(t.s.server.port));
  stops.push(() => c.ws.close());
  c.modify([add(1, "m:fast", { n: 9 })]);
  const closed = await c.closed;
  expect([closed.code, closed.reason]).toEqual([1013, "TooManyConcurrentRequests"]);
  open();
  await held;
});

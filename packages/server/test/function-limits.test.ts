// Per-kind concurrency limits (STUDY-68), as Convex's limiters: queries and mutations have their own
// (a run waits up to the timeout, then `TooManyConcurrentRequests`, HTTP 429; the sync protocol closes with
// "try again"); a cached query and a call inside another function's transaction take no permit; actions and
// HTTP actions share one; scheduled actions wait as long as it takes. The waits time out on virtual time
// (STUDY-132): a test says when 40 ms have passed, and a waiter never times out before it says so.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { TestRuntime } from "@bunvex/core/test-runtime";
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

/** Wait for a state of the server (the HTTP requests are real: they take what they take). */
async function until(f: () => boolean, what: string) {
  for (let i = 0; i < 2000; i++) {
    if (f()) return;
    await Bun.sleep(1);
  }
  throw new Error(`never: ${what}`);
}

async function setup() {
  const rt = new TestRuntime();
  const engine = await new Engine(
    defineSchema({ log: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { runtime: rt },
  ).init();
  const limits = functionLimitsFromEnv(
    {
      APPLICATION_MAX_CONCURRENT_QUERIES: "1",
      APPLICATION_MAX_CONCURRENT_MUTATIONS: "1",
      APPLICATION_MAX_CONCURRENT_V8_ACTIONS: "1",
      APPLICATION_FUNCTION_RUNNER_SEMAPHORE_TIMEOUT: "40",
      APPLICATION_FUNCTION_RUNNER_ACTION_SEMAPHORE_TIMEOUT: "40",
    },
    undefined,
    rt,
  );
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
    const r = await fetch(`${api}/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args }),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  /** The permit holder runs; then the time it may wait is up. */
  const running = (kind: "query" | "mutation" | "action", n = 1) =>
    until(() => limits[kind].outstanding.running === n, `${n} ${kind} running`);
  const queued = (kind: "query" | "mutation" | "action", n = 1) =>
    until(() => limits[kind].outstanding.queued === n, `${n} ${kind} queued`);
  return { s, call, limits, rt, running, queued };
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
  await t.running("query");
  const refused = t.call("query", "m:fast", { n: 2 });
  await t.queued("query");
  await t.rt.advance(39);
  expect(t.limits.query.outstanding.queued).toBe(1); // still waiting at 39 ms
  await t.rt.advance(1);
  // Convex's message, "querys" included (`to_lowercase_string() + "s"`).
  expect(await refused).toEqual({
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
  await t.running("mutation");
  const refused = t.call("mutation", "m:slowMutation", { g: "none" });
  await t.queued("mutation");
  await t.rt.advance(40);
  expect(await refused).toEqual({
    status: 429,
    body: tooMany(1, "mutation", "APPLICATION_MAX_CONCURRENT_MUTATIONS"),
  });
  const waiter = t.call("mutation", "m:slowMutation", { g: "none" });
  await t.queued("mutation");
  await Bun.sleep(60); // real time does not count: only the runtime's
  await t.rt.advance(39); // 1 ms before its timeout
  open();
  expect((await held).body.status).toBe("success");
  expect((await waiter).body.status).toBe("success");
});

test("a scheduled action waits for a permit as long as it takes (no timeout)", async () => {
  const t = await setup();
  const open = gate("a");
  const held = t.call("action", "m:slowAction", { g: "a" });
  await t.running("action");
  await t.call("mutation", "m:later");
  await t.queued("action"); // the scheduled run waits for the permit
  await t.rt.advance(150); // well past the 40 ms timeout
  expect(t.limits.action.outstanding.queued).toBe(1);
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
  await t.running("query");
  const c = await v1Client(syncUrl(t.s.server.port));
  stops.push(() => c.ws.close());
  c.modify([add(1, "m:fast", { n: 9 })]);
  await t.queued("query");
  await t.rt.advance(40);
  const closed = await c.closed;
  expect([closed.code, closed.reason]).toEqual([1013, "TooManyConcurrentRequests"]);
  open();
  await held;
});

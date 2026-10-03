// A WebSocket mutation's 60 s limit and the per-connection caps (STUDY-64 §1.1, §1.2), as Convex's sync worker
// (crates/sync/src/worker.rs: SYNC_WORKER_PROCESS_TIMEOUT, OPERATION_QUEUE_BUFFER_SIZE).
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { action, Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { MAX_INFLIGHT_ACTIONS, MAX_PENDING_MUTATIONS, SYNC_WORKER_PROCESS_TIMEOUT_MS } from "../src/sync.ts";
import { syncUrl, v1Client } from "./v1-client.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

async function setup(timeoutMs: number) {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const events: string[] = [];
  const gates = new Map<string, Promise<void>>();
  const functions = new Functions(engine).register("m", {
    step: mutation(async ({ db }, { name, ms }: { name: string; ms?: number }) => {
      events.push(`start ${name}`);
      await gates.get(name);
      if (ms) await Bun.sleep(ms);
      await db.insert("items", { name });
      events.push(`end ${name}`);
      return name;
    }),
    count: query(async ({ db }) => (await db.query("items").collect()).length),
    wait: action(async (_ctx, { name }: { name: string }) => {
      await gates.get(name);
      return name;
    }),
  });
  const { server, sync, stop } = createServer({ engine, functions, port: 0 });
  sync.mutationTimeoutMs = timeoutMs;
  stops.push(stop);
  const gate = (name: string) => {
    let open!: () => void;
    gates.set(
      name,
      new Promise<void>((r) => {
        open = r;
      }),
    );
    return open;
  };
  const count = () => functions.runQuery("m:count", {});
  return { events, gate, count, url: syncUrl(server.port) };
}

test("Convex's limit: 60 s", () => {
  expect(SYNC_WORKER_PROCESS_TIMEOUT_MS).toBe(60_000);
});

test("a mutation past the limit closes the connection with 1011, writes nothing, and the queue never runs", async () => {
  const { events, gate, count, url } = await setup(50);
  const openA = gate("a");
  const c = await v1Client(url);
  c.mutate(0, "m:step", { name: "a" });
  c.mutate(1, "m:step", { name: "b" });
  const e = await c.closed;
  expect(e.code).toBe(1011);
  expect(e.reason).toBe("InternalServerError");
  expect(c.responses()).toEqual([]);
  openA();
  await Bun.sleep(30);
  // The handler ran to its end, but was stopped before its commit; the queued mutation never started.
  expect(events).toEqual(["start a", "end a"]);
  expect(await count()).toBe(0);
});

test("the limit counts from when the mutation starts, not from when it was queued", async () => {
  const { count, url } = await setup(150);
  const c = await v1Client(url);
  // Each runs 100 ms: the second waits 100 ms in the queue, and finishes 200 ms after it was sent.
  c.mutate(0, "m:step", { name: "a", ms: 100 });
  c.mutate(1, "m:step", { name: "b", ms: 100 });
  await c.until(() => c.responses().length === 2);
  expect(c.responses().map((r) => r.success)).toEqual([true, true]);
  expect(await count()).toBe(2);
});

test("a resend after the timeout runs the mutation once", async () => {
  const { events, gate, count, url } = await setup(50);
  const openA = gate("a");
  const sessionId = crypto.randomUUID();
  const first = await v1Client(url, sessionId);
  first.mutate(0, "m:step", { name: "a" });
  expect((await first.closed).code).toBe(1011);
  const again = await v1Client(url, sessionId);
  again.mutate(0, "m:step", { name: "a" });
  await again.until(() => events.filter((x) => x === "start a").length === 2);
  openA();
  await again.until(() => again.responses().length === 1);
  expect(again.responses()[0]).toMatchObject({ requestId: 0, success: true, result: "a" });
  await Bun.sleep(20);
  expect(await count()).toBe(1);
});

test(`${MAX_PENDING_MUTATIONS} mutations may wait behind the running one; one more closes with 1013`, async () => {
  const { events, gate, url } = await setup(SYNC_WORKER_PROCESS_TIMEOUT_MS);
  const openA = gate("a");
  const c = await v1Client(url);
  c.mutate(0, "m:step", { name: "a" });
  await c.until(() => events.includes("start a"));
  for (let i = 1; i <= MAX_PENDING_MUTATIONS; i++) c.mutate(i, "m:step", { name: `n${i}` });
  await Bun.sleep(50);
  expect(c.ws.readyState).toBe(WebSocket.OPEN);
  c.mutate(MAX_PENDING_MUTATIONS + 1, "m:step", { name: "overflow" });
  const e = await c.closed;
  expect(e.code).toBe(1013);
  expect(e.reason).toBe("TooManyConcurrentMutations");
  openA();
  await Bun.sleep(20);
  // Only the mutation already running finished; the queued ones never started.
  expect(events).toEqual(["start a", "end a"]);
});

test(`${MAX_INFLIGHT_ACTIONS + 1} actions may run at once; one more closes with 1013`, async () => {
  const { gate, url } = await setup(SYNC_WORKER_PROCESS_TIMEOUT_MS);
  const open = gate("w");
  const c = await v1Client(url);
  const act = (requestId: number) => c.send({ type: "Action", requestId, udfPath: "m:wait", args: [{ name: "w" }] });
  for (let i = 0; i <= MAX_INFLIGHT_ACTIONS; i++) act(i);
  await Bun.sleep(50);
  expect(c.ws.readyState).toBe(WebSocket.OPEN);
  act(MAX_INFLIGHT_ACTIONS + 1);
  const e = await c.closed;
  expect(e.code).toBe(1013);
  expect(e.reason).toBe("TooManyInflightActionsForSingleClient");
  open();
});

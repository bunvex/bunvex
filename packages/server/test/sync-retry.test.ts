// Query reruns under load and store faults (STUDY-64 §1.4), as Convex's sync worker (crates/sync/src/worker.rs):
// at most UPDATE_QUERY_CONCURRENCY queries of a connection run at once; a run that fails with a transient
// error is retried at the same ts with backoff, invisibly to the client; an update whose ts left the write
// log's retention starts again at the newest ts.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine, OutOfRetentionError } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { backoffMs, retryOptions, UPDATE_QUERY_CONCURRENCY } from "../src/sync.ts";
import { add, history, syncUrl, v1Client } from "./v1-client.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});
// Short backoffs for the tests, through Convex's knobs.
const KNOBS = {
  SYNC_WORKER_QUERY_RETRY_INITIAL_BACKOFF_MS: "5",
  SYNC_WORKER_QUERY_RETRY_MAX_BACKOFF_SECS: "1",
  SYNC_WORKER_UPDATE_QUERIES_RETRY_INITIAL_BACKOFF_MS: "5",
  // The deployment-wide query limit (STUDY-68, 16 by default) would cap a connection below its own 20: the
  // per-connection bound is what these tests measure.
  APPLICATION_MAX_CONCURRENT_QUERIES: "100",
};
beforeAll(() => Object.assign(process.env, KNOBS));
afterAll(() => {
  for (const k of Object.keys(KNOBS)) delete process.env[k];
});

class TransientError extends Error {}

async function setup() {
  const p = await MemoryPersistence.open(null, { durable: false });
  const engine = await new Engine(defineSchema({ counters: defineTable(v.any()) }), p).init();
  await engine.mutation((db) => db.insert("counters", { n: 1 }));
  // The store fails the next `fail.reads` reads with `fail.error()`.
  const fail = { reads: 0, error: (): Error => new TransientError("connection reset") };
  const failable = <F extends (...a: never[]) => unknown>(f: F) =>
    ((...a: Parameters<F>) => {
      if (fail.reads > 0) {
        fail.reads--;
        throw fail.error();
      }
      return f(...a);
    }) as F;
  p.get = failable(p.get.bind(p));
  p.scan = failable(p.scan.bind(p));
  (p as { isTransient?: (e: unknown) => boolean }).isTransient = (e) => e instanceof TransientError;
  let running = 0;
  let most = 0;
  let release!: () => void;
  let gate = new Promise<void>((r) => (release = r));
  const functions = new Functions(engine).register("m", {
    read: query(async ({ db }) => (await db.query("counters").first())?.n ?? 0),
    // Holds until released, counting how many run at once.
    held: query(async (_ctx, { i }: { i: number }) => {
      running++;
      most = Math.max(most, running);
      await gate;
      running--;
      return i;
    }),
    bump: mutation(async ({ db }) => {
      const c = await db.query("counters").first();
      await db.patch(c!._id, { n: (c!.n as number) + 1 });
    }),
  });
  const { server, sync, stop } = createServer({ engine, functions, port: 0, redactLogsToClient: false });
  stops.push(stop);
  return {
    url: syncUrl(server.port),
    sync,
    fail,
    functions,
    most: () => most,
    running: () => running,
    release: () => {
      release();
      gate = new Promise<void>((r) => (release = r));
    },
  };
}

test("Convex's settings: 20 at a time; 500 ms → 600 s per query, 3 s → 600 s per update; full jitter", () => {
  expect(UPDATE_QUERY_CONCURRENCY).toBe(20);
  const r = retryOptions({}, {});
  expect(r.query).toEqual({ initialMs: 500, maxMs: 600_000 });
  expect(r.update).toEqual({ initialMs: 3000, maxMs: 600_000 });
  const half = () => 0.5;
  expect([0, 1, 2, 20].map((f) => backoffMs(r.query, f, half))).toEqual([250, 500, 1000, 300_000]);
});

test(`a connection runs at most ${UPDATE_QUERY_CONCURRENCY} of its queries at once`, async () => {
  const { url, most, running, release } = await setup();
  const c = await v1Client(url);
  c.modify(Array.from({ length: 100 }, (_, i) => add(i + 1, "m:held", { i })));
  await c.until(() => running() === UPDATE_QUERY_CONCURRENCY);
  await Bun.sleep(30);
  expect(running()).toBe(UPDATE_QUERY_CONCURRENCY);
  for (let k = 0; k < 5; k++) {
    release();
    await Bun.sleep(5);
  }
  const t = await c.transition(0);
  expect(t.modifications.filter((m) => m.type === "QueryUpdated")).toHaveLength(100);
  expect(most()).toBe(UPDATE_QUERY_CONCURRENCY);
});

test("a query whose store read fails transiently is retried: the client sees only its value", async () => {
  const { url, sync, fail } = await setup();
  const c = await v1Client(url);
  fail.reads = 3;
  c.modify([add(1, "m:read")]);
  await c.transition(0);
  expect(history(c.transitions(), 1)).toEqual([1]);
  expect(sync.stats.retries).toBe(3);
  expect(c.ws.readyState).toBe(WebSocket.OPEN);
});

test("a rerun after a commit is retried the same way", async () => {
  const { url, sync, fail, functions } = await setup();
  const c = await v1Client(url);
  c.modify([add(1, "m:read")]);
  await c.transition(0);
  await functions.runMutation("m:bump", {});
  fail.reads = 2;
  // The mutation's own reads come first: the next failing reads are the rerun's.
  await c.until(() => history(c.transitions(), 1).at(-1) === 2);
  expect(history(c.transitions(), 1)).toEqual([1, 2]);
  expect(sync.stats.retries).toBeGreaterThan(0);
});

test("a store error that is not transient still closes the connection with 1011", async () => {
  const { url, sync, fail } = await setup();
  const c = await v1Client(url);
  fail.error = () => new Error("disk read failed");
  fail.reads = 1;
  c.modify([add(1, "m:read")]);
  const e = await c.closed;
  expect(e.code).toBe(1011);
  expect(sync.stats.retries).toBe(0);
});

test("retries stop when the connection closes", async () => {
  const { url, sync, fail } = await setup();
  const c = await v1Client(url);
  fail.reads = Number.POSITIVE_INFINITY;
  c.modify([add(1, "m:read")]);
  await c.until(() => sync.stats.retries >= 2);
  c.ws.close();
  await c.closed;
  await Bun.sleep(50);
  const after = sync.stats.retries;
  await Bun.sleep(200);
  expect(sync.stats.retries).toBe(after);
  fail.reads = 0;
});

test("an update whose ts left the write log's retention starts again at a newer ts", async () => {
  const { url, fail } = await setup();
  const c = await v1Client(url);
  fail.error = () => new OutOfRetentionError(1, 2);
  fail.reads = 1;
  c.modify([add(1, "m:read")]);
  await c.transition(0);
  expect(history(c.transitions(), 1)).toEqual([1]);
  expect(c.ws.readyState).toBe(WebSocket.OPEN);
});

// The write throughput limit (STUDY-78), as Convex's MAX_BYTES_WRITTEN_PER_SECOND (4 MiB per 1 s): every
// commit counts; an app's mutation checks it before each attempt, is retried within the OCC budget, then
// fails with `TooManyWrites` (HTTP 429, sync close 1013); scheduled mutations and crons wait; imports wait.
import { afterEach, describe, expect, test } from "bun:test";
import {
  defineSchema,
  defineTable,
  Engine,
  formatByteCount,
  formatWindow,
  TooManyWritesError,
  WriteThroughputLimiter,
} from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { Functions, mutation, query } from "../src/functions.ts";
import { ScheduledJobExecutor } from "../src/scheduler.ts";
import { createServer } from "../src/server.ts";
import { add, syncUrl, v1Client } from "./v1-client.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

const until = async (cond: () => boolean | Promise<boolean>, what: string, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await Bun.sleep(5);
  }
};

describe("the limiter (Convex's write_throughput_limiter tests)", () => {
  const W = 1_000_000; // the window, in µs
  test("allows writes under the limit, blocks writes over it", () => {
    const under = new WriteThroughputLimiter({ maxBytesPerSecond: 1000, windowMs: 1000 });
    under.record(10, 999);
    expect(under.allows(20)).toBe(true);
    under.record(30, 1);
    expect(under.allows(40)).toBe(true); // exactly the limit
    under.record(50, 1);
    expect(under.allows(60)).toBe(false);
  });

  test("evicts old writes when it records", () => {
    const l = new WriteThroughputLimiter({ maxBytesPerSecond: 1000, windowMs: 1000 });
    l.record(0, 1001);
    expect(l.allows(10)).toBe(false);
    l.record(W + 1000, 100);
    expect(l.allows(W + 1000)).toBe(true);
  });

  test("passes once the window ends, without new writes", () => {
    const l = new WriteThroughputLimiter({ maxBytesPerSecond: 1000, windowMs: 1000 });
    l.record(0, 1001);
    expect(l.allows(W)).toBe(false); // the window includes its edge
    expect(l.allows(W + 1)).toBe(true);
  });

  test("accumulates the writes in the window", () => {
    const l = new WriteThroughputLimiter({ maxBytesPerSecond: 1000, windowMs: 1000 });
    l.record(0, 500);
    l.record(100_000, 501);
    expect(l.allows(200_000)).toBe(false);
  });

  test("a window other than 1 s scales the limit", () => {
    const l = new WriteThroughputLimiter({ maxBytesPerSecond: 1000, windowMs: 500 });
    l.record(0, 501);
    expect(l.allows(1)).toBe(false);
  });

  test("Convex's defaults and message", () => {
    const l = new WriteThroughputLimiter();
    expect([l.maxBytesPerSecond, l.windowMs]).toEqual([4 * 1024 * 1024, 1000]);
    expect(new TooManyWritesError(4 * 1024 * 1024, 1000).message).toBe(
      "Too many writes per second. Your deployment is limited to 4 MiB bytes written per 1 second. Reduce your write rate or set MAX_BYTES_WRITTEN_PER_SECOND to raise the limit.",
    );
    expect(new TooManyWritesError(1, 1).code).toBe("TooManyWrites");
  });

  test("Convex's format_bytes and format_duration", () => {
    expect([0, 1000, 1024, 1534, 4_718_592, 8_388_608, 2 ** 30, 1e9].map(formatByteCount)).toEqual([
      "0 bytes",
      "1 KB",
      "1 KiB",
      "1534 bytes",
      "4.5 MiB",
      "8 MiB",
      "1 GiB",
      "1 GB",
    ]);
    expect([0, 500, 1000, 1500, 2000, 60_000].map(formatWindow)).toEqual([
      "0ms",
      "500ms",
      "1 second",
      "1.5 seconds",
      "2 seconds",
      "60 seconds",
    ]);
  });
});

const SECRET = "57".repeat(32);
const NAME = "write-throughput-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });

async function setup(o: { maxBytesPerSecond: number; windowMs: number; backoffMs?: [number, number] }) {
  const [initial, max] = o.backoffMs ?? [1, 2];
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    {
      writeThroughput: { maxBytesPerSecond: o.maxBytesPerSecond, windowMs: o.windowMs },
      occInitialBackoffMs: initial,
      occMaxBackoffMs: max,
      instanceName: NAME,
      instanceSecret: SECRET,
    },
  ).init();
  const functions = new Functions(engine).register("m", {
    write: mutation(async ({ db }, { bytes }: { bytes: number }) => db.insert("items", { s: "x".repeat(bytes) })),
    count: query(async ({ db }) => (await db.query("items").collect()).length),
    later: mutation(({ scheduler }) => scheduler.runAfter(50, "m:write" as never, { bytes: 10 } as never)),
    job: query(async ({ db }, { id }: { id: string }) => db.system.get(id as never)),
  });
  /** A big write the limit does not gate (a system writer): it still counts. */
  const fill = (bytes: number) => engine.mutation((db) => db.insert("items", { s: "y".repeat(bytes) }));
  return { engine, functions, fill };
}

describe("mutations", () => {
  test("refused past the limit after the OCC retry budget, with TooManyWrites; system writers are not gated", async () => {
    // The engine's own start wrote about 35 KB: under 100 KB, so the first write is allowed.
    const { engine, functions, fill } = await setup({ maxBytesPerSecond: 100_000, windowMs: 1000 });
    await functions.runMutation("m:write", { bytes: 200_000 }); // the transaction's own bytes do not count
    const e = (await functions.runMutation("m:write", { bytes: 1 }).catch((x) => x)) as TooManyWritesError;
    expect(e).toBeInstanceOf(TooManyWritesError);
    expect(e.message).toBe(
      "Too many writes per second. Your deployment is limited to 100 KB bytes written per 1 second. Reduce your write rate or set MAX_BYTES_WRITTEN_PER_SECOND to raise the limit.",
    );
    expect(engine.stats.writeThroughputRetries).toBe(4);
    await fill(10); // not gated
    expect(await functions.runQuery("m:count", {})).toBe(2);
  });

  test("a refused attempt is retried with backoff and succeeds once the window has passed", async () => {
    const { engine, functions, fill } = await setup({
      maxBytesPerSecond: 1_000_000,
      windowMs: 20,
      backoffMs: [50, 200],
    });
    await fill(100_000);
    await functions.runMutation("m:write", { bytes: 1 });
    expect(engine.stats.writeThroughputRetries).toBeGreaterThan(0);
  });

  test("the HTTP API answers 429 TooManyWrites; the sync protocol closes with 1013 TooManyWrites", async () => {
    const { engine, functions, fill } = await setup({ maxBytesPerSecond: 100_000, windowMs: 1000 });
    const s = createServer({ engine, functions, port: 0 });
    stops.push(() => s.stop());
    await fill(200_000);
    const res = await fetch(`http://127.0.0.1:${s.server.port}/api/mutation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "m:write", args: { bytes: 1 } }),
    });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code: string }).code).toBe("TooManyWrites");
    const c = await v1Client(syncUrl(s.server.port));
    stops.push(() => c.ws.close());
    c.modify([add(1, "m:count")]);
    await c.transition(0);
    c.mutate(1, "m:write", { bytes: 1 });
    const closed = await c.closed;
    expect([closed.code, closed.reason]).toEqual([1013, "TooManyWrites"]);
  });

  test("a scheduled mutation stays pending while over the limit, then runs", async () => {
    const { engine, functions, fill } = await setup({ maxBytesPerSecond: 1_000_000, windowMs: 300 });
    const executor = new ScheduledJobExecutor(engine, functions, { occInitialBackoffMs: 5, occMaxBackoffMs: 20 });
    executor.start();
    stops.push(() => executor.stop());
    const id = (await functions.runMutation("m:later", {})) as string; // under the limit
    await fill(600_000);
    const kind = async () => ((await functions.runQuery("m:job", { id })) as { state: { kind: string } }).state.kind;
    // Due at 50 ms, it cannot have run by 150 ms: its every attempt is refused until the window has passed.
    await Bun.sleep(150);
    expect(await kind()).toBe("pending");
    await until(async () => (await kind()) === "success", "the job ran");
  });
});

test("an import waits for the limit, then writes", async () => {
  const { engine, functions, fill } = await setup({ maxBytesPerSecond: 1_000_000, windowMs: 300 });
  const s = createServer({ engine, functions, port: 0 });
  stops.push(() => s.stop());
  await fill(600_000);
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${s.server.port}/api/import?format=jsonLines&tableName=imported`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bunvex ${KEY}` },
    body: '{"a":1}\n{"a":2}\n',
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ numWritten: 2 });
  // The fill's window had to pass first (less a little: it began before the request).
  expect(performance.now() - t0).toBeGreaterThan(150);
});

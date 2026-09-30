import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { nextUp, outsideExecution, seededRandom, wallClock } from "../src/determinism.ts";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { type Doc, defineSchema, defineTable } from "../src/schema.ts";

async function engine() {
  const schema = defineSchema({ items: defineTable(v.any()) });
  return new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
}
// A slow engine-side step (like a persistence round trip), which runs outside the execution.
const tick = () => outsideExecution(() => new Promise((r) => setTimeout(r, 5)));

describe("deterministic execution", () => {
  test("time is frozen for the whole execution, in every form", async () => {
    const e = await engine();
    const before = wallClock();
    const seen = await e.query(async () => {
      const a = Date.now();
      await tick();
      // biome-ignore lint/complexity/useDateNow: `new Date()` is one of the forms under test
      return { a, b: Date.now(), date: new Date().getTime(), str: Date(), perf: new Date(0).getTime() };
    });
    expect(seen.a).toBe(seen.b);
    expect(seen.date).toBe(seen.a);
    expect(seen.str).toBe(new Date(seen.a).toString());
    expect(seen.perf).toBe(0); // an explicit argument is untouched
    expect(seen.a).toBeGreaterThanOrEqual(Math.floor(before));
    await tick();
    expect(Date.now()).toBeGreaterThan(seen.a); // outside an execution the clock runs
  });

  test("concurrent executions each keep their own frozen time", async () => {
    const e = await engine();
    const slow = e.query(async () => {
      const t = Date.now();
      await tick();
      await tick();
      return [t, Date.now()];
    });
    await tick();
    const fast = e.query(() => Date.now());
    const [[t0, t1], t2] = await Promise.all([slow, fast]);
    expect(t1).toBe(t0);
    expect(t2).toBeGreaterThan(t0);
  });

  test("Math.random is seeded per execution; a seed replays its sequence", async () => {
    const e = await engine();
    const run = () => e.query(() => [Math.random(), Math.random(), Math.random()]);
    const [x, y] = [await run(), await run()];
    expect(x).not.toEqual(y);
    for (const v of x) expect(v >= 0 && v < 1).toBe(true);
    const seed = new Uint32Array([1, 2, 3, 4]);
    const [r1, r2] = [seededRandom(seed), seededRandom(seed)];
    for (let i = 0; i < 100; i++) expect(r1()).toBe(r2());
  });

  test("fetch and crypto.getRandomValues are refused in queries and mutations, allowed outside", async () => {
    const e = await engine();
    await expect(e.query(() => fetch("http://127.0.0.1:1/"))).rejects.toThrow("Can't use fetch() in queries");
    await expect(e.mutation(() => crypto.getRandomValues(new Uint8Array(4)))).rejects.toThrow(
      "Can't use crypto.getRandomValues() in mutations",
    );
    await expect(e.query(() => setTimeout(() => {}, 1))).rejects.toThrow("Can't use setTimeout() in queries");
    await expect(e.mutation(() => setInterval(() => {}, 1))).rejects.toThrow("Can't use setInterval() in mutations");
    expect(crypto.getRandomValues(new Uint8Array(4)).length).toBe(4);
  });

  test("engine work inside an execution (persistence calls) sees the real globals", async () => {
    const e = await engine();
    const seen = await e.mutation(async () => {
      const frozen = Date.now();
      await tick();
      return outsideExecution(async () => {
        crypto.getRandomValues(new Uint8Array(4)); // what the MongoDB driver does for its sessions
        await new Promise((r) => setTimeout(r, 5));
        return { frozen, real: Date.now() };
      });
    });
    expect(seen.real).toBeGreaterThan(seen.frozen);
  });

  test("Date keeps working as a class", async () => {
    const e = await engine();
    const seen = await e.query(() => ({
      inst: new Date() instanceof Date,
      utc: Date.UTC(2020, 0, 1),
      parse: Date.parse("2020-01-01T00:00:00Z"),
    }));
    expect(seen).toEqual({ inst: true, utc: 1577836800000, parse: 1577836800000 });
  });

  test("inserts get strictly increasing creation times, not before Date.now(), in insert order", async () => {
    const e = await engine();
    const now = await e.mutation(async (db) => {
      for (let i = 0; i < 50; i++) await db.insert("items", { i });
      return Date.now();
    });
    const docs = await e.query((db) => db.query("items").collect());
    expect(docs.map((d: Doc) => d.i)).toEqual([...Array(50).keys()]);
    for (let i = 1; i < docs.length; i++) expect(docs[i]._creationTime).toBeGreaterThan(docs[i - 1]._creationTime);
    expect(docs[0]._creationTime).toBeGreaterThanOrEqual(now);
  });

  test("nextUp returns the next double", () => {
    expect(nextUp(1)).toBe(1 + Number.EPSILON);
    const x = 1_790_000_000_000.5;
    expect(nextUp(x)).toBeGreaterThan(x);
    expect((x + nextUp(x)) / 2 === x || (x + nextUp(x)) / 2 === nextUp(x)).toBe(true);
  });
  test("performance.now() is fixed in a query, at the execution's start (0.1 ms steps)", async () => {
    const e = await engine();
    const seen = await e.query(async () => {
      const a = performance.now();
      await tick();
      await tick();
      return { a, b: performance.now(), date: Date.now() };
    });
    expect(seen.b).toBe(seen.a);
    expect(Math.abs(seen.a * 10 - Math.round(seen.a * 10))).toBeLessThan(1e-6); // a multiple of 0.1 ms
    // the same instant as the frozen Date.now(), on performance's own origin
    expect(Math.abs(performance.timeOrigin + seen.a - seen.date)).toBeLessThan(1.1);
    expect(performance.now()).toBeGreaterThan(seen.a); // outside an execution the clock runs
  });

  test("performance.now() counts up in a mutation, from its start", async () => {
    const e = await engine();
    const outsideBefore = performance.now();
    const seen = await e.mutation(async () => {
      const a = performance.now();
      await tick();
      await tick();
      return { a, b: performance.now(), date: Date.now() };
    });
    expect(seen.b - seen.a).toBeGreaterThanOrEqual(9); // two 5 ms ticks elapsed
    expect(seen.a).toBeGreaterThanOrEqual(Math.floor(outsideBefore * 10) / 10);
    expect(Math.abs(performance.timeOrigin + seen.a - seen.date)).toBeLessThan(1.1);
    expect(Math.abs(seen.b * 10 - Math.round(seen.b * 10))).toBeLessThan(1e-6);
  });
});

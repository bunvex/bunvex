// The user execution limit (STUDY-41 PR 2), as Convex's DATABASE_UDF_USER_TIMEOUT (1 s): a query's or
// mutation's own time, not the time it awaits the store; checked at store calls and at the end (N5); not
// catchable; a nested call has its own budget, the caller's clock paused; the system budget (15 s).
import { expect, test } from "bun:test";
import { defineSchema, defineTable, Engine, formatDuration } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { Functions, mutation, query } from "../src/functions.ts";

/** Busy for `ms` of real time (Date.now and performance.now are frozen inside a function). */
const busy = (ms: number) => {
  const end = Bun.nanoseconds() + ms * 1e6;
  while (Bun.nanoseconds() < end) {}
};

async function setup(o: { userMs?: number; systemMs?: number; storeDelayMs?: number } = {}) {
  const persistence = await MemoryPersistence.open(null, { durable: false });
  const engine = await new Engine(defineSchema({ items: defineTable(v.any()) }), persistence).init();
  const fns = new Functions(engine).register("m", {
    busyBetweenReads: query(async ({ db }, { ms }: { ms: number }) => {
      await db.query("items").collect();
      busy(ms);
      return (await db.query("items").collect()).length;
    }),
    busyThenWrite: mutation(async ({ db }, { ms }: { ms: number }) => {
      busy(ms);
      await db.insert("items", { n: 1 });
      await db.query("items").collect();
    }),
    manyReads: query(async ({ db }, { n }: { n: number }) => {
      let total = 0;
      for (let i = 0; i < n; i++) total += (await db.query("items").collect()).length;
      return total;
    }),
    catches: query(async ({ db }, { ms }: { ms: number }) => {
      busy(ms);
      try {
        await db.query("items").collect();
      } catch {
        return "caught";
      }
    }),
    catchesThenThrows: query(async ({ db }, { ms }: { ms: number }) => {
      busy(ms);
      try {
        await db.query("items").collect();
      } catch {
        throw new Error("my own error");
      }
    }),
    busyEnd: query(async (_, { ms }: { ms: number }) => {
      busy(ms);
      return "done";
    }),
    parent: query(async ({ runQuery }, { mine, theirs }: { mine: number; theirs: number }) => {
      busy(mine);
      try {
        await runQuery("m:busyEnd", { ms: theirs });
      } catch (e) {
        return (e as Error).message;
      }
      busy(mine);
      return "both done";
    }),
  });
  if (o.userMs !== undefined) fns.userTimeoutMs = o.userMs;
  if (o.systemMs !== undefined) fns.systemTimeoutMs = o.systemMs;
  if (o.storeDelayMs) {
    const p = persistence as unknown as { scan: (...a: unknown[]) => unknown };
    const scan = p.scan.bind(persistence);
    p.scan = async (...a: unknown[]) => {
      await Bun.sleep(o.storeDelayMs!);
      return scan(...a);
    };
    const s2 = persistence as unknown as { scanDocs?: (...a: unknown[]) => unknown };
    if (s2.scanDocs) {
      const sd = s2.scanDocs.bind(persistence);
      s2.scanDocs = async (...a: unknown[]) => {
        await Bun.sleep(o.storeDelayMs!);
        return sd(...a);
      };
    }
  }
  return { engine, fns };
}

test("over the limit between store calls: Convex's message; a mutation commits nothing", async () => {
  const { engine, fns } = await setup({ userMs: 50 });
  expect(await fns.runQuery("m:busyBetweenReads", { ms: 5 })).toBe(0);
  await expect(fns.runQuery("m:busyBetweenReads", { ms: 80 })).rejects.toThrow(
    "Function execution timed out (maximum duration: 50ms)",
  );
  await expect(fns.runMutation("m:busyThenWrite", { ms: 80 })).rejects.toThrow("Function execution timed out");
  expect(await fns.runQuery("m:busyBetweenReads", { ms: 0 })).toBe(0);
  await engine.close();
});

test("checked when the function ends too; catching it does not save the function", async () => {
  const { engine, fns } = await setup({ userMs: 50 });
  await expect(fns.runQuery("m:busyEnd", { ms: 80 })).rejects.toThrow("Function execution timed out");
  await expect(fns.runQuery("m:catches", { ms: 80 })).rejects.toThrow("Function execution timed out");
  // Another error thrown after catching it: still the timeout, as Convex terminates the function.
  await expect(fns.runQuery("m:catchesThenThrows", { ms: 80 })).rejects.toThrow("Function execution timed out");
  await engine.close();
});

test("time awaiting the store does not count; past the system budget, Convex's system timeout", async () => {
  const slow = await setup({ userMs: 50, storeDelayMs: 20 });
  expect(await slow.fns.runQuery("m:manyReads", { n: 6 })).toBe(0); // ~120 ms awaiting the store
  await slow.engine.close();
  const sys = await setup({ userMs: 1000, systemMs: 50, storeDelayMs: 20 });
  await expect(sys.fns.runQuery("m:manyReads", { n: 6 })).rejects.toThrow(
    "Your request timed out performing too many system operations.",
  );
  await sys.engine.close();
});

test("a nested call has its own budget; its timeout is catchable by the caller", async () => {
  const { engine, fns } = await setup({ userMs: 50 });
  // The caller 20 + 20 ms, the nested call 40 ms: 80 ms in all, but neither over its own 50 ms.
  expect(await fns.runQuery("m:parent", { mine: 20, theirs: 40 })).toBe("both done");
  expect(await fns.runQuery("m:parent", { mine: 0, theirs: 80 })).toBe(
    // Convex's `JsError::from_message` display: the message and a newline, no frames.
    "Function execution timed out (maximum duration: 50ms)\n",
  );
  await engine.close();
});

test("Convex's defaults and its duration format", async () => {
  const { engine, fns } = await setup();
  expect([fns.userTimeoutMs, fns.systemTimeoutMs]).toEqual([1000, 15000]);
  expect([formatDuration(1000), formatDuration(1500), formatDuration(50), formatDuration(0.5)]).toEqual([
    "1s",
    "1.5s",
    "50ms",
    "500µs",
  ]);
  await engine.close();
});

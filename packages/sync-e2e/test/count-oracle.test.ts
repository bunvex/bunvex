// `count()` (STUDY-107) against the official package's own database reader: the same calls on Convex's
// `setupReader()` (its syscalls answered here) and on a bunvex transaction must agree on which query stages
// have `count`, what it asks for, and which tables `db.query` and `db.system.query` refuse.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";

/** A query stage of either reader: every method returns another stage, or a promise. */
type Stage = { [method: string]: (...args: unknown[]) => Stage & Promise<unknown> };
type Db = { query(t: string): Stage; system: { query(t: string): Stage } };

const g = globalThis as { Convex?: unknown };
let counted: unknown[] = [];
beforeEach(() => {
  counted = [];
  // The backend side of Convex's reader: `1.0/count` answers 5 and remembers its arguments.
  g.Convex = {
    asyncSyscall: async (op: string, args: string) => {
      if (op !== "1.0/count") throw new Error(`unexpected syscall ${op}`);
      counted.push(JSON.parse(args));
      return JSON.stringify(5);
    },
    syscall: () => {
      throw new Error("unexpected syscall");
    },
  };
});
afterEach(() => {
  delete g.Convex;
});

async function convexReader(): Promise<Db> {
  const server = import.meta.resolve("convex/server");
  const { setupReader } = await import(new URL("./impl/database_impl.js", server).href);
  return setupReader();
}

/** What each probe does on `db`: "function" / "undefined" for a stage's `count`, else the outcome. */
async function probe(db: Db) {
  const kind = (q: unknown) => typeof (q as { count?: unknown }).count;
  const outcome = async (f: () => unknown) => {
    try {
      return { value: await f() };
    } catch {
      return { threw: true }; // the messages are worded differently (not count's: any query)
    }
  };
  return {
    initializer: kind(db.query("items")),
    withIndex: kind(db.query("items").withIndex("by_creation_time")),
    fullTableScan: kind(db.query("items").fullTableScan()),
    order: kind(db.query("items").order("desc")),
    filter: kind(db.query("items").filter((q: unknown) => (q as Stage).eq(1, 1))),
    systemInitializer: kind(db.system.query("_storage")),
    userSystemTable: await outcome(() => db.query("_storage").count()),
    systemUserTable: await outcome(() => db.system.query("items").count()),
  };
}

test("the same stages have count(), and the same tables are refused", async () => {
  const fromConvex = await probe(await convexReader());
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  await engine.summariesReady();
  const fromBunvex = await engine.query((db) => probe(db as unknown as Db));
  await engine.close();
  expect(fromConvex).toMatchObject({
    initializer: "function",
    withIndex: "undefined",
    fullTableScan: "undefined",
    order: "undefined",
    filter: "undefined",
    systemInitializer: "function",
    userSystemTable: { threw: true },
    systemUserTable: { threw: true },
  });
  expect(fromBunvex).toEqual(fromConvex);
  // Convex's count names the table only.
  expect(counted).toEqual([]);
  expect(await (await convexReader()).query("items").count()).toBe(5);
  expect(counted).toEqual([{ table: "items" }]);
});

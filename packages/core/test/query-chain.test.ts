import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { type Doc, defineSchema, defineTable } from "../src/schema.ts";

async function engine() {
  const schema = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) });
  return new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
}

describe("query chaining, unique() and async iteration, as Convex (STUDY-16)", () => {
  test("unique() gives the one document, null for none, and fails for more", async () => {
    const e = await engine();
    const a = await e.mutation((db) => db.insert("items", { n: 1 }));
    const b = await e.mutation((db) => db.insert("items", { n: 1 }));
    await e.mutation((db) => db.insert("items", { n: 2 }));
    const by = (n: number) => (db: any) =>
      db
        .query("items")
        .withIndex("by_n", (q: any) => q.eq("n", n))
        .unique();
    expect((await e.query(by(2)))?.n).toBe(2);
    expect(await e.query(by(3))).toBeNull();
    await expect(e.query(by(1))).rejects.toThrow(
      `unique() query returned more than one result from table items:\n [${a}, ${b}, ...]`,
    );
  });

  test("for await streams every document, filters and own writes included, and can stop early", async () => {
    const e = await engine();
    await e.mutation(async (db) => {
      for (let i = 0; i < 300; i++) await db.insert("items", { n: i });
    });
    const seen = await e.mutation(async (db) => {
      await db.insert("items", { n: 1000 });
      const out: number[] = [];
      for await (const d of db.query("items").filter((q) => q.gte(q.field("n"), 290))) out.push(d.n as number);
      let first = -1;
      for await (const d of db.query("items").withIndex("by_n").order("desc")) {
        first = d.n as number;
        break;
      }
      return { out, first };
    });
    expect(seen.out).toEqual([...Array.from({ length: 10 }, (_, i) => 290 + i), 1000]);
    expect(seen.first).toBe(1000);
  });

  test("a chained query cannot be reused; order at most once; iterate once", async () => {
    const e = await engine();
    await e.mutation((db) => db.insert("items", { n: 1 }));
    await expect(
      e.query(async (db) => {
        const q = db.query("items");
        q.withIndex("by_n");
        return q.collect();
      }),
    ).rejects.toThrow("This query has been chained with another operator and can't be reused.");
    await expect(e.query((db) => db.query("items").order("asc").order("desc").collect())).rejects.toThrow(
      "Queries may only specify order at most once",
    );
    await expect(
      e.query(async (db) => {
        const q = db.query("items");
        for await (const _ of q) break;
        for await (const _ of q) break;
      }),
    ).rejects.toThrow("Iteration can only begin on a query once.");
    expect(await e.query((db) => db.query("items").fullTableScan().collect())).toHaveLength(1);
  });

  // As Convex (DV-06, STUDY-16 D1): `db.query(t)` is a QueryInitializerImpl, and every operator returns a QueryImpl,
  // which has no withIndex / withSearchIndex / fullTableScan. Calling one there is the engine's own TypeError
  // (V8, in Convex: "<expr> is not a function"; JavaScriptCore adds "(In '…', '…' is undefined)").
  test("withIndex, withSearchIndex and fullTableScan exist only before any other operator: a TypeError after", async () => {
    const e = await engine();
    await e.mutation((db) => db.insert("items", { n: 1 }));
    const after: [string, (q: any) => any][] = [
      ["filter", (q) => q.filter((f: any) => f.eq(1, 1))],
      ["order", (q) => q.order("desc")],
      ["limit", (q) => q.limit(5)],
      ["withIndex", (q) => q.withIndex("by_creation_time")],
      ["fullTableScan", (q) => q.fullTableScan()],
    ];
    const initializerOnly: [string, (q: any) => unknown][] = [
      ["withIndex", (q) => q.withIndex("by_n")],
      ["withSearchIndex", (q) => q.withSearchIndex("s", (s: any) => s.search("t", "x"))],
      ["fullTableScan", (q) => q.fullTableScan()],
    ];
    for (const source of ["user", "system"] as const)
      for (const [op, apply] of after)
        for (const [method, call] of initializerOnly) {
          const chained = await e.query(async (db) => {
            const q = source === "user" ? db.query("items") : db.system.query("_storage");
            const next = apply(q);
            expect(typeof next[method], `${source} ${op} then ${method}`).toBe("undefined");
            try {
              call(next);
            } catch (err) {
              return err;
            }
            return null;
          });
          expect(chained, `${source} ${op} then ${method}`).toBeInstanceOf(TypeError);
          expect(String(chained)).toContain(`.${method} is not a function`);
        }
    // The stage before any operator still has all three, and the valid chains run.
    expect(
      await e.query((db) =>
        db
          .query("items")
          .withIndex("by_n")
          .filter((q) => q.eq(1, 1))
          .collect(),
      ),
    ).toHaveLength(1);
    expect(await e.query((db) => db.query("items").fullTableScan().order("desc").take(1))).toHaveLength(1);
    expect(await e.query((db) => db.system.query("_storage").withIndex("by_creation_time").collect())).toEqual([]);
  });

  test("a missing table supports the whole chain and yields nothing", async () => {
    const e = await engine();
    const got = await e.query(async (db) => {
      const rows: Doc[] = [];
      for await (const d of db.query("nope")) rows.push(d);
      return {
        rows,
        collect: await db
          .query("nope")
          .withIndex("by_x")
          .order("desc")
          .filter((q) => q.eq(q.field("a"), 1))
          .collect(),
        unique: await db.query("nope").unique(),
      };
    });
    expect(got).toEqual({ rows: [], collect: [], unique: null });
  });
});

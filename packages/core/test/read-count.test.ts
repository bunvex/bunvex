// Counting reads toward the read limit as Convex counts them (STUDY-161 §16): `ReadCount` (Convex's per-index merged
// `IntervalSet` and `num_intervals`), and the count a transaction keeps for each shape of read.
import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import type { Interval } from "../src/committer.ts";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { ReadCount } from "../src/read-count.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import type { Tx } from "../src/tx.ts";

const k = (...b: number[]) => new Uint8Array(b);
const iv = (index: string, lo: number[], hi: number[]): Interval => ({
  index: index as never,
  lo: k(...lo),
  hi: k(...hi),
});

describe("ReadCount", () => {
  test("disjoint intervals count one each; per index", () => {
    const c = new ReadCount();
    c.direct(iv("a", [1], [2]));
    c.direct(iv("a", [5], [6]));
    c.direct(iv("b", [1], [2]));
    expect(c.count).toBe(3);
  });

  test("the same interval, an overlapping one and an adjacent one merge: nothing more", () => {
    const c = new ReadCount();
    c.direct(iv("a", [1], [3]));
    c.direct(iv("a", [1], [3]));
    c.direct(iv("a", [2], [4]));
    c.direct(iv("a", [4], [5])); // adjacent: [1, 4) then [4, 5)
    expect(c.count).toBe(1);
  });

  test("adjacent on either side: an interval ending where one starts merges too", () => {
    const c = new ReadCount();
    c.direct(iv("a", [5], [6]));
    c.direct(iv("a", [4], [5]));
    c.direct(iv("a", [8], [9]));
    c.direct(iv("a", [6], [8])); // fills the gap exactly: one interval
    expect(c.count).toBe(1);
  });

  test("an interval bridging two merges them: the count goes down", () => {
    const c = new ReadCount();
    c.direct(iv("a", [1], [2]));
    c.direct(iv("a", [3], [4]));
    c.direct(iv("a", [5], [6]));
    expect(c.count).toBe(3);
    c.direct(iv("a", [0], [9]));
    expect(c.count).toBe(1);
  });

  test("an empty interval adds nothing", () => {
    const c = new ReadCount();
    c.direct(iv("a", [3], [3]));
    c.direct(iv("a", [4], [3]));
    expect(c.count).toBe(0);
  });

  test("a derived interval counts nothing itself, but is in the set a later direct read is measured against", () => {
    const c = new ReadCount();
    c.direct(iv("a", [0], [1]));
    c.derived(iv("a", [2], [5]));
    expect(c.count).toBe(1);
    // Convex's arithmetic: the count less the set's size before (2, saturating at 0), plus its size after (2)
    c.direct(iv("a", [3], [4]));
    expect(c.count).toBe(2);
    c.direct(iv("a", [7], [8]));
    expect(c.count).toBe(3);
    // a derived interval on its own index, read back with nothing else counted there: the count does not move
    const d = new ReadCount();
    d.direct(iv("a", [0], [1]));
    d.derived(iv("b", [2], [5]));
    d.direct(iv("b", [3], [4]));
    expect(d.count).toBe(1);
  });

  test("Convex's saturating update: the set's size before is taken off, never below zero", () => {
    const c = new ReadCount();
    // two derived intervals (size 2, count 0), then a direct one bridging them (size 1): 0 − 2 saturates to 0, + 1
    c.derived(iv("a", [1], [2]));
    c.derived(iv("a", [3], [4]));
    c.direct(iv("a", [1], [4]));
    expect(c.count).toBe(1);
  });

  test("constants count as they are", () => {
    const c = new ReadCount();
    c.constant(3);
    c.direct(iv("a", [1], [2]));
    expect(c.count).toBe(4);
  });
});

const schema = defineSchema({
  big: defineTable(v.any()).index("by_i", ["i"]),
  other: defineTable(v.any()),
});

async function setup() {
  const e = await new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
  const ids = await e.mutation(async (db) => {
    const out: string[] = [];
    for (let i = 0; i < 30; i++) out.push(await db.insert("big", { i }));
    return out;
  });
  return { e, ids };
}

// biome-ignore lint/suspicious/noExplicitAny: shapes reach the query builder freely
type Db = Tx & Record<string, any>;
const counted = (db: Tx) => db.usage.databaseQueries;

describe("a transaction's count (the engine's own reads not counted)", () => {
  test("each shape, as Convex counts it", async () => {
    const { e, ids } = await setup();
    const shapes: [string, number, (db: Db) => Promise<unknown>][] = [
      [
        "five gets",
        5,
        async (db) => {
          for (const id of ids.slice(0, 5)) await db.get(id);
        },
      ],
      [
        "a get twice",
        1,
        async (db) => {
          await db.get(ids[0]!);
          await db.get(ids[0]!);
        },
      ],
      [
        "patch a document read",
        1,
        async (db) => {
          await db.get(ids[0]!);
          await db.patch(ids[0]!, { p: 1 });
        },
      ],
      [
        "insert, then get and patch it",
        0,
        async (db) => {
          const id = await db.insert("other", {});
          await db.get(id);
          await db.patch(id, { p: 1 });
        },
      ],
      [
        "two new tables",
        1,
        async (db) => {
          await db.insert("fresh1", {});
          await db.insert("fresh2", {});
        },
      ],
      [
        "first twice",
        1,
        async (db) => {
          await db.query("big").first();
          await db.query("big").first();
        },
      ],
      [
        "adjacent ranges",
        1,
        async (db) => {
          await db
            .query("big")
            .withIndex("by_i", (q: any) => q.gte("i", 1).lt("i", 5))
            .collect();
          await db
            .query("big")
            .withIndex("by_i", (q: any) => q.gte("i", 5).lt("i", 9))
            .collect();
        },
      ],
      [
        "ranges with a gap",
        2,
        async (db) => {
          await db
            .query("big")
            .withIndex("by_i", (q: any) => q.gte("i", 1).lt("i", 5))
            .collect();
          await db
            .query("big")
            .withIndex("by_i", (q: any) => q.gte("i", 6).lt("i", 9))
            .collect();
        },
      ],
      [
        "a missing table",
        0,
        async (db) => {
          await db.query("nope").first();
        },
      ],
      [
        "a count over the gets",
        1,
        async (db) => {
          for (const id of ids.slice(0, 5)) await db.get(id);
          await db.query("big").count();
        },
      ],
      [
        "an iteration that stops early, then a range past it",
        2,
        async (db) => {
          for await (const d of db.query("big").withIndex("by_i")) if ((d.i as number) >= 2) break;
          await db
            .query("big")
            .withIndex("by_i", (q: any) => q.gte("i", 20).lt("i", 25))
            .collect();
        },
      ],
    ];
    for (const [label, want, shape] of shapes)
      await e
        .mutation(async (db) => {
          await shape(db as Db);
          expect({ label, counted: counted(db) }).toEqual({ label, counted: want });
          throw new Error("roll back");
        })
        .catch((err) => {
          if ((err as Error).message !== "roll back") throw err;
        });
  });

  test("the limit: the read past it fails, at that read; the engine's own reads never do", async () => {
    const { e, ids } = await setup();
    const limits = { databaseQueries: 3 };
    await e.mutation(async (db) => {
      Object.assign((db as unknown as { limits: object }).limits, limits);
      for (const id of ids.slice(0, 3)) await db.get(id);
      // again: merged, no failure; the table's metadata reads are the engine's
      await db.get(ids[0]!);
      await db.query("nope").first();
      await expect(db.get(ids[3]!)).rejects.toThrow("Too many reads in a single function execution (limit: 3)");
    });
  });
});

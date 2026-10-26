// What a transaction records for subscriptions and OCC (`Tx.reads`) is the same as before reads were counted as
// Convex counts them (STUDY-161 §16: only the count changed). Each shape's read-set is compared with the one main
// recorded before the change (`fixtures/read-sets.json`, written by this test with `WRITE_READ_SETS=1` on the
// commit before it). Since then each read-set gained one read of all of `_tables`, Convex's table mapping
// (STUDY-187 X22), and each that writes a document the reads of `_schemas.by_state` its schema checks take
// (STUDY-187 X10), and nothing else.
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import type { Tx } from "../src/tx.ts";

const FIXTURE = join(import.meta.dir, "fixtures/read-sets.json");

const schema = defineSchema({
  big: defineTable(v.any()).index("by_i", ["i"]),
  small: defineTable(v.any()).index("by_k", ["k"]).searchIndex("s", { searchField: "t" }),
  other: defineTable(v.any()),
});

// biome-ignore lint/suspicious/noExplicitAny: shapes reach the query builder freely
type Db = Tx & Record<string, any>;
const SHAPES: [string, (db: Db, ids: string[]) => Promise<unknown>][] = [
  [
    "gets",
    async (db, ids) => {
      for (const id of ids.slice(0, 5)) await db.get(id);
    },
  ],
  [
    "a get twice",
    async (db, ids) => {
      await db.get(ids[0]!);
      await db.get(ids[0]!);
    },
  ],
  [
    "patch a document read",
    async (db, ids) => {
      await db.get(ids[0]!);
      await db.patch(ids[0]!, { p: 1 });
    },
  ],
  [
    "insert, then get it",
    async (db) => {
      const id = await db.insert("other", { k: 1 });
      await db.get(id);
    },
  ],
  [
    "a new table",
    async (db) => {
      await db.insert("fresh", { k: 1 });
    },
  ],
  [
    "first",
    async (db) => {
      await db.query("small").first();
    },
  ],
  [
    "first twice",
    async (db) => {
      await db.query("small").first();
      await db.query("small").first();
    },
  ],
  [
    "collect",
    async (db) => {
      await db.query("small").collect();
    },
  ],
  [
    "take",
    async (db) => {
      await db.query("big").take(5);
    },
  ],
  [
    "desc",
    async (db) => {
      await db.query("big").order("desc").first();
    },
  ],
  [
    "iterate, then stop",
    async (db) => {
      for await (const d of db.query("big")) if ((d.i as number) >= 3) break;
    },
  ],
  [
    "eq",
    async (db) => {
      await db
        .query("small")
        .withIndex("by_k", (q: any) => q.eq("k", 3))
        .collect();
    },
  ],
  [
    "adjacent ranges",
    async (db) => {
      await db
        .query("big")
        .withIndex("by_i", (q: any) => q.gte("i", 10).lt("i", 20))
        .collect();
      await db
        .query("big")
        .withIndex("by_i", (q: any) => q.gte("i", 20).lt("i", 30))
        .collect();
    },
  ],
  [
    "a page",
    async (db) => {
      await db.query("small").withIndex("by_k").paginate({ numItems: 5, cursor: null });
    },
  ],
  [
    "a missing table",
    async (db) => {
      await db.query("nope").first();
    },
  ],
  [
    "count",
    async (db, ids) => {
      await db.get(ids[0]!);
      await db.query("big").count();
    },
  ],
  [
    "search",
    async (db) => {
      await db
        .query("small")
        .withSearchIndex("s", (q: any) => q.search("t", "hello"))
        .collect();
    },
  ],
];

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

test("each shape's read-set is the one recorded before the count changed", async () => {
  const e = await new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
  await e.searchReady();
  const ids = await e.mutation(async (db) => {
    const out: string[] = [];
    for (let i = 0; i < 40; i++) out.push(await db.insert("big", { i }));
    for (let i = 0; i < 10; i++) out.push(await db.insert("small", { k: i % 7, t: `hello ${i}` }));
    return out;
  });
  // Ids and creation times differ from run to run: a bound's hex with each id named by its first appearance in the
  // shape and each creation time (a float near now) masked.
  let seen = new Map<string, string>();
  const bound = (b: Uint8Array) =>
    hex(b)
      .replace(/0dc27a[0-9a-f]{12}/g, "<time>")
      .replace(/((?:3[0-9]|6[1-9a-f]|7[0-9a])){31,37}/g, (id) => {
        if (!seen.has(id)) seen.set(id, `<id${seen.size}>`);
        return seen.get(id)!;
      });
  const names = (index: unknown) => {
    for (const t of e.catalog.tables.values())
      for (const ix of [t.byId, ...t.indexes.values()]) if (ix.id === index) return `${t.name}.${ix.name}`;
    return "?";
  };
  const got: Record<string, string[]> = {};
  for (const [label, shape] of SHAPES) {
    // a mutation (rolled back by its error) records what a query does, and the writes' reads
    seen = new Map();
    await e
      .mutation(async (db) => {
        await shape(db as Db, ids);
        got[label] = (db as Db).reads.map((i) => `${names(i.index)} ${bound(i.lo)} ${bound(i.hi)}`);
        throw new Error("roll back");
      })
      .catch(() => {});
  }
  if (process.env.WRITE_READ_SETS) writeFileSync(FIXTURE, `${JSON.stringify(got, null, 2)}\n`);
  expect(got).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
});

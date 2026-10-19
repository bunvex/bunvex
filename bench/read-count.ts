// The read path, before and after counting reads as Convex does (STUDY-161 §16): each shape a function reads with,
// timed in one engine (memory persistence, so the read path and not the store is measured). Run it on main and on the
// change, on an idle machine, and compare the medians:
//
//   bun bench/read-count.ts                          # every shape, 30 rounds each
//   ROUNDS=5 bun bench/read-count.ts                 # a quick look (not a measurement)
//
// The shapes: distinct gets (the count's sorted insert), the same document again (a merge), a scan of 1 000 documents
// with a get per document (a scan settled before each counted read), a collect, index ranges, and a page.
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";

const ROUNDS = Number(process.env.ROUNDS ?? 30);
const DOCS = 4000;

const engine = await new Engine(
  defineSchema({ items: defineTable(v.any()).index("by_i", ["i"]), other: defineTable(v.any()) }),
  await MemoryPersistence.open(null, { durable: false }),
).init();
const ids: string[] = [];
for (let start = 0; start < DOCS; start += 500)
  ids.push(
    ...(await engine.mutation(async (db) => {
      const out: string[] = [];
      for (let i = start; i < start + 500; i++) out.push(await db.insert("items", { i, pad: "x".repeat(40) }));
      return out;
    })),
  );
const others = await engine.mutation(async (db) => {
  const out: string[] = [];
  for (let i = 0; i < 1000; i++) out.push(await db.insert("other", { i }));
  return out;
});

// biome-ignore lint/suspicious/noExplicitAny: shapes reach the query builder freely
type Db = any;
const shapes: [string, (db: Db) => Promise<unknown>][] = [
  [
    "100 distinct gets",
    async (db) => {
      for (const id of ids.slice(0, 100)) await db.get(id);
    },
  ],
  [
    "4 000 distinct gets",
    async (db) => {
      for (const id of ids) await db.get(id);
    },
  ],
  [
    "one document 4 000 times",
    async (db) => {
      for (let i = 0; i < 4000; i++) await db.get(ids[0]);
    },
  ],
  [
    "scan 1 000, a get per document",
    async (db) => {
      let n = 0;
      for await (const _ of db.query("items").withIndex("by_i")) {
        await db.get(others[n]);
        if (++n === 1000) break;
      }
    },
  ],
  [
    "collect 4 000",
    async (db) => {
      await db.query("items").collect();
    },
  ],
  [
    "1 000 index ranges",
    async (db) => {
      for (let i = 0; i < 1000; i++)
        await db
          .query("items")
          .withIndex("by_i", (q: Db) => q.eq("i", i))
          .first();
    },
  ],
  [
    "a page of 100",
    async (db) => {
      await db.query("items").withIndex("by_i").paginate({ numItems: 100, cursor: null });
    },
  ],
];

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
console.log(`read path, ${ROUNDS} rounds per shape (median ms)`);
for (const [label, shape] of shapes) {
  const times: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now();
    await engine.query((db) => shape(db));
    times.push(performance.now() - t0);
  }
  console.log(`${label.padEnd(32)} ${median(times).toFixed(3)}`);
}
await engine.close();

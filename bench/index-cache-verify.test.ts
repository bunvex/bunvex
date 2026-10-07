// STUDY-136: the index cache under a real engine and a real store, every hit verified. Concurrent clients run
// random mutations (inserts, patches that move a document between index ranges, deletes) and random reads
// (`get`, index ranges in both orders with limits, a first page, a whole collect) at the latest snapshot and
// at older ones, through queries and mutations. The cache re-reads persistence on every hit
// (verifyPercent 100, Convex's INDEX_CACHE_VERIFY_PERCENT) and fails the read when the two differ, so a stale
// entry anywhere fails the test. A last case checks the harness itself: a cache that ignores the write log
// is caught.
//   bun test bench/index-cache-verify.test.ts         memory and SQLite; Postgres, MySQL and MongoDB when
//                                                     PG_URL / MYSQL_URL / MONGO_URL are set (scratch databases)
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, defineTable, Engine, IndexCache, type Persistence } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { v } from "@bunvex/values";

const ROUNDS = Number(process.env.INDEX_CACHE_VERIFY_ROUNDS ?? 300);
const CLIENTS = 8;
const GROUPS = 6;

const schema = defineSchema({
  items: defineTable(v.any()).index("by_group", ["group", "n"]),
  others: defineTable(v.any()),
});

type Store = { name: string; open: () => Promise<Persistence>; done?: () => void };
const stores: Store[] = [
  { name: "memory", open: () => MemoryPersistence.open(null, { durable: false }) },
  (() => {
    const dir = mkdtempSync(join(tmpdir(), "bunvex-index-cache-"));
    return {
      name: "sqlite",
      open: async () => new SqlitePersistence(join(dir, "s.db"), { durable: true }),
      done: () => rmSync(dir, { recursive: true, force: true }),
    };
  })(),
];
for (const [name, url] of [
  ["postgres", "PG_URL"],
  ["mysql", "MYSQL_URL"],
  ["mongodb", "MONGO_URL"],
] as const)
  if (process.env[url]) stores.push({ name, open: async () => (await import(`./drivers/${name}.ts`)).open(true) });

const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
const rand = (n: number) => Math.floor(Math.random() * n);

/** Random reads: everything a transaction reads goes through `get` or `scan`. */
async function readSome(db: any, ids: readonly string[]) {
  const out: unknown[] = [];
  let paginated = false; // one paginated query per function
  for (let i = 0; i < 3; i++) {
    const g = rand(GROUPS);
    switch (rand(5)) {
      case 0:
        out.push(await db.get(pick(ids)));
        break;
      case 1:
        out.push(
          await db
            .query("items")
            .withIndex("by_group", (q: any) => q.eq("group", g))
            .order(pick(["asc", "desc"]))
            .take(1 + rand(4)),
        );
        break;
      case 2:
        out.push(
          await db
            .query("items")
            .withIndex("by_group", (q: any) => q.eq("group", g).gt("n", rand(20)))
            .first(),
        );
        break;
      case 3:
        if (paginated) break;
        paginated = true;
        out.push(await db.query("items").paginate({ numItems: 1 + rand(5), cursor: null }));
        break;
      default:
        out.push((await db.query("items").collect()).length);
    }
  }
  return out;
}

/** `failures`: count failed operations instead of failing (the harness check, whose reads are meant to fail). */
async function workload(engine: Engine, failures?: { n: number }) {
  const ids: string[] = await engine.mutation(async (db) => {
    const out: string[] = [];
    for (let i = 0; i < 30; i++) out.push(await db.insert("items", { group: i % GROUPS, n: i }));
    return out;
  });
  const past: bigint[] = [engine.committer.visibleTs];
  const occ = { n: 0 };
  await Promise.all(
    Array.from({ length: CLIENTS }, async () => {
      for (let r = 0; r < ROUNDS; r++)
        try {
          await step(r);
        } catch (e) {
          if (!failures) throw e;
          failures.n++;
        }
      async function step(r: number) {
        const op = rand(10);
        if (op < 4) {
          // Reads at the latest snapshot or an older one (still in the write log: the last few commits).
          const at = op === 0 ? pick(past.slice(-8)) : undefined;
          await engine.query((db) => readSome(db, ids), undefined, undefined, undefined, at);
        } else if (op < 9) {
          // Under contention a mutation can exhaust its OCC retries (a slow store makes it likelier): that is
          // the engine's answer, not the cache's, and is counted rather than failed.
          await engine
            .mutation(async (db) => {
              await readSome(db, ids); // mutations read through the cache too
              const id = pick(ids);
              const doc = await db.get(id as never);
              const k = rand(4);
              if (k === 0) ids.push(await db.insert("items", { group: rand(GROUPS), n: rand(20) }));
              else if (k === 1 && doc) await db.patch(id as never, { group: rand(GROUPS), n: rand(20) });
              else if (k === 2 && doc && ids.length > 10) await db.delete(id as never);
              else await db.insert("others", { at: r });
            })
            .catch((e) => {
              if ((e as { code?: string }).code !== "OptimisticConcurrencyControlFailure") throw e;
              occ.n++;
            });
          past.push(engine.committer.visibleTs);
        } else await new Promise((r) => setTimeout(r, rand(3)));
      }
    }),
  );
  return occ.n;
}

for (const store of stores)
  test(
    `index cache, every hit verified: ${store.name}`,
    async () => {
      const engine = await new Engine(schema, await store.open(), { indexCache: { verifyPercent: 100 } }).init();
      try {
        await workload(engine);
        const s = engine.indexCache!.stats;
        expect(s.mismatches).toBe(0);
        expect(s.hits).toBeGreaterThan(100); // the cache was exercised
        expect(s.verified).toBe(s.hits);
        expect(s.misses.stale).toBeGreaterThan(0); // and writes made entries stale
      } finally {
        await engine.close();
        store.done?.();
      }
    },
    { timeout: 300_000 },
  );

test("the harness catches a cache that ignores the write log", async () => {
  const engine = await new Engine(schema, await stores[0]!.open(), { indexCache: false }).init();
  const committer = engine.committer;
  // Every entry claimed unchanged since it was read: the stale cache the protocol must never produce.
  const broken = new IndexCache(
    {
      get visibleTs() {
        return committer.visibleTs;
      },
      changedBetween: () => false,
    },
    1 << 24,
    100,
  );
  (engine as unknown as { indexCache: IndexCache }).indexCache = broken;
  const failures = { n: 0 };
  const err = console.error;
  console.error = () => {};
  try {
    await workload(engine, failures);
  } finally {
    console.error = err;
    await engine.close();
  }
  expect(broken.stats.mismatches).toBeGreaterThan(0);
  expect(failures.n).toBeGreaterThanOrEqual(broken.stats.mismatches);
});

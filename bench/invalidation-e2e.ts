// DV-64 end to end, in process (memory driver): commits/s while N subscriptions and N cached queries are
// live. Each subscription and cached query reads one owner's items (an index prefix range); each commit
// patches one item of one random owner, so it invalidates about one subscription and one cache entry.
//   bun bench/invalidation-e2e.ts            Env: N (default 10000), C (concurrent writers, default 1), SECS (default 5)
import { defineSchema, defineTable, Engine, Subscriptions } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";

const N = Number(process.env.N ?? 10_000);
// Items: one per owner, at least one so the writer has something to patch.
const M = Math.max(N, 1);
const C = Number(process.env.C ?? 1);
const SECS = Number(process.env.SECS ?? 5);

const engine = await new Engine(
  defineSchema({ items: defineTable(v.any()).index("by_owner", ["owner"]) }),
  await MemoryPersistence.open(null, { durable: false }),
  { cacheMax: N * 2 },
).init();
const ids: string[] = [];
for (let o = 0; o < M; o += 500)
  ids.push(
    ...(await engine.mutation(async (db) => {
      const out: string[] = [];
      for (let i = o; i < Math.min(M, o + 500); i++) out.push(await db.insert("items", { owner: i, n: 0 }));
      return out;
    })),
  );
const byOwner = (owner: number) => (db: any) =>
  db
    .query("items")
    .withIndex("by_owner", (q: any) => q.eq("owner", owner))
    .collect();

let published = 0;
const subs = new Subscriptions(engine, () => published++);
const t0 = performance.now();
for (let o = 0; o < N; o++) await subs.subscribe(`sub:${o}`, byOwner(o));
for (let o = 0; o < N; o++) await engine.query(byOwner(o), `cache:${o}`);
const setupMs = performance.now() - t0;

let commits = 0;
const lat: number[] = [];
const end = performance.now() + SECS * 1000;
await Promise.all(
  Array.from({ length: C }, async () => {
    while (performance.now() < end) {
      const owner = Math.floor(Math.random() * M);
      const s = performance.now();
      await engine.mutation((db) => db.patch("items", ids[owner] as any, { n: commits }));
      lat.push(performance.now() - s);
      commits++;
    }
  }),
);
await new Promise((r) => setTimeout(r, 50));
const q = (p: number) => {
  const s = [...lat].sort((a, b) => a - b);
  return Number((s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0).toFixed(3));
};
console.log(
  JSON.stringify({
    N,
    C,
    secs: SECS,
    setupMs: Math.round(setupMs),
    commitsPerSec: Math.round(commits / SECS),
    p50ms: q(0.5),
    p99ms: q(0.99),
    reruns: subs.stats.reruns,
    published,
    cacheSize: engine.stats,
  }),
);
process.exit(0);

// Index backfill measurements (STUDY-29 §7): how long `Engine.init()` takes on a store whose largest table
// gets a new index, how long until the index is ready, and commit throughput during the backfill vs idle.
//   bun bench/backfill.ts seed <memory|sqlite|postgres> <path or URL> <documents>
//   bun bench/backfill.ts run  <memory|sqlite|postgres> <path or URL> [unlimited]
// `seed` writes the documents with the schema WITHOUT the index; `run` opens the store with it (use a copy
// of the seeded store per run). Runs on bunvex before background backfill too (it has no indexesReady()).
import { defineSchema, defineTable, Engine, type Persistence } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { v } from "@bunvex/values";

const [mode, driver, where, arg] = process.argv.slice(2);
const events = defineTable(v.any());
const plain = defineSchema({ items: defineTable(v.any()), events });
const indexed = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]), events });

async function openStore(): Promise<Persistence> {
  if (driver === "memory") return MemoryPersistence.open(where, { durable: true });
  if (driver === "sqlite") return new SqlitePersistence(where, { durable: true });
  const { PostgresPersistence } = await import("@bunvex/persistence/postgres");
  return PostgresPersistence.open(where);
}

/** Commits per second from 16 writers inserting small documents for `ms`. */
async function throughput(e: Engine, ms: number) {
  let n = 0;
  const end = performance.now() + ms;
  await Promise.all(
    Array.from({ length: 16 }, async (_, w) => {
      while (performance.now() < end) {
        await e.mutation((db) => db.insert("events", { w, at: n }));
        n++;
      }
    }),
  );
  return Math.round(n / (ms / 1000));
}

const rss = () => Math.round(process.memoryUsage().rss / 2 ** 20);

if (mode === "seed") {
  const total = Number(arg);
  const e = await new Engine(plain, await openStore()).init();
  for (let i = 0; i < total; i += 1000)
    await e.mutation(async (db) => {
      for (let j = i; j < Math.min(total, i + 1000); j++)
        await db.insert("items", { n: j % 1000, pad: "x".repeat(40) });
    });
  await e.close();
  console.log(JSON.stringify({ seeded: total }));
} else {
  const t0 = performance.now();
  const p = await openStore();
  const opened = performance.now();
  const e = new Engine(indexed, p, { indexBackfill: arg === "unlimited" ? { chunkRate: null } : {} });
  await e.init();
  const inited = performance.now();
  const ready = (e as { indexesReady?: () => Promise<void> }).indexesReady?.bind(e);
  // During the backfill: throughput for 2 s (or until it ends), while it runs.
  let during: number | null = null;
  if (ready) {
    let done = false;
    const r = ready().then(() => {
      done = true;
    });
    const t = performance.now();
    let n = 0;
    await Promise.all(
      Array.from({ length: 16 }, async (_, w) => {
        while (!done && performance.now() - t < 2000) {
          await e.mutation((db) => db.insert("events", { w, at: n }));
          n++;
        }
      }),
    );
    during = Math.round(n / ((performance.now() - t) / 1000));
    await r;
  }
  const readyAt = performance.now();
  const idle = await throughput(e, 2000);
  const stats = (e as { indexWorker?: { stats: unknown } | null }).indexWorker?.stats ?? null;
  console.log(
    JSON.stringify({
      driver,
      openMs: Math.round(opened - t0),
      initMs: Math.round(inited - opened),
      readyMs: Math.round(readyAt - opened),
      commitsPerSecDuringBackfill: during,
      commitsPerSecIdle: idle,
      rssMiB: rss(),
      stats,
    }),
  );
  await e.close();
}

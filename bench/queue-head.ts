// Queue-head scenario (STUDY-06 §9, DV-57): W workers loop { first() on a queue; delete it } while P producers
// loop { insert at the tail }, for SECS seconds, with Convex's retry budget. A pop conflicts with another pop
// of the same head, and — when a scan's read-set is its whole range — with every concurrent append too.
// Then, the query cache: a cached first() is re-read after each of N appends; reports how many re-ran.
//   bun bench/queue-head.ts [memory|sqlite]   Env: W (default 4), P (default 4), SECS (default 5), N (default 1000)
import { mkdirSync, rmSync } from "node:fs";
import { defineSchema, defineTable, Engine, type Persistence } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { v } from "@bunvex/values";

const kind = process.argv[2] ?? "memory";
const W = Number(process.env.W ?? 4);
const P = Number(process.env.P ?? 4);
const SECS = Number(process.env.SECS ?? 5);
const N = Number(process.env.N ?? 1000);

async function open(): Promise<Persistence> {
  if (kind !== "sqlite") return MemoryPersistence.open(null, { durable: false });
  const dir = process.env.DIR ?? `${import.meta.dir}/../.data/queue-head`;
  mkdirSync(dir, { recursive: true });
  for (const s of ["", "-wal", "-shm"]) rmSync(`${dir}/db${s}`, { force: true });
  return new SqlitePersistence(`${dir}/db`, { durable: true });
}

const engine = await new Engine(defineSchema({ jobs: defineTable(v.any()) }), await open()).init();
await engine.mutation(async (db) => {
  for (let i = 0; i < 100; i++) await db.insert("jobs", { i });
});

let popAttempts = 0;
let pops = 0;
let empty = 0;
let popFailed = 0;
let inserts = 0;
const end = performance.now() + SECS * 1000;
const workers = Array.from({ length: W }, async () => {
  while (performance.now() < end) {
    try {
      const got = await engine.mutation(async (db) => {
        popAttempts++;
        const head = await db.query("jobs").first();
        if (head) await db.delete("jobs", head._id);
        return head !== null;
      }, "jobs:pop");
      if (got) pops++;
      else empty++;
    } catch {
      popFailed++;
    }
  }
});
const producers = Array.from({ length: P }, async () => {
  while (performance.now() < end) {
    await engine.mutation((db) => db.insert("jobs", { at: Date.now() }), "jobs:push");
    inserts++;
  }
});
await Promise.all([...workers, ...producers]);
const retries = engine.stats.retries;

// Re-runs per append of a cached first() (the query cache and the sync hub share the read-set index).
const head = () => engine.query((db) => db.query("jobs").first(), "head");
await head();
const misses = engine.stats.cacheMisses;
for (let i = 0; i < N; i++) {
  await engine.mutation((db) => db.insert("jobs", { tail: i }));
  await head();
}

console.log(
  JSON.stringify({
    kind,
    W,
    P,
    pops_per_s: Math.round(pops / SECS),
    inserts_per_s: Math.round(inserts / SECS),
    commits_per_s: Math.round((pops + inserts) / SECS),
    pop_executions: popAttempts,
    // Executions of a pop that were thrown away on a conflict, over all pop executions.
    occ_conflict_pct: Number(((100 * (popAttempts - pops - empty)) / Math.max(1, popAttempts)).toFixed(2)),
    retries,
    pop_occ_failures: popFailed,
    empty_pops: empty,
    head_reruns_per_append: Number(((engine.stats.cacheMisses - misses) / N).toFixed(3)),
  }),
);
process.exit(0);

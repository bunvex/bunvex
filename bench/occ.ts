// Hot-key OCC scenario, in process (STUDY-21): C clients each loop { get(counter); patch(counter, n + 1) } on
// ONE document for SECS seconds. Reports committed/s, OCC failures surfaced, retries and latency.
//   bun bench/occ.ts [memory|sqlite]        Env: C (default 16), SECS (default 5), DIR (sqlite scratch dir)
import { mkdirSync, rmSync } from "node:fs";
import { defineSchema, defineTable, Engine, type Persistence } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { v } from "@bunvex/values";

const kind = process.argv[2] ?? "memory";
const C = Number(process.env.C ?? 16);
const SECS = Number(process.env.SECS ?? 5);
let persistence: Persistence;
if (kind === "sqlite") {
  const dir = process.env.DIR ?? `${import.meta.dir}/../.data/occ`;
  mkdirSync(dir, { recursive: true });
  for (const s of ["", "-wal", "-shm"]) rmSync(`${dir}/db${s}`, { force: true });
  persistence = new SqlitePersistence(`${dir}/db`, { durable: true });
} else persistence = await MemoryPersistence.open(null, { durable: false });

const engine = await new Engine(defineSchema({ counters: defineTable(v.any()) }), persistence).init();
const id = await engine.mutation((db) => db.insert("counters", { n: 0 }));
const ok: number[] = [];
const all: number[] = [];
let failed = 0;
const end = performance.now() + SECS * 1000;
await Promise.all(
  Array.from({ length: C }, async () => {
    while (performance.now() < end) {
      const t0 = performance.now();
      try {
        await engine.mutation(async (db) => {
          const d = (await db.get("counters", id)) as unknown as { n: number };
          await db.patch("counters", id, { n: d.n + 1 });
        });
        ok.push(performance.now() - t0);
      } catch {
        failed++;
      }
      all.push(performance.now() - t0);
    }
  }),
);
const q = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return Number((s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0).toFixed(2));
};
console.log(
  JSON.stringify({
    kind,
    C,
    committed_per_s: Math.round(ok.length / SECS),
    fail_pct: Number(((100 * failed) / (ok.length + failed)).toFixed(3)),
    retries: engine.stats.retries,
    ok_p50_ms: q(ok, 0.5),
    ok_p99_ms: q(ok, 0.99),
    all_p999_ms: q(all, 0.999),
    all_max_ms: q(all, 1),
  }),
);
process.exit(0);

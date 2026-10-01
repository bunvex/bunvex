// Retention (STUDY-33): what pruning buys and what it costs. A hot set of 1000 documents is rewritten 100
// times (100 000 document versions, 200 000 index rows), then read through its index; retention prunes
// it (unthrottled, to measure the deletes themselves) and the same reads run again.
//   bun bench/retention.ts                       SQLite (file, durable)
//   PG_URL=… DO_NOT_REQUIRE_SSL=1 bun bench/retention.ts
import { mkdirSync, rmSync } from "node:fs";
import { defineSchema, defineTable, Engine, type Persistence } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { v } from "@bunvex/values";

const DOCS = Number(process.env.DOCS ?? 1000);
const ROUNDS = Number(process.env.ROUNDS ?? 100);
const schema = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) });

const pct = (a: number[], q: number) => [...a].sort((x, y) => x - y)[Math.floor(q * (a.length - 1))].toFixed(2);

async function reads(e: Engine) {
  const full: number[] = [];
  const range: number[] = [];
  for (let i = 0; i < 30; i++) {
    let t = performance.now();
    await e.query((db) => db.query("items").withIndex("by_n").collect());
    full.push(performance.now() - t);
    t = performance.now();
    await e.query((db) =>
      db
        .query("items")
        .withIndex("by_n", (q) => q.gte("n", Math.floor(Math.random() * DOCS)))
        .take(10),
    );
    range.push(performance.now() - t);
  }
  return { fullScanP50Ms: pct(full, 0.5), take10P50Ms: pct(range, 0.5) };
}

async function run(name: string, p: Persistence, rows: () => Promise<{ docs: number; idx: number }>) {
  const e = await new Engine(schema, p, {
    retention: {
      background: false,
      indexDelayMs: 0,
      documentDelayMs: 0,
      documentRatePerSec: 1e12,
      checkpointEveryMs: 0,
    },
  }).init();
  const ids: string[] = [];
  for (let i = 0; i < DOCS; i += 100)
    ids.push(
      ...((await e.mutation(async (db) => {
        const out: string[] = [];
        for (let j = i; j < Math.min(DOCS, i + 100); j++) out.push(await db.insert("items", { n: j, r: 0 }));
        return out;
      })) as string[]),
    );
  const t0 = performance.now();
  for (let r = 1; r <= ROUNDS; r++)
    for (let i = 0; i < ids.length; i += 100)
      await e.mutation(async (db) => {
        for (const id of ids.slice(i, i + 100)) await db.patch(id, { r });
      });
  const writeMs = performance.now() - t0;
  const before = { rows: await rows(), ...(await reads(e)) };
  const r = e.retention!;
  await r.advance();
  let t = performance.now();
  await r.deleteIndexes();
  while (await r.deleteIndexes());
  const indexMs = performance.now() - t;
  t = performance.now();
  await r.deleteDocuments();
  while (await r.deleteDocuments());
  const docMs = performance.now() - t;
  const after = { rows: await rows(), ...(await reads(e)) };
  console.log(
    JSON.stringify({
      driver: name,
      versions: DOCS * (ROUNDS + 1),
      writeSecs: (writeMs / 1000).toFixed(1),
      before,
      after,
      indexRowsDeleted: r.stats.indexRowsDeleted,
      indexRowsPerSec: Math.round(r.stats.indexRowsDeleted / (indexMs / 1000)),
      documentRowsDeleted: r.stats.documentRowsDeleted,
      documentRowsPerSec: Math.round(r.stats.documentRowsDeleted / (docMs / 1000)),
    }),
  );
  await e.close();
}

const dir = `${import.meta.dir}/../.data/retention-bench`;
mkdirSync(dir, { recursive: true });
for (const s of ["", "-wal", "-shm"]) rmSync(`${dir}/db.sqlite${s}`, { force: true });
const sq = new SqlitePersistence(`${dir}/db.sqlite`, { durable: true });
await run("sqlite", sq, async () => sq.auditRowCount());

if (process.env.PG_URL) {
  const { PostgresPersistence } = await import("@bunvex/persistence/postgres");
  const pg = await PostgresPersistence.open(process.env.PG_URL, 16, { requireSsl: !process.env.DO_NOT_REQUIRE_SSL });
  await (pg as unknown as { sql: { unsafe(s: string): Promise<unknown> } }).sql.unsafe(
    "drop table if exists documents, indexes, bunvex_lease, persistence_globals, read_only",
  );
  await pg.close();
  const fresh = await PostgresPersistence.open(process.env.PG_URL, 16, { requireSsl: !process.env.DO_NOT_REQUIRE_SSL });
  await run("postgres", fresh, () => fresh.auditRowCount());
}

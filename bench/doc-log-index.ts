// What the document log's ts index (PERSIST-01 C12, `documents_by_ts`) costs writes: commits of 10 documents
// and 20 index entries, flushed in groups of 50, with the index and with it dropped.
//   bun bench/doc-log-index.ts                 SQLite (file, durable)
//   PG_URL=… DO_NOT_REQUIRE_SSL=1 bun bench/doc-log-index.ts
import { mkdirSync, rmSync } from "node:fs";
import { encodeKey, hasLease, type Persistence } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { tid } from "./ids.ts";

const DIR = process.env.DIR ?? `${import.meta.dir}/../.data/doc-log-index`;
const COMMITS = Number(process.env.COMMITS ?? 20_000);
const TRIALS = Number(process.env.TRIALS ?? 3);

async function trial(open: () => Promise<Persistence>, drop: (p: Persistence) => Promise<void> | void) {
  const p = await open();
  if (hasLease(p)) await p.acquireLease({ holder: "bench", ttlMs: 60_000 });
  await drop(p);
  const t0 = performance.now();
  for (let c = 1; c <= COMMITS; c++) {
    const docs = Array.from({ length: 10 }, (_, i) => ({
      table: tid(1),
      id: `d${(c * 10 + i) % 50_000}`,
      json: `{"c":${c}}`,
      prevTs: null,
    }));
    const idx = docs.flatMap((d) => [
      { index: tid(1), key: encodeKey([d.id]), table: tid(1), id: d.id },
      { index: tid(2), key: encodeKey([c % 997, d.id]), table: tid(1), id: d.id },
    ]);
    p.apply(BigInt(c), docs, idx);
    if (c % 50 === 0) await p.flush();
  }
  await p.flush();
  const ms = performance.now() - t0;
  if (hasLease(p)) await p.releaseLease();
  await p.close();
  return Math.round((COMMITS * 10) / (ms / 1000));
}

async function compare(name: string, open: () => Promise<Persistence>, dropSql: (p: Persistence) => Promise<void>) {
  const withIdx: number[] = [];
  const without: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    withIdx.push(await trial(open, () => {}));
    without.push(await trial(open, dropSql));
  }
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  console.log(
    JSON.stringify({
      driver: name,
      commits: COMMITS,
      docsPerSecWithIndex: med(withIdx),
      docsPerSecWithout: med(without),
      cost: `${(((med(without) - med(withIdx)) / med(without)) * 100).toFixed(1)}%`,
      trials: { withIdx, without },
    }),
  );
}

mkdirSync(DIR, { recursive: true });
const path = `${DIR}/bench.db`;
await compare(
  "sqlite",
  async () => {
    for (const s of ["", "-wal", "-shm"]) rmSync(`${path}${s}`, { force: true });
    return new SqlitePersistence(path, { durable: true });
  },
  async (p) => {
    (p as unknown as { db: { exec(s: string): void } }).db.exec("drop index documents_by_ts");
  },
);

if (process.env.PG_URL) {
  const { PostgresPersistence } = await import("@bunvex/persistence/postgres");
  const open = async () => {
    const p = await PostgresPersistence.open(process.env.PG_URL!, 16, { requireSsl: !process.env.DO_NOT_REQUIRE_SSL });
    const sql = (p as unknown as { sql: { unsafe(s: string): Promise<unknown> } }).sql;
    await sql.unsafe("truncate documents, indexes; delete from bunvex_lease");
    await sql.unsafe("create index if not exists documents_by_ts on documents (ts)");
    return p;
  };
  await compare("postgres", open, async (p) => {
    await (p as unknown as { sql: { unsafe(s: string): Promise<unknown> } }).sql.unsafe("drop index documents_by_ts");
  });
}

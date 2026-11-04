// Reads under write load on a SQLite file (audit P1, decision 2 of 2026-11-04). The writes run on the store's
// writer thread, a second connection (STUDY-190 PR 1). SQLite drops a connection's page cache whenever another
// connection has committed since its last read, so on a busy store the readers' cache, 256 MiB by default
// (DV-550), may rarely be warm. This bench measures what that costs on bunvex's real read path: queries through the
// engine, with the index cache in front, while mutations commit at a steady rate.
//
//   bun bench/sqlite-read-under-write.ts                  # the whole matrix
//   DOCS=300000 SECONDS=15 bun bench/sqlite-read-under-write.ts
//   CELLS='cache=2MiB,mmap=0,writes=200,ic=off' bun bench/sqlite-read-under-write.ts
//
// Each cell opens a copy of one seeded store and starts with cold caches (its own process). It runs READERS
// concurrent query loops: a point `db.get` of a random document, or a 20-document range read of a random
// `by_n` slice (READ=get|range|mix, default mix). WRITERS mutation loops share a rate of `writes` commits a second,
// each one patching a random document of another table, so the documents read never change.
// A cell reports reads a second, read p50 / p99 (ms), and the commits it achieved. (SQLite's page cache counters
// are out of reach here: bun:sqlite does not expose the connection's pointer.)
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { v } from "@bunvex/values";

const DOCS = Number(process.env.DOCS ?? 200_000);
const BODY = Number(process.env.BODY ?? 1000);
const SECONDS = Number(process.env.SECONDS ?? 12);
const READERS = Number(process.env.READERS ?? 16);
const WRITERS = Number(process.env.WRITERS ?? 8);
const READ = process.env.READ ?? "mix";

const schema = defineSchema({
  docs: defineTable({ n: v.number(), body: v.string() }).index("by_n", ["n"]),
  hot: defineTable({ k: v.number(), at: v.number() }),
});

type Cell = { cache: string; mmap: number; writes: number; ic: "on" | "off" };
const parseBytes = (s: string) => {
  const m = /^(\d+)(KiB|MiB|GiB)?$/.exec(s);
  if (!m) throw new Error(`bad size ${s}`);
  return Number(m[1]) * ({ KiB: 1024, MiB: 1 << 20, GiB: 1 << 30 }[m[2] ?? ""] ?? 1);
};

async function seed(dir: string) {
  const path = join(dir, "seed.sqlite");
  const p = new SqlitePersistence(path, { durable: false });
  const e = await new Engine(schema, p, { indexCache: false }).init();
  const body = "x".repeat(BODY);
  const ids: string[] = [];
  for (let i = 0; i < DOCS; i += 500) {
    const batch = await e.mutation(async (db) => {
      const out: string[] = [];
      for (let j = i; j < Math.min(i + 500, DOCS); j++)
        out.push(await db.insert("docs", { n: j, body: `${j}${body}` }));
      return out;
    });
    ids.push(...batch);
  }
  const hot = await e.mutation(async (db) => {
    const out: string[] = [];
    for (let k = 0; k < 1000; k++) out.push(await db.insert("hot", { k, at: 0 }));
    return out;
  });
  await e.close();
  return { path, ids, hot };
}

const pct = (xs: number[], q: number) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))] ?? NaN;

async function runCell(cell: Cell, seeded: { path: string; ids: string[]; hot: string[] }, dir: string) {
  const path = join(dir, `cell-${process.pid}-${Date.now()}.sqlite`);
  cpSync(seeded.path, path);
  const p = new SqlitePersistence(path, { durable: true, cacheBytes: parseBytes(cell.cache) });
  // The reader connection: the one the engine's reads use (a bench-only reach into the driver).
  const readerDb = (p as unknown as { db: { exec(s: string): void } }).db;
  readerDb.exec(`pragma mmap_size = ${cell.mmap}`);
  const e = await new Engine(schema, p, { indexCache: cell.ic === "on" ? {} : false }).init();
  let stop = false;
  const lat: number[] = [];
  let reads = 0;
  let commits = 0;
  const { ids, hot } = seeded;
  const rand = (n: number) => Math.floor(Math.random() * n);
  const reader = async (r: number) => {
    let i = r;
    while (!stop) {
      const kind = READ === "mix" ? (i++ % 2 ? "get" : "range") : READ;
      const t = performance.now();
      if (kind === "get") await e.query((db) => db.get(ids[rand(ids.length)] as never));
      else {
        const lo = rand(DOCS - 20);
        await e.query((db) =>
          db
            .query("docs")
            .withIndex("by_n", (q) => q.gte("n", lo).lt("n", lo + 20))
            .collect(),
        );
      }
      lat.push(performance.now() - t);
      reads++;
      // A read the caches answer settles in microtasks only: yield, or the timers (and the writers) never run.
      if (reads % 32 === 0) await new Promise((r) => setImmediate(r));
    }
  };
  const writer = async () => {
    if (cell.writes === 0) return;
    const gap = (1000 * WRITERS) / cell.writes;
    let next = performance.now();
    while (!stop) {
      await e.mutation((db) => db.patch(hot[rand(hot.length)] as never, { at: Date.now() }));
      commits++;
      next += gap;
      const wait = next - performance.now();
      if (wait > 0) await Bun.sleep(wait);
      else next = performance.now();
    }
  };
  // A short warm-up, then the measured window.
  const warm = Promise.all([...Array(READERS).keys()].map(reader));
  const writing = Promise.all([...Array(WRITERS)].map(writer));
  await Bun.sleep(2000);
  lat.length = 0;
  reads = 0;
  commits = 0;
  const t0 = performance.now();
  await Bun.sleep(SECONDS * 1000);
  const elapsed = (performance.now() - t0) / 1000;
  const measured = { reads, commits, lat: lat.slice() };
  stop = true;
  await Promise.all([warm, writing]);
  await e.close();
  for (const s of ["", "-wal", "-shm", ".lock"]) rmSync(path + s, { force: true });
  measured.lat.sort((a, b) => a - b);
  return {
    ...cell,
    readsPerSec: Math.round(measured.reads / elapsed),
    p50: +pct(measured.lat, 0.5).toFixed(3),
    p99: +pct(measured.lat, 0.99).toFixed(3),
    commitsPerSec: Math.round(measured.commits / elapsed),
    rss: Math.round(process.memoryUsage().rss / 2 ** 20),
  };
}

function cells(): Cell[] {
  if (process.env.CELLS)
    return process.env.CELLS.split(";").map((s) => {
      const o = Object.fromEntries(s.split(",").map((kv) => kv.split("=")));
      return { cache: o.cache ?? "256MiB", mmap: Number(o.mmap ?? 0), writes: Number(o.writes ?? 0), ic: o.ic ?? "on" };
    });
  const out: Cell[] = [];
  for (const ic of ["off", "on"] as const)
    for (const writes of [0, 50, 500])
      for (const [cache, mmap] of [
        ["2MiB", 0],
        ["256MiB", 0],
        ["2MiB", 1 << 30],
      ] as const)
        out.push({ cache, mmap, writes, ic });
  return out;
}

if (process.env.BENCH_CELL) {
  // A child: one cell, its result as JSON on the last line.
  const { cell, seededFile, dir } = JSON.parse(process.env.BENCH_CELL);
  const seeded = JSON.parse(readFileSync(seededFile, "utf8"));
  console.log(JSON.stringify(await runCell(cell, seeded, dir)));
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "bunvex-read-under-write-"));
try {
  console.error(`seeding ${DOCS} documents of ~${BODY} B…`);
  const seeded = await seed(dir);
  const seededFile = join(dir, "seeded.json");
  writeFileSync(seededFile, JSON.stringify(seeded));
  console.error(`seeded; ${READERS} readers (${READ}), ${WRITERS} writers, ${SECONDS} s a cell`);
  const rows = [];
  for (const cell of cells()) {
    const child = Bun.spawnSync([process.execPath, import.meta.path], {
      env: { ...process.env, BENCH_CELL: JSON.stringify({ cell, seededFile, dir }) },
      stderr: "inherit",
    });
    const last = child.stdout.toString().trim().split("\n").at(-1) ?? "";
    const row = JSON.parse(last);
    rows.push(row);
    console.error(JSON.stringify(row));
  }
  console.table(rows);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

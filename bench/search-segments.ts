// Search segments, engine level (STUDY-111): with one text and one vector index on a table of 12-word documents
// (a filter field, a 64-dimension vector), on SQLite (durable) and file blobs:
//   - write throughput: inserting the documents in mutations of 500;
//   - query latency: a text search (`take(10)`, a read-only query) and a vector search, medians;
//   - memory: the heap, the RSS and (macOS) the physical footprint, which leaves out clean file pages the OS can
//     drop (mapped segments'), once the indexes are ready and compacted;
//   - restart: how long a start takes until the indexes are ready, after a clean close and after a crash
//     (the process killed with writes since the last flush); each restart also measures query latency, the
//     first query (cold) and medians.
//   bun bench/search-segments.ts <sqlite path> <documents> [writes before the crash]
// With SEARCH_DISK=1, segments are read from the store's files (memory-mapped, STUDY-111 PR 9) rather than held
// in memory; with SEARCH_DISK=cache, from a local cache of them, as for S3 (`<sqlite path>.cache`).

import { heapStats } from "bun:jsc";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defineSchema, defineTable, Engine, type SearchSegmentStore } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { v } from "@bunvex/values";

const [where, n = "200000", crashWrites = "20000", child] = process.argv.slice(2);
if (!where) throw new Error("usage: bun bench/search-segments.ts <sqlite path> <documents> [writes before the crash]");
const schema = defineSchema({
  notes: defineTable(v.any())
    .searchIndex("search_body", { searchField: "body", filterFields: ["kind"] })
    .vectorIndex("by_v", { vectorField: "v", dimensions: 64, filterFields: ["kind"] }),
});
const words = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho".split(" ");
const note = (i: number) => ({
  body: `${Array.from({ length: 12 }, (_, k) => words[(i * 7 + k * 3) % words.length]).join(" ")} n${i}`,
  kind: `k${i % 10}`,
  v: Array.from({ length: 64 }, (_, k) => Math.sin(i + k)),
});

const dir = `${where}.search`;
const files: SearchSegmentStore = {
  put: async (d) => {
    const key = crypto.randomUUID();
    await Bun.write(join(dir, key), d);
    return key;
  },
  get: async (k) => {
    const f = Bun.file(join(dir, k));
    return (await f.exists()) ? new Uint8Array(await f.arrayBuffer()) : null;
  },
  delete: async (k) => rmSync(join(dir, k), { force: true }),
  localPath: process.env.SEARCH_DISK === "1" ? (k) => join(dir, k) : undefined,
};

async function open() {
  const t = performance.now();
  const e = await new Engine(schema, new SqlitePersistence(where!, { durable: true }), {
    searchStorage: files,
    ...(process.env.SEARCH_DISK === "cache" ? { searchCacheDir: `${where}.cache` } : {}),
  }).init();
  await e.searchReady();
  return { e, ms: Math.round(performance.now() - t) };
}

async function insert(e: Engine, from: number, count: number) {
  for (let i = from; i < from + count; i += 500)
    await e.mutation(async (db) => {
      for (let k = i; k < Math.min(i + 500, from + count); k++) await db.insert("notes", note(k));
    });
}

function median(xs: number[]) {
  return xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
}

/** The heap, the RSS and, on macOS, the physical footprint (dirty memory: not the clean pages of mapped files). */
function memory() {
  Bun.gc(true);
  const mib = (b: number) => `${(b / 2 ** 20).toFixed(0)} MiB`;
  let out = `heap ${mib(heapStats().heapSize)}, rss ${mib(process.memoryUsage().rss)}`;
  if (process.platform === "darwin") {
    const fp = Bun.spawnSync(["footprint", String(process.pid)]).stdout.toString();
    const m = fp.match(/Footprint: ([\d.]+ \w+)/);
    if (m) out += `, footprint ${m[1]}`;
  }
  return out;
}

/** Query latency: the first text and vector query (cold), then medians of many. */
async function latency(e: Engine) {
  const textQuery = (i: number) =>
    e.query((db) =>
      db
        .query("notes")
        .withSearchIndex("search_body", (q) => q.search("body", words[i % words.length]!))
        .take(10),
    );
  const time = async (f: () => unknown) => {
    const s0 = performance.now();
    await f();
    return performance.now() - s0;
  };
  const coldText = await time(() => textQuery(0));
  const coldVector = await time(() => e.vectorSearch("notes", "by_v", { vector: note(0).v, limit: 10 }));
  const text: number[] = [];
  for (let i = 0; i < 200; i++) text.push(await time(() => textQuery(i)));
  const vector: number[] = [];
  for (let i = 0; i < 50; i++)
    vector.push(await time(() => e.vectorSearch("notes", "by_v", { vector: note(i).v, limit: 10 })));
  return `first query text ${coldText.toFixed(1)} ms, vector ${coldVector.toFixed(1)} ms; median text ${median(text).toFixed(2)} ms, vector ${median(vector).toFixed(2)} ms`;
}

if (child === "crash") {
  // The crashing run: writes since the last flush, then dies without closing.
  const { e } = await open();
  await insert(e, Number(n), Number(crashWrites));
  // The table summaries' checkpoint is brought up to date, so the restart measures the search indexes only.
  await e.summariesReady();
  await e.summaryCheckpointer?.tick(true);
  process.exit(0);
}
if (child === "build") {
  // Building the indexes from the table, as for a new index: the stored segments are gone.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const { e, ms } = await open();
  Bun.gc(true);
  console.log(
    `built from the table: ${ms} ms, heap ${(heapStats().heapSize / 2 ** 20).toFixed(0)} MiB, rss ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MiB ${JSON.stringify(e.searchStats ?? {})}`,
  );
  await e.close();
  process.exit(0);
}
if (child === "open") {
  // A start in a process of its own, as a restart is: until the indexes are ready.
  const { e, ms } = await open();
  // A compaction the start scheduled is waited for, so memory is that of the index at rest.
  const c = performance.now();
  await e.searchCompacted();
  const compacting = Math.round(performance.now() - c);
  const ready = memory();
  const queries = await latency(e);
  console.log(
    `${ms} ms (then ${compacting} ms compacting); ${ready}; after the queries ${memory()}; mapped ${e.searchSegmentsMapped}; ${queries} ${JSON.stringify(e.searchStats ?? {})}`,
  );
  await e.close();
  process.exit(0);
}

/** A start in a new process (the bench's own heap and caches out of it); what it printed. */
async function restart() {
  const p = Bun.spawn(["bun", import.meta.path, where!, n, crashWrites, "open"], { stdout: "pipe", stderr: "inherit" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

rmSync(where, { force: true });
rmSync(`${where}-wal`, { force: true });
rmSync(`${where}-shm`, { force: true });
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
{
  const { e } = await open();
  const t = performance.now();
  await insert(e, 0, Number(n));
  const s = (performance.now() - t) / 1000;
  console.log(`write throughput: ${n} documents in ${s.toFixed(1)} s (${Math.round(Number(n) / s)} documents/s)`);
  await e.searchReady();
  const c0 = performance.now();
  await e.searchCompacted();
  console.log(`compactions after the load: ${Math.round(performance.now() - c0)} ms`);
  console.log(`memory with the indexes ready: ${memory()}`);
  console.log(`latency after the load: ${await latency(e)}`);
  // As in the crash run: the table summaries' checkpoint up to date, so restarts measure the search indexes.
  await e.summariesReady();
  await e.summaryCheckpointer?.tick(true);
  const c = performance.now();
  await e.close();
  console.log(`clean close: ${Math.round(performance.now() - c)} ms`);
}
// The first start after the load reads a cold store: printed, then the restarts that follow.
for (let round = 0; round < 3; round++) {
  const what = round ? "restart after a clean close" : "first restart after the load";
  console.log(`${what}: ${await restart()}`);
}
if (Number(crashWrites)) {
  const p = Bun.spawn(["bun", import.meta.path, where, n, crashWrites, "crash"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await p.exited;
  console.log(`restart after a crash with ${crashWrites} writes since: ${await restart()}`);
}

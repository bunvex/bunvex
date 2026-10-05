// Search segments, engine level (STUDY-111): with one text and one vector index on a table of 12-word documents
// (a filter field, a 64-dimension vector), on SQLite (durable) and file blobs:
//   - write throughput: inserting the documents in mutations of 500;
//   - query latency: a text search (`take(10)`, a read-only query) and a vector search, medians;
//   - memory: the heap once the indexes are ready;
//   - restart: how long a start takes until the indexes are ready, after a clean close and after a crash
//     (the process killed with writes since the last flush).
//   bun bench/search-segments.ts <sqlite path> <documents> [writes before the crash]

import { heapStats } from "bun:jsc";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defineSchema, defineTable, Engine, type SearchSnapshotStore } from "@bunvex/core";
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
const files: SearchSnapshotStore = {
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
};

async function open() {
  const t = performance.now();
  const e = await new Engine(schema, new SqlitePersistence(where!, { durable: true }), {
    searchSnapshots: files,
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

if (child === "crash") {
  // The crashing run: writes since the last flush, then dies without closing.
  const { e } = await open();
  await insert(e, Number(n), Number(crashWrites));
  // The table summaries' checkpoint is brought up to date, so the restart measures the search indexes only.
  await e.summariesReady();
  await e.summaryCheckpointer?.tick(true);
  process.exit(0);
}
if (child === "open") {
  // A start in a process of its own, as a restart is: until the indexes are ready.
  const { e, ms } = await open();
  console.log(`${ms} ms ${JSON.stringify(e.searchStats ?? {})}`);
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
  Bun.gc(true);
  console.log(`heap with the indexes ready: ${(heapStats().heapSize / 2 ** 20).toFixed(0)} MiB`);
  const text: number[] = [];
  for (let i = 0; i < 200; i++) {
    const s0 = performance.now();
    await e.query((db) =>
      db
        .query("notes")
        .withSearchIndex("search_body", (q) => q.search("body", words[i % words.length]!))
        .take(10),
    );
    text.push(performance.now() - s0);
  }
  const vector: number[] = [];
  for (let i = 0; i < 50; i++) {
    const s0 = performance.now();
    e.vectorSearch("notes", "by_v", { vector: note(i).v, limit: 10 });
    vector.push(performance.now() - s0);
  }
  console.log(`latency (median): text ${median(text).toFixed(2)} ms, vector ${median(vector).toFixed(2)} ms`);
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

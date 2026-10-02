// Code versions (STUDY-35): what a push costs and what loaded code costs per call.
//   bun bench/code-versions.ts
// 1. Memory across 100 pushes of a 0.9 MB module (each a new code version, installed on a server): RSS
//    growth and the JS heap (flat when superseded versions are collected).
// 2. Load time of one such version.
// 3. A query's cost, registered in process (embedded) against loaded in a code version's context.

import { heapStats } from "bun:jsc";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { createServer, Functions, query } from "bunvex/server";
import { CodeVersion } from "../packages/server/src/code-version.ts";

const engine = await new Engine(
  defineSchema({ items: defineTable(v.any()) }),
  await MemoryPersistence.open(null, { durable: false }),
).init();
const functions = new Functions(engine);
const server = createServer({ engine, functions, port: 0 });
const big = Array.from(
  { length: 6000 },
  (_, i) => `export function f${i}(x) { return x * ${i} + "${"s".repeat(100)}"; }`,
).join("\n");
const source = (n: number) =>
  `import { query } from "@bunvex/server";\n${big}\nexport const list = query(async ({ db }) => (await db.query("items").take(10)).length + ${n});`;
const opts = { seed: Uint32Array.of(1, 2, 3, 4), timestamp: Date.now() };
const rss = () => Math.round(process.memoryUsage().rss / 1e6);
/** The JS heap: what is still referenced (RSS also keeps what the allocator has not returned). */
const heap = () => Math.round(heapStats().heapSize / 1e6);

await engine.mutation(async (db) => {
  for (let i = 0; i < 10; i++) await db.insert("items", { i });
});
Bun.gc(true);
const r0 = rss();
const loadMs: number[] = [];
const memory: { pushes: number; rssMb: number; heapMb: number }[] = [];
for (let n = 1; n <= 100; n++) {
  const t = performance.now();
  const version = await CodeVersion.load([{ path: "app.js", source: source(n), environment: "isolate" }], opts);
  loadMs.push(performance.now() - t);
  await server.installCodeVersion(version);
  if ((await functions.runQuery("app:list", {})) !== 10 + n) throw new Error("wrong version");
  if (n % 25 === 0) {
    Bun.gc(true);
    memory.push({ pushes: n, rssMb: rss() - r0, heapMb: heap() });
  }
}
loadMs.sort((a, b) => a - b);

// Per-call cost: the same query, loaded and embedded (the query cache off: a fresh arg each call).
const time = async (name: string, n: number) => {
  const t = performance.now();
  for (let i = 0; i < n; i++) await functions.runQuery(name, { i });
  return ((performance.now() - t) * 1000) / n;
};
const loaded = await CodeVersion.load(
  [
    {
      path: "app.js",
      environment: "isolate",
      source: `import { query } from "@bunvex/server"; export const list = query(async ({ db }) => (await db.query("items").take(10)).length);`,
    },
  ],
  opts,
);
functions.install(loaded.functions, loaded.moduleHashes);
await time("app:list", 2000);
const loadedUs = await time("app:list", 20000);
const embedded = new Functions(engine).register("app", {
  list: query(async ({ db }) => (await db.query("items").take(10)).length),
});
const timeEmbedded = async (n: number) => {
  const t = performance.now();
  for (let i = 0; i < n; i++) await embedded.runQuery("app:list", { i });
  return ((performance.now() - t) * 1000) / n;
};
await timeEmbedded(2000);
const embeddedUs = await timeEmbedded(20000);
console.log(
  JSON.stringify({
    moduleMb: (source(0).length / 1e6).toFixed(2),
    memoryAfterPushes: memory,
    loadMsP50: loadMs[50]!.toFixed(1),
    loadMsP99: loadMs[98]!.toFixed(1),
    queryUs: { embedded: embeddedUs.toFixed(1), loaded: loadedUs.toFixed(1) },
  }),
);
server.stop();
process.exit(0);

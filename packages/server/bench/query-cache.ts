// The query cache over HTTP (STUDY-08 D8, DV-63), in process on the memory driver. Three scenarios:
//   hot    C clients POST the same query in a loop while a writer invalidates it every W ms: requests/s, p50,
//          p99, and how many times the query ran (a miss that coalesces runs once for all clients waiting).
//   memory D distinct queries of R bytes each: the heap after GC and how many entries the cache keeps.
//   mixed  C clients ask for Zipf-distributed owners while writers patch random owners: the hit rate.
//   bun packages/server/bench/query-cache.ts [hot|memory|mixed]
//   Env: C (default 64), SECS (default 5), W (hot: ms between writes, default 20), D (memory: default 2000),
//   R (memory: bytes per result, default 100000), K (mixed: owners, default 1000), WRITERS (mixed: default 4),
//   DOCS (hot: documents the query reads, default 2000), LATENCY_MS (default 0): delay every document read by this much, as a remote database would.

import type { Persistence } from "@bunvex/core";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const scenario = process.argv[2] ?? "hot";
const C = Number(process.env.C ?? 64);
const SECS = Number(process.env.SECS ?? 5);
const LATENCY_MS = Number(process.env.LATENCY_MS ?? 0);
// Taken before the engine installs its determinism (timers are refused inside executions).
const realSetTimeout = globalThis.setTimeout;

/** The store, with each read answered `LATENCY_MS` later. */
function withLatency(p: Persistence): Persistence {
  if (LATENCY_MS <= 0) return p;
  const later = <T>(r: T) => new Promise<Awaited<T>>((ok) => realSetTimeout(() => ok(r as Awaited<T>), LATENCY_MS));
  return new Proxy(p, {
    get(target, prop, receiver) {
      const f = Reflect.get(target, prop, receiver);
      if ((prop === "scan" || prop === "get") && typeof f === "function")
        return (...args: unknown[]) => later(f.apply(target, args));
      return typeof f === "function" ? f.bind(target) : f;
    },
  });
}

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()).index("by_owner", ["owner"]) }),
    withLatency(await MemoryPersistence.open(null, { durable: false })),
  ).init();
  const functions = new Functions(engine).register("q", {
    byOwner: query(async ({ db }, { owner }: { owner: number }) =>
      db
        .query("items")
        .withIndex("by_owner", (q) => q.eq("owner", owner))
        .collect(),
    ),
    blob: query(async (_ctx, { i, bytes }: { i: number; bytes: number }) => `${i}:${"x".repeat(bytes)}`),
    touch: mutation(async ({ db }, { owner, n }: { owner: number; n: number }) => {
      const doc = await db
        .query("items")
        .withIndex("by_owner", (q) => q.eq("owner", owner))
        .first();
      if (doc) await db.patch("items", doc._id, { n });
    }),
  });
  const { server, stop } = createServer({ engine, functions, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (kind: string, path: string, args: unknown) =>
    fetch(`${base}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" }),
    }).then(async (r) => {
      const body = await r.text();
      if (r.status !== 200) throw new Error(`${r.status} ${body}`);
      return body;
    });
  return { engine, post, stop };
}

async function seed(engine: Engine, owners: number, perOwner: number) {
  for (let o = 0; o < owners; o++)
    await engine.mutation(async (db) => {
      for (let i = 0; i < perOwner; i++) await db.insert("items", { owner: o, i, n: 0, pad: "p".repeat(64) });
    });
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return Number((s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0).toFixed(2));
};
const executions = (engine: Engine) => engine.stats.cacheMisses;

async function hot() {
  const W = Number(process.env.W ?? 20);
  const DOCS = Number(process.env.DOCS ?? 2000);
  const { engine, post, stop } = await setup();
  await seed(engine, 1, DOCS); // one owner, DOCS documents: a query that takes a few ms
  let stopWriter = false;
  let writes = 0;
  const writer = (async () => {
    while (!stopWriter) {
      await new Promise((r) => setTimeout(r, W));
      await post("mutation", "q:touch", { owner: 0, n: ++writes });
    }
  })();
  const lat: number[] = [];
  const execs0 = executions(engine);
  const end = performance.now() + SECS * 1000;
  await Promise.all(
    Array.from({ length: C }, async () => {
      while (performance.now() < end) {
        const s = performance.now();
        await post("query", "q:byOwner", { owner: 0 });
        lat.push(performance.now() - s);
      }
    }),
  );
  stopWriter = true;
  await writer;
  stop();
  return {
    scenario: "hot",
    latencyMs: LATENCY_MS,
    C,
    secs: SECS,
    writeEveryMs: W,
    docs: DOCS,
    writes,
    requestsPerSec: Math.round(lat.length / SECS),
    p50ms: pct(lat, 0.5),
    p99ms: pct(lat, 0.99),
    executions: executions(engine) - execs0,
  };
}

async function memory() {
  const D = Number(process.env.D ?? 2000);
  const R = Number(process.env.R ?? 100_000);
  const { engine, post, stop } = await setup();
  Bun.gc(true);
  const heap0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < D; i += C)
    await Promise.all(
      Array.from({ length: Math.min(C, D - i) }, (_, j) => post("query", "q:blob", { i: i + j, bytes: R })),
    );
  Bun.gc(true);
  const heap1 = process.memoryUsage().heapUsed;
  // Ask for the first 100 again: how many are still cached.
  const h0 = engine.stats.cacheHits;
  for (let i = 0; i < Math.min(100, D); i++) await post("query", "q:blob", { i, bytes: R });
  const firstHits = engine.stats.cacheHits - h0;
  const h1 = engine.stats.cacheHits;
  for (let i = Math.max(0, D - 100); i < D; i++) await post("query", "q:blob", { i, bytes: R });
  const lastHits = engine.stats.cacheHits - h1;
  stop();
  const cache = (engine as unknown as { cache?: { size?: number; bytes?: number } }).cache;
  return {
    scenario: "memory",
    distinct: D,
    resultBytes: R,
    heapGrowthMiB: Number(((heap1 - heap0) / 2 ** 20).toFixed(1)),
    entries: cache?.size,
    cacheBytesMiB: cache?.bytes === undefined ? undefined : Number((cache.bytes / 2 ** 20).toFixed(1)),
    hitsOnFirst100: firstHits,
    hitsOnLast100: lastHits,
  };
}

async function mixed() {
  const K = Number(process.env.K ?? 1000);
  const WRITERS = Number(process.env.WRITERS ?? 4);
  const { engine, post, stop } = await setup();
  await seed(engine, K, 20);
  // Zipf(1) over the owners: a few hot, a long tail.
  const weights = Array.from({ length: K }, (_, i) => 1 / (i + 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const cdf: number[] = [];
  let acc = 0;
  for (const w of weights) {
    acc += w / total;
    cdf.push(acc);
  }
  const pick = () => {
    const r = Math.random();
    let lo = 0;
    let hi = K - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid]! < r) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const h0 = engine.stats.cacheHits;
  const m0 = engine.stats.cacheMisses;
  let reads = 0;
  let writes = 0;
  const end = performance.now() + SECS * 1000;
  await Promise.all([
    ...Array.from({ length: C }, async () => {
      while (performance.now() < end) {
        await post("query", "q:byOwner", { owner: pick() });
        reads++;
      }
    }),
    ...Array.from({ length: WRITERS }, async () => {
      while (performance.now() < end) {
        // Writes land uniformly: most hit the cold tail, some the hot owners.
        await post("mutation", "q:touch", { owner: Math.floor(Math.random() * K), n: ++writes });
      }
    }),
  ]);
  stop();
  const hits = engine.stats.cacheHits - h0;
  const misses = engine.stats.cacheMisses - m0;
  return {
    scenario: "mixed",
    latencyMs: LATENCY_MS,
    C,
    writers: WRITERS,
    owners: K,
    secs: SECS,
    readsPerSec: Math.round(reads / SECS),
    writesPerSec: Math.round(writes / SECS),
    hitRate: Number((hits / (hits + misses)).toFixed(3)),
  };
}

const run = { hot, memory, mixed }[scenario];
if (!run) throw new Error(`unknown scenario ${scenario}`);
console.log(JSON.stringify(await run()));
process.exit(0);

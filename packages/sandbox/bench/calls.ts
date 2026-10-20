// Per-call cost of a query or mutation, `vm` against `process` (STUDY-171 §8.10; STUDY-168 §5.2's lines): pushed
// code deployed to a server per executor, called in-process through `Functions` (no HTTP), one call at a time, each
// with its own argument so no result comes from the query cache. Short: about 20 s at the defaults.
//
//   bun packages/sandbox/bench/calls.ts [calls=2000] [warmup=300]
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { createServer, Functions } from "@bunvex/server";
import { provideProcessExecutor } from "@bunvex/server/executor";
import { v } from "@bunvex/values";
import { createProcessExecutor } from "../src/executor.ts";

const CALLS = Number(process.argv[2] ?? 2000);
const WARMUP = Number(process.argv[3] ?? 300);
provideProcessExecutor(createProcessExecutor);

// The pushed module's import, built so the dependency rules do not read it as this package's own.
const SERVER = JSON.stringify(["bunvex", "server"].join("/"));
const SOURCE = `
import { query, mutation } from ${SERVER};
export const empty = query(async (ctx, { i }) => i);
export const gets = query(async (ctx, { i, ids }) => { let n = 0; for (const id of ids) if (await ctx.db.get(id)) n++; return n + i * 0; });
export const page = query(async (ctx, { i }) => (await ctx.db.query("items").withIndex("by_k").paginate({ numItems: 100, cursor: null })).page.length + i * 0);
export const insert = mutation(async (ctx, { i }) => ctx.db.insert("writes", { i }));
`;

const q = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;

async function deployment(sandbox: "vm" | "process") {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()).index("by_k", ["k"]), writes: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine);
  const s = createServer({
    engine,
    functions,
    port: 0,
    deployable: true,
    functionSandbox: sandbox,
    functionSandboxIsolation: "none",
  });
  await s.codeReady;
  await s.deployCode([{ path: "b.js", source: SOURCE, environment: "isolate" }]);
  const ids = (await engine.mutation(async (db) => {
    const out: string[] = [];
    for (let k = 0; k < 200; k++) out.push(await db.insert("items", { k, pad: "x".repeat(100) }));
    return out;
  })) as string[];
  return { s, functions, ids };
}

const lines: [name: string, run: (f: Functions, i: number, ids: string[]) => Promise<unknown>][] = [
  ["empty query", (f, i) => f.runQuery("b:empty", { i })],
  ["1 x db.get", (f, i, ids) => f.runQuery("b:gets", { i, ids: ids.slice(0, 1) })],
  ["10 x db.get", (f, i, ids) => f.runQuery("b:gets", { i, ids: ids.slice(0, 10) })],
  ["100 x db.get", (f, i, ids) => f.runQuery("b:gets", { i, ids: ids.slice(0, 100) })],
  ["page of 100", (f, i) => f.runQuery("b:page", { i })],
  ["insert mutation", (f, i) => f.runMutation("b:insert", { i })],
];

const results: Record<string, Record<string, string>> = {};
for (const sandbox of ["vm", "process"] as const) {
  const d = await deployment(sandbox);
  let i = 0;
  for (const [name, run] of lines) {
    const n = name.startsWith("100") ? Math.ceil(CALLS / 4) : CALLS;
    for (let w = 0; w < WARMUP; w++) await run(d.functions, i++, d.ids);
    const us: number[] = [];
    for (let c = 0; c < n; c++) {
      const t = performance.now();
      await run(d.functions, i++, d.ids);
      us.push((performance.now() - t) * 1000);
    }
    const mean = us.reduce((a, b) => a + b, 0) / us.length;
    results[name] ??= {};
    results[name]![sandbox] = `${q(us, 0.5).toFixed(0)} / ${mean.toFixed(0)} / ${q(us, 0.99).toFixed(0)}`;
  }
  await d.s.shutdown();
}
console.log(`p50 / mean / p99 µs, ${CALLS} sequential calls per line after ${WARMUP} (100 x db.get: a quarter)`);
console.log("| Function | vm | process |");
console.log("|---|---|---|");
for (const [name] of lines) console.log(`| ${name} | ${results[name]!.vm} | ${results[name]!.process} |`);
process.exit(0);

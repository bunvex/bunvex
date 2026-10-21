// The cost of a nested call's error reaching its caller (STUDY-171 §TBD, Q-PR7-2), `vm` against `process`: pushed
// queries, mutations and actions making 10 nested calls whose callee throws, each error caught (a plain one and one
// with data), and 10 that succeed as the line to compare with. Called in-process through `Functions` (no HTTP), one
// call at a time, each with its own argument so no result comes from the query cache.
//
//   [NESTED=10] [MODES=vm,process] bun packages/sandbox/bench/nested-errors.ts [calls=1000] [warmup=200] [only=…]
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { createServer, Functions } from "@bunvex/server";
import { provideProcessExecutor } from "@bunvex/server/executor";
import { createProcessExecutor } from "../src/executor.ts";

const CALLS = Number(process.argv[2] ?? 1000);
const WARMUP = Number(process.argv[3] ?? 200);
const ONLY = process.argv[4];
/** Nested calls per function (`NESTED`, 10 by default) and the executors (`MODES`, both by default). */
const NESTED = Number(process.env.NESTED ?? 10);
const MODES = (process.env.MODES ?? "vm,process").split(",") as ("vm" | "process")[];
provideProcessExecutor(createProcessExecutor);

// The pushed module's imports, built so the dependency rules do not read them as this package's own.
const SERVER = JSON.stringify(["bunvex", "server"].join("/"));
const VALUES = JSON.stringify(["bunvex", "values"].join("/"));
const SOURCE = `
import { action, mutation, query } from ${SERVER};
import { BunvexError } from ${VALUES};
const fail = (data) => { if (data) throw new BunvexError({ code: 1 }); throw new Error("boom"); };
export const ok = query(async (ctx, { i }) => i);
export const throws = query(async (ctx, { data }) => fail(data));
export const throwsM = mutation(async (ctx, { data }) => fail(data));
const ten = async (call) => { let n = 0; for (let k = 0; k < ${NESTED}; k++) { try { await call(); } catch (e) { if (e instanceof Error) n++; } } return n; };
export const queryOk = query(async (ctx, { i }) => ten(() => ctx.runQuery("b:ok", { i })));
export const queryErrors = query(async (ctx, { i, data }) => (await ten(() => ctx.runQuery("b:throws", { data }))) + i * 0);
export const mutationErrors = mutation(async (ctx, { i, data }) => (await ten(() => ctx.runMutation("b:throwsM", { data }))) + i * 0);
export const actionErrors = action(async (ctx, { i, data }) => (await ten(() => ctx.runMutation("b:throwsM", { data }))) + i * 0);
`;

const q = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;

async function deployment(sandbox: "vm" | "process") {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
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
  return { s, functions };
}

const lines: [name: string, run: (f: Functions, i: number) => Promise<unknown>][] = [
  [`query, ${NESTED} nested calls that succeed`, (f, i) => f.runQuery("b:queryOk", { i })],
  [`query, ${NESTED} caught errors`, (f, i) => f.runQuery("b:queryErrors", { i, data: false })],
  [`query, ${NESTED} caught errors with data`, (f, i) => f.runQuery("b:queryErrors", { i, data: true })],
  [`mutation, ${NESTED} caught errors`, (f, i) => f.runMutation("b:mutationErrors", { i, data: false })],
  [`action, ${NESTED} caught errors`, (f, i) => f.runAction("b:actionErrors", { i, data: false })],
  [`action, ${NESTED} caught errors with data`, (f, i) => f.runAction("b:actionErrors", { i, data: true })],
];

const results: Record<string, Record<string, string>> = {};
/** How many of a call's caught errors were `instanceof Error` in the caller (the line that succeeds: its results). */
const asError: Record<string, number> = {};
for (const sandbox of MODES) {
  const d = await deployment(sandbox);
  let i = 0;
  for (const [name, run] of lines) {
    if (ONLY && !name.includes(ONLY)) continue;
    for (let w = 0; w < WARMUP; w++) await run(d.functions, i++);
    const us: number[] = [];
    for (let c = 0; c < CALLS; c++) {
      const t = performance.now();
      const n = await run(d.functions, i++);
      us.push((performance.now() - t) * 1000);
      if (c === 0) asError[`${name}, ${sandbox}`] = n as number;
    }
    const mean = us.reduce((a, b) => a + b, 0) / us.length;
    results[name] ??= {};
    results[name]![sandbox] = `${q(us, 0.5).toFixed(0)} / ${mean.toFixed(0)} / ${q(us, 0.99).toFixed(0)}`;
  }
  await d.s.shutdown();
}
console.log(`p50 / mean / p99 µs, ${CALLS} sequential calls per line after ${WARMUP}, ${NESTED} nested calls each`);
console.log("| Function | vm | process |");
console.log("|---|---|---|");
for (const [name] of lines)
  if (results[name]) console.log(`| ${name} | ${results[name]!.vm ?? "-"} | ${results[name]!.process ?? "-"} |`);
console.log(`instanceof Error in the caller, of ${NESTED}:`, JSON.stringify(asError));
process.exit(0);

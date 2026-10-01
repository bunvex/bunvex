// Scheduled functions (STUDY-30): what scheduling costs a mutation, what an idle executor costs every
// commit, and how many scheduled mutations the executor runs per second.
//   bun packages/server/bench/scheduler.ts [mutations=3000] [jobs=3000]
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { Functions, internalMutation, mutation } from "../src/functions.ts";
import { ScheduledJobExecutor } from "../src/scheduler.ts";

const M = Number(process.argv[2] ?? 3000);
const J = Number(process.argv[3] ?? 3000);

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  let done = 0;
  const functions = new Functions(engine).register("m", {
    plain: mutation(async ({ db }) => {
      await db.insert("items", { n: 1 });
    }),
    schedules: mutation(async ({ db, scheduler }) => {
      await db.insert("items", { n: 1 });
      await scheduler.runAfter(60_000, "m:work");
    }),
    work: internalMutation(async ({ db }) => {
      await db.insert("items", { n: 2 });
      done++;
    }),
    enqueue: mutation(async ({ scheduler }, { n }: { n: number }) => {
      for (let i = 0; i < n; i++) await scheduler.runAfter(0, "m:work");
    }),
  });
  return { engine, functions, done: () => done };
}

/** Mutations per second, 16 at a time. */
async function rate(functions: Functions, name: string) {
  const t0 = performance.now();
  let next = 0;
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      while (next++ < M) await functions.runMutation(name, {});
    }),
  );
  return M / ((performance.now() - t0) / 1000);
}

const results: Record<string, number[]> = {};
const add = (k: string, x: number) => {
  results[k] ??= [];
  results[k].push(x);
};
for (let round = 0; round < 3; round++) {
  {
    const { engine, functions } = await setup();
    add("plain mutation, no executor", await rate(functions, "m:plain"));
    await engine.close();
  }
  {
    const { engine, functions } = await setup();
    const ex = new ScheduledJobExecutor(engine, functions);
    ex.start();
    add("plain mutation, idle executor", await rate(functions, "m:plain"));
    add("mutation that schedules (runAfter 60 s)", await rate(functions, "m:schedules"));
    await ex.stop();
    await engine.close();
  }
  {
    const { engine, functions, done } = await setup();
    for (let i = 0; i < J; i += 500) await functions.runMutation("m:enqueue", { n: Math.min(500, J - i) });
    const ex = new ScheduledJobExecutor(engine, functions);
    const t0 = performance.now();
    ex.start();
    while (done() < J) await Bun.sleep(5);
    add("executor: scheduled mutations run per second", J / ((performance.now() - t0) / 1000));
    await ex.stop();
    await engine.close();
  }
}
const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
for (const [k, xs] of Object.entries(results))
  console.log(`${k}: ${median(xs).toFixed(0)}/s (runs: ${xs.map((x) => x.toFixed(0)).join(", ")})`);

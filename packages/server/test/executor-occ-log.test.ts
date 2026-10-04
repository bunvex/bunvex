// A scheduled or cron mutation that loses an OCC conflict is in the function log (STUDY-65 G-A8), as Convex's
// `test_cron_occ_gets_logged` and the scheduled-job OCC test check: Convex's executors call
// `log_mutation_occ_error` for each lost attempt, then retry (scheduled_jobs/mod.rs, cron_jobs/mod.rs). Each
// lost attempt is its own Completion, with `occInfo` and `willRetry`, then the winning one; the caller is the
// Scheduler or the Cron, and every attempt keeps its own lines.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { makeFunctionReference } from "@bunvex/protocol";
import { v } from "@bunvex/values";
import { cronJobs, cronSpecs } from "../src/cron.ts";
import { CronJobExecutor } from "../src/cron-executor.ts";
import { FunctionLog, type Part } from "../src/function-log.ts";
import { Functions, internalMutation, mutation } from "../src/functions.ts";
import { ScheduledJobExecutor } from "../src/scheduler.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { occInitialBackoffMs: 1, occMaxBackoffMs: 2 },
  ).init();
  const id = await engine.mutation((db) => db.insert("items", { n: 0 }));
  let attempts = 0;
  const functions = new Functions(engine).register("m", {
    // Loses its first attempt: a rival write lands between its read and its commit.
    contended: internalMutation(async ({ db }) => {
      console.log(`attempt ${attempts}`);
      await db.get(id as never);
      if (attempts++ === 0) await engine.mutation((d) => d.patch(id as never, { n: 2 }), "m:rival");
      await db.patch(id as never, { n: 3 });
    }),
    later: mutation(({ scheduler }) => scheduler.runAfter(0, "m:contended" as never, {})),
  });
  const log = new FunctionLog();
  functions.functionLog = log;
  // As `createServer` wires them: each lost attempt reaches the log.
  engine.onOccRetry = (e) => functions.logOccRetry(e);
  /** The Completions of `m:contended`, once there are `n`. */
  const completions = async (n: number) => {
    for (let i = 0; i < 400; i++) {
      const { parts } = await log.after(0, 0);
      const mine = parts.filter((p: Part) => p.kind === "Completion" && p.identifier === "m:contended");
      if (mine.length >= n) return mine as Record<string, any>[];
      await Bun.sleep(5);
    }
    throw new Error("no completions");
  };
  return { engine, functions, id, completions };
}

const lost = (id: string, caller: string) => ({
  caller,
  willRetry: true,
  error: null,
  occInfo: { tableName: "items", documentId: id, writeSource: "m:rival", componentPath: null, retryCount: 0 },
  logLines: [expect.objectContaining({ messages: ["'attempt 0'"] })],
});
const won = (caller: string) => ({
  caller,
  willRetry: false,
  occInfo: null,
  error: null,
  logLines: [expect.objectContaining({ messages: ["'attempt 1'"] })],
});

test("a scheduled mutation's lost attempt is logged, then the attempt that won", async () => {
  const { engine, functions, id, completions } = await setup();
  const executor = new ScheduledJobExecutor(engine, functions, { occInitialBackoffMs: 1, occMaxBackoffMs: 2 });
  executor.start();
  stops.push(() => executor.stop());
  await functions.runMutation("m:later", {});
  const [first, second] = await completions(2);
  expect(first).toMatchObject(lost(id, "Scheduler"));
  expect(second).toMatchObject(won("Scheduler"));
  expect(second!.executionId).toBe(first!.executionId);
});

test("a cron mutation's lost attempt is logged, then the attempt that won (Convex: test_cron_occ_gets_logged)", async () => {
  const { engine, functions, id, completions } = await setup();
  const c = cronJobs();
  c.interval("contended", { hours: 1 }, makeFunctionReference<"mutation">("m:contended") as never);
  const executor = new CronJobExecutor(
    engine,
    functions,
    cronSpecs(c, (cid, name) => functions.cronTarget(cid, name)),
    { cronSplaySeconds: 0, occInitialBackoffMs: 1, occMaxBackoffMs: 2 },
  );
  stops.push(() => executor.stop());
  await executor.start();
  const [first, second] = await completions(2);
  expect(first).toMatchObject(lost(id, "Cron"));
  expect(second).toMatchObject(won("Cron"));
});

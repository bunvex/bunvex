// The scheduler and the cron executor on the engine's runtime (STUDY-159 PR 1): with a `TestRuntime`, a job or a cron
// due an hour from now runs when the test moves the virtual clock an hour, and not before; nothing waits on the real
// clock. Transactions read the same clock, so a job's `scheduledTime` is the virtual time it was scheduled at.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { TestRuntime } from "@bunvex/core/test-runtime";
import { v } from "@bunvex/values";
import { cronJobs, cronSpecs } from "../src/cron.ts";
import { CronJobExecutor } from "../src/cron-executor.ts";
import { Functions, internalMutation, mutation, query } from "../src/functions.ts";
import { ScheduledJobExecutor } from "../src/scheduler.ts";

const stops: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

const HOUR = 3600_000;

async function setup() {
  const rt = new TestRuntime();
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { runtime: rt },
  ).init();
  stops.push(() => engine.close());
  const functions = new Functions(engine).register("m", {
    bump: internalMutation(async ({ db }) => {
      await db.insert("items", { at: Date.now() });
    }),
    schedule: mutation(async ({ scheduler }, { delay }: { delay: number }) => scheduler.runAfter(delay, "m:bump")),
    items: query(async ({ db }) => db.query("items").collect()),
    job: query(async ({ db }, { id }: { id: string }) => db.system.get(id as never)),
  });
  const items = async () => (await functions.runQuery("m:items", {})) as { at: number }[];
  return { rt, engine, functions, items };
}

describe("the executors on a virtual clock", () => {
  test("a job an hour away runs when the clock moves an hour, at its virtual time", async () => {
    const { rt, functions, engine, items } = await setup();
    const executor = new ScheduledJobExecutor(engine, functions);
    stops.push(() => executor.stop());
    executor.start();
    const start = rt.now();
    const id = (await functions.runMutation("m:schedule", { delay: HOUR })) as string;
    // A transaction never starts before the last commit (rounded up to the ms): on a clock that stands still, the
    // mutation's `Date.now()` is the instant after the engine's first commits.
    const { scheduledTime } = (await functions.runQuery("m:job", { id })) as { scheduledTime: number };
    expect(scheduledTime - start).toBeGreaterThanOrEqual(HOUR);
    expect(scheduledTime - start).toBeLessThan(HOUR + 5);

    await rt.advance(scheduledTime - rt.now() - 1);
    expect(await items()).toEqual([]);
    await rt.advance(1);
    expect((await items()).map((i) => i.at)).toEqual([scheduledTime]);
  });

  test("a cron every hour runs at its creation, then once per virtual hour", async () => {
    const { rt, functions, engine, items } = await setup();
    const crons = cronJobs();
    crons.interval("tick", { hours: 1 }, "m:bump" as never);
    const executor = new CronJobExecutor(
      engine,
      functions,
      cronSpecs(crons, (id, name) => functions.cronTarget(id, name)),
      { cronSplaySeconds: 0 },
    );
    stops.push(() => executor.stop());
    await executor.start();
    // An interval cron's first run is at once, as Convex's: the instant after the push's commit.
    await rt.advance(1);
    const [first] = (await items()).map((i) => i.at);
    expect(first! - rt.now()).toBeLessThan(5);

    await rt.advance(first! + HOUR - rt.now() - 1);
    expect(await items()).toHaveLength(1);
    await rt.advance(1);
    expect((await items()).map((i) => i.at)).toEqual([first, first! + HOUR]);
    // The run due at the very instant `advance` stops at is armed once the previous run's commit settles.
    await rt.advance(2 * HOUR);
    await rt.advance(1);
    expect((await items()).map((i) => i.at)).toEqual([first, first! + HOUR, first! + 2 * HOUR, first! + 3 * HOUR]);
  });
});

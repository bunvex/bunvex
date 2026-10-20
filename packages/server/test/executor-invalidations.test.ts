// The subscription invalidations Convex's scheduler and cron executor count (STUDY-149 PR 5, DV-480 resolved to
// match Convex): what a commit counts against each executor's read, as Convex's binary does
// (packages/differential/test/dashboard-ops.test.ts compares the same steps with it).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { defineSchema, Engine, setUserStopState } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { MetricsWindow } from "../src/app-metrics.ts";
import { Functions, mutation } from "../src/functions.ts";
import { makeScheduler } from "../src/scheduler.ts";
import { createServer } from "../src/server.ts";
import { cancelAllScheduledJobs, cancelScheduledJob } from "../src/system-functions.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

const HOUR = 3_600_000;

async function setup() {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  const functions = new Functions(engine).register("m", {
    schedule: mutation(async ({ scheduler }, { delayMs }: { delayMs: number }) =>
      scheduler.runAfter(delayMs, "m:work" as never, {}),
    ),
    work: mutation(async () => {}),
    fail: mutation(async () => {
      throw new Error("no");
    }),
    scheduleFail: mutation(async ({ scheduler }) => scheduler.runAfter(0, "m:fail" as never, {})),
  });
  const server = createServer({ engine, functions, port: 0 });
  stops.push(server.stop);
  /** Every pair with its count over the last ten minutes. */
  const counts = async () => {
    await Bun.sleep(150); // the executors' reads move after each commit
    const t = (ms: number) => ({ secs_since_epoch: Math.floor(ms / 1000), nanos_since_epoch: 0 });
    const end = Date.now() + 60_000;
    const w = MetricsWindow.parse(JSON.stringify({ start: t(end - 600_000), end: t(end), num_buckets: 1 }));
    return Object.fromEntries(
      functions.appMetrics!.subscriptionInvalidationsTopK(w, 25).map(([n, s]) => [n, s[0]![1]]),
    ) as Record<string, number | null>;
  };
  const schedule = async (delayMs: number) => {
    const id = (await functions.runMutation("m:schedule", { delayMs })) as string;
    await Bun.sleep(150);
    return id;
  };
  return { engine, functions, server, counts, schedule };
}

describe("the scheduler's subscription (Convex's `stream_jobs_to_run` read)", () => {
  test("a run scheduled on an empty queue counts; one after the next future run does not; the run itself is outside", async () => {
    const { engine, counts, schedule } = await setup();
    const first = await schedule(HOUR);
    expect(await counts()).toEqual({ "m.js:schedule:_scheduled_jobs": 1 });
    await schedule(2 * HOUR); // after the first: outside the executor's read
    expect(await counts()).toEqual({ "m.js:schedule:_scheduled_jobs": 1 });
    await cancelScheduledJob(engine, first); // the first future run: outside too
    await cancelAllScheduledJobs(engine);
    expect(await counts()).toEqual({ "m.js:schedule:_scheduled_jobs": 1 });
    await schedule(HOUR); // the queue is empty again
    expect(await counts()).toEqual({ "m.js:schedule:_scheduled_jobs": 2 });
  });

  test("a nearer run counts, and its run counts twice under the function's name", async () => {
    const { counts, schedule } = await setup();
    await schedule(HOUR);
    await schedule(100);
    await Bun.sleep(400);
    expect(await counts()).toEqual({ "m.js:schedule:_scheduled_jobs": 2, "m.js:work:_scheduled_jobs": 2 });
  });

  test("a failed run is saved under its function's name, as Convex's", async () => {
    const { functions, counts } = await setup();
    await functions.runMutation("m:scheduleFail", {});
    await Bun.sleep(400);
    const c = await counts();
    expect(c["m.js:fail:_scheduled_jobs"]).toBe(1);
  });

  test("paused, the executors read only the deployment's state: nothing counts", async () => {
    const { engine, functions, counts } = await setup();
    await engine.mutation((db) => setUserStopState(db, "paused"));
    await Bun.sleep(150);
    // functions do not run while paused: the write a scheduling mutation makes, under its name
    await engine.mutation((db) => makeScheduler(functions, { db }).runAfter(HOUR, "m:work" as never, {}), "m:schedule");
    expect(await counts()).toEqual({});
  });
});

// The server's synchronous `stop()` stops this too, as `shutdown()` does (STUDY-174 S5): the engine may stay open
// after it (an embedder's, a test's), and nothing of the stopped server reads it or counts its commits any more.
describe("after the server's stop()", () => {
  test("no read when the next run falls due", async () => {
    const { engine, server, counts, schedule } = await setup();
    await schedule(1000); // the read's boundary: a timer at the run's time
    expect(await counts()).toEqual({ "m.js:schedule:_scheduled_jobs": 1 });
    server.stop();
    const reads = spyOn(engine, "query");
    try {
      await Bun.sleep(1000); // past the run's time
      expect(reads).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
    }
  });

  test("a commit into the executor's read counts nothing", async () => {
    const { server, counts, functions } = await setup();
    await Bun.sleep(150); // the first reads: an empty queue, so any scheduled run is inside
    server.stop();
    await functions.runMutation("m:schedule", { delayMs: HOUR });
    expect(await counts()).toEqual({});
  });
});

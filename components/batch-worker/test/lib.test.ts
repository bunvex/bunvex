// Upstream's component tests (`src/component/lib.test.ts` of get-convex/batch-worker 0.3.6, STUDY-196 §1.9), ported
// to `@bunvex/testing`: the component's functions pushed as the app's (fixtures/standalone), its helpers called
// inside `t.run` with a `ctx.log`, as upstream calls them inside convex-test's `t.run`. The work handles are dummies
// that are never run: nothing here moves the clock, so no scheduled function runs.
//
// Two of upstream's tools differ here. The virtual clock replaces vitest's fake timers: `t.advanceTime` moves it,
// running what falls due. A runner stuck pending in the past (upstream: `vi.setSystemTime` far past it, the runner
// never run) is made by scheduling the loop's run at a time 10 minutes ago, which leaves it pending at that time.
// biome-ignore-all lint/suspicious/noExplicitAny: the inline functions' ctx and the app's api are untyped
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { anyApi } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import type { MutationCtx } from "../src/component/functions.ts";
import {
  continueRunning,
  ensureMonitored,
  getOrCreateWorkerState,
  getWorker,
  scheduleWaiting,
  start,
} from "../src/component/kick.ts";
import { createMockLogger, type Logger } from "../src/component/logging.ts";
import { RUNNING_THRESHOLD_MS } from "../src/component/shared.ts";

// Each test pushes its own deployment first, which takes longer than bun's 5 s default on a busy machine.
setDefaultTimeout(30_000);

const api = anyApi as any;
const STANDALONE = join(import.meta.dir, "fixtures", "standalone");
const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
function deployment() {
  const t = bunvexTest({ cwd: STANDALONE });
  open.push(t);
  return t;
}

/** Run `fn` in a mutation with `ctx.log` added (a silent mock unless one is given), as the builders add it. */
const run = <T>(t: TestBunvex, fn: (ctx: MutationCtx) => Promise<T>, log: Logger = createMockLogger()): Promise<T> =>
  t.run((ctx: any) => fn(Object.assign(ctx, { log })));

const QUERY = "function://dummyWorkQuery";
const MUTATION = "function://dummyWorkerMutation";
const pingArgs = (overrides?: Record<string, unknown>) => ({
  name: "",
  workQuery: QUERY,
  workerMutation: MUTATION,
  ...overrides,
});
const workerOf = (t: TestBunvex, name = "") => run(t, (ctx) => getWorker(ctx, name));
const stateOf = (t: TestBunvex, name = "") =>
  run(t, async (ctx) => getOrCreateWorkerState(ctx, (await getWorker(ctx, name))!));
const jobOf = (t: TestBunvex, id: string) => t.run((ctx: any) => ctx.db.system.get("_scheduled_functions", id));

/** Replace the worker's runner with a loop run due 10 minutes ago and still pending: a run the scheduler never ran. */
async function stuckRunner(t: TestBunvex): Promise<void> {
  await run(t, async (ctx) => {
    const worker = (await getWorker(ctx, ""))!;
    const state = await getOrCreateWorkerState(ctx, worker);
    if (state.runnerId) await ctx.scheduler.cancel(state.runnerId);
    const runnerId = await ctx.scheduler.runAt(Date.now() - 10 * 60 * 1000, api.loop.loop, {
      name: "",
      generation: state.generation,
    });
    await ctx.db.patch("workerState", state._id, { runnerId });
  });
}

describe("worker component", () => {
  test("ping creates the worker and schedules the loop", async () => {
    const t = deployment();
    await t.mutation(api.lib.ping, pingArgs());
    const worker = await workerOf(t);
    expect(worker?.status.kind).toBe("running");
    expect(worker?.workQuery).toBe(QUERY);
    const state = await stateOf(t);
    expect(state.monitorId).toBeDefined();
    expect(state.monitorRunAtMs).toBeDefined();
    expect(state.generation).toBe(1n);
    expect(state.runnerId).toBeDefined();
  });

  test("monitor is scheduled well after the loop", async () => {
    const t = deployment();
    await t.mutation(api.lib.ping, pingArgs());
    // The loop runs `debounceMs` out; the monitor 60 s beyond that.
    expect((await stateOf(t)).monitorRunAtMs).toBeGreaterThan(t.now() + 50_000);
  });

  test("ping is a no-op while running", async () => {
    const t = deployment();
    await t.mutation(api.lib.ping, pingArgs());
    const before = await stateOf(t);
    await t.mutation(api.lib.ping, pingArgs());
    const after = await stateOf(t);
    expect(after.generation).toBe(before.generation);
    expect(after.runnerId).toBe(before.runnerId);
  });

  test("status reflects the run state", async () => {
    const t = deployment();
    expect(await t.query(api.lib.status, { name: "" })).toBeNull();
    await t.mutation(api.lib.ping, pingArgs());
    expect((await t.query(api.lib.status, { name: "" }))?.kind).toBe("running");
  });

  test("stop cancels the loop and goes stopped", async () => {
    const t = deployment();
    await t.mutation(api.lib.ping, pingArgs());
    await t.mutation(api.lib.stop, { name: "" });
    expect((await workerOf(t))?.status.kind).toBe("stopped");
    const state = await stateOf(t);
    expect(state.monitorId).toBeUndefined();
    expect(state.runnerId).toBeUndefined();
  });

  test("start resumes an existing worker after stop", async () => {
    const t = deployment();
    await t.mutation(api.lib.ping, pingArgs());
    await t.mutation(api.lib.stop, { name: "" });
    await t.mutation(api.lib.start, { name: "" });
    expect((await workerOf(t))?.status.kind).toBe("running");
    // ping (generation 1), stop (2, so the cancelled run is stale), start (3).
    expect((await stateOf(t)).generation).toBe(3n);
  });

  test("start is a no-op for an unknown worker", async () => {
    const t = deployment();
    await t.mutation(api.lib.start, { name: "ghost" });
    expect(await t.query(api.lib.status, { name: "ghost" })).toBeNull();
  });

  test("logging is captured as a side-effect", async () => {
    const t = deployment();
    await t.mutation(api.lib.ping, pingArgs());
    const log = createMockLogger();
    // `start` on a running worker does nothing and says so at debug.
    await run(t, (ctx) => start(ctx, ""), log);
    expect(log.logs.some((l) => l.level === "debug" && String(l.args[0]).includes("[start]"))).toBe(true);
  });

  test("a superseded loop generation exits without changing state", async () => {
    const t = deployment();
    await t.mutation(api.lib.ping, pingArgs());
    await t.mutation(api.loop.loop, { name: "", generation: 0n });
    expect((await stateOf(t)).generation).toBe(1n);
  });

  test("ping interrupts a worker sleeping far in the future", async () => {
    const t = deployment();
    await t.mutation(api.lib.ping, pingArgs());
    // Asleep well past RUNNING_THRESHOLD_MS: idle, its run pending far out.
    await run(t, async (ctx) => scheduleWaiting(ctx, (await getWorker(ctx, ""))!, 10 * RUNNING_THRESHOLD_MS));
    expect((await workerOf(t))?.status.kind).toBe("idle");
    const before = await stateOf(t);
    expect(before.runnerId).toBeDefined();

    await t.mutation(api.lib.ping, { name: "", workQuery: "", workerMutation: "" });

    const after = await stateOf(t);
    expect((await workerOf(t))?.status.kind).toBe("running");
    expect(after.generation > before.generation).toBe(true);
    expect(after.runnerId).not.toBe(before.runnerId);
  });

  test("waking from a wait refreshes the cooldown window", async () => {
    const t = deployment();
    await t.mutation(api.lib.ping, pingArgs());
    await run(t, async (ctx) => scheduleWaiting(ctx, (await getWorker(ctx, ""))!, 60_000));
    // Upstream moves the clock 10 s without running anything; here nothing is due within those 10 s but the
    // first run (at once), which fails on its dummy handles and leaves the wait's run untouched.
    await t.advanceTime(10_000);

    await t.mutation(api.lib.ping, pingArgs());

    // A woken run gets a whole cooldown window, so a queue with nothing runnable cannot bounce back to idle on
    // every ping.
    expect((await stateOf(t)).lastWorkTs).toBe(t.now());
  });

  test("continueRunning from idle refreshes the cooldown window", async () => {
    const t = deployment();
    await t.mutation(api.lib.ping, pingArgs());
    await run(t, async (ctx) => scheduleWaiting(ctx, (await getWorker(ctx, ""))!, 60_000));
    const now = await run(t, async (ctx) => {
      await continueRunning(ctx, (await getWorker(ctx, ""))!, 0);
      return Date.now();
    });
    expect((await workerOf(t))?.status.kind).toBe("running");
    expect((await stateOf(t)).lastWorkTs).toBe(now);
  });

  test("ping is a no-op when the loop will run soon", async () => {
    const t = deployment();
    await t.mutation(api.lib.ping, pingArgs());
    // Asleep for less than RUNNING_THRESHOLD_MS: the loop is about to run, so a wake leaves it alone.
    await run(t, async (ctx) => scheduleWaiting(ctx, (await getWorker(ctx, ""))!, RUNNING_THRESHOLD_MS / 2));
    const before = await stateOf(t);

    await t.mutation(api.lib.start, { name: "" });

    const after = await stateOf(t);
    expect(after.generation).toBe(before.generation);
    expect(after.runnerId).toBe(before.runnerId);
  });

  test("ping keeps a loop scheduled within the debounce window but marks it running", async () => {
    const t = deployment();
    const config = { debounceMs: 20 * RUNNING_THRESHOLD_MS };
    await t.mutation(api.lib.ping, pingArgs({ config }));
    // Asleep past RUNNING_THRESHOLD_MS but sooner than a debounced run would be: cancelling it would only delay.
    const sleptAt = await run(t, async (ctx) => {
      await scheduleWaiting(ctx, (await getWorker(ctx, ""))!, 10 * RUNNING_THRESHOLD_MS);
      return Date.now();
    });
    const before = await stateOf(t);

    await t.mutation(api.lib.ping, pingArgs({ config }));

    const after = await stateOf(t);
    expect(after.generation).toBe(before.generation);
    expect(after.runnerId).toBe(before.runnerId);
    expect((await workerOf(t))?.status.kind).toBe("running");
    // The kept run's cooldown window starts at its scheduled time.
    expect(after.lastWorkTs).toBe(sleptAt + 10 * RUNNING_THRESHOLD_MS);

    // Later pings stop at the status check.
    await t.mutation(api.lib.ping, pingArgs({ config }));
    expect((await stateOf(t)).runnerId).toBe(before.runnerId);
  });

  test("monitor restarts a dead loop and keeps watching", async () => {
    const t = deployment();
    await t.mutation(api.lib.ping, pingArgs());
    const before = await stateOf(t);
    await t.run((ctx: any) => ctx.scheduler.cancel(before.runnerId!));

    await t.mutation(api.monitor.monitor, { name: "" });

    const after = await stateOf(t);
    expect(after.generation > before.generation).toBe(true);
    expect(after.runnerId).not.toBe(before.runnerId);
    expect((await workerOf(t))?.status.kind).toBe("running");
    expect(after.monitorId).toBeDefined();
  });

  test("monitor stops itself once the worker is idle", async () => {
    const t = deployment();
    await t.mutation(api.lib.ping, pingArgs());
    await t.mutation(api.lib.stop, { name: "" });
    await t.mutation(api.monitor.monitor, { name: "" });
    expect((await workerOf(t))?.status.kind).toBe("stopped");
    expect((await stateOf(t)).monitorId).toBeUndefined();
  });

  // A loop run that the scheduler keeps retrying after system failures stays pending at its original time.
  describe("runner stuck pending in the past", () => {
    test("monitor recovers it instead of re-arming behind it", async () => {
      const t = deployment();
      await t.mutation(api.lib.ping, pingArgs());
      await stuckRunner(t);
      const before = await stateOf(t);

      await t.mutation(api.monitor.monitor, { name: "" });

      const after = await stateOf(t);
      expect(after.generation > before.generation).toBe(true);
      expect(after.runnerId).not.toBe(before.runnerId);
      // Cancelling the stuck run is what stops the scheduler retrying it.
      expect((await jobOf(t, before.runnerId!))?.state.kind).toBe("canceled");
      // Re-armed in the future: in the past it would fire again at once, forever.
      expect(after.monitorRunAtMs).toBeGreaterThan(t.now());
    });

    test("ensureMonitored never schedules the monitor in the past", async () => {
      const t = deployment();
      await t.mutation(api.lib.ping, pingArgs());
      // Upstream moves the clock 10 minutes past a loop time; here the loop time is 10 minutes ago, and the
      // existing monitor is forgotten so it is rescheduled.
      await run(t, async (ctx) => {
        const worker = (await getWorker(ctx, ""))!;
        await ctx.db.patch("workerState", worker.stateId, { monitorRunAtMs: undefined });
        await ensureMonitored(ctx, worker, Date.now() - 10 * 60 * 1000);
      });
      expect((await stateOf(t)).monitorRunAtMs).toBeGreaterThan(t.now());
    });

    test("monitor recovers it while the worker is waiting", async () => {
      const t = deployment();
      await t.mutation(api.lib.ping, pingArgs());
      // Waiting: idle with a run pending. The monitor is the only way out, since a ping keeps an imminent run.
      await run(t, async (ctx) => scheduleWaiting(ctx, (await getWorker(ctx, ""))!, 5000));
      await stuckRunner(t);
      const before = await stateOf(t);

      await t.mutation(api.monitor.monitor, { name: "" });

      const after = await stateOf(t);
      expect((await workerOf(t))?.status.kind).toBe("running");
      expect(after.generation > before.generation).toBe(true);
      expect(after.runnerId).not.toBe(before.runnerId);
      expect((await jobOf(t, before.runnerId!))?.state.kind).toBe("canceled");
    });

    test("monitor leaves an on-time pending runner alone", async () => {
      const t = deployment();
      await t.mutation(api.lib.ping, pingArgs());
      const before = await stateOf(t);

      await t.mutation(api.monitor.monitor, { name: "" });

      const after = await stateOf(t);
      expect(after.generation).toBe(before.generation);
      expect(after.runnerId).toBe(before.runnerId);
    });
  });

  test("kick recovers a worker whose scheduled functions were canceled", async () => {
    const t = deployment();
    await t.mutation(api.lib.ping, pingArgs());
    const before = await stateOf(t);
    // Both cancelled under the worker, as the dashboard's cancel-all does. The status stays running, so pings do
    // nothing, and the monitor that would recover the loop is gone.
    await t.run(async (ctx: any) => {
      await ctx.scheduler.cancel(before.runnerId!);
      await ctx.scheduler.cancel(before.monitorId!);
    });
    await t.mutation(api.lib.ping, pingArgs());
    expect((await stateOf(t)).runnerId).toBe(before.runnerId);

    await t.mutation(api.lib.kick, { name: "" });

    const after = await stateOf(t);
    expect((await workerOf(t))?.status.kind).toBe("running");
    expect(after.generation > before.generation).toBe(true);
    expect(after.runnerId).not.toBe(before.runnerId);
    expect(after.monitorId).not.toBe(before.monitorId);
    expect(after.monitorRunAtMs).toBeGreaterThan(t.now());
  });

  test("independent named workers don't interfere", async () => {
    const t = deployment();
    await t.mutation(api.lib.ping, pingArgs({ name: "a" }));
    await t.mutation(api.lib.ping, pingArgs({ name: "b" }));
    expect((await t.query(api.lib.status, { name: "a" }))?.kind).toBe("running");
    expect((await t.query(api.lib.status, { name: "b" }))?.kind).toBe("running");
    await t.mutation(api.lib.stop, { name: "a" });
    expect((await t.query(api.lib.status, { name: "a" }))?.kind).toBe("stopped");
    expect((await t.query(api.lib.status, { name: "b" }))?.kind).toBe("running");
  });
});

// More (STUDY-199 §3.4): every message of §1.6–§1.15, word for word: the errors thrown, the leveled log lines, and
// the `failed.error` texts the pool makes itself. Each is triggered through the component's functions (pushed as an
// app's, fixtures/standalone) or its helpers called inline; a deployed function's console reaches the test's.
// biome-ignore-all lint/suspicious/noExplicitAny: the inline functions' ctx is untyped
import { beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { createFunctionHandle } from "@bunvex/server";
import type { Id } from "../src/component/_generated/dataModel.ts";
import { validateConfig } from "../src/component/config.ts";
import { createLogger } from "../src/component/logging.ts";
import { boundScheduledTime, YEAR } from "../src/component/shared.ts";
import {
  api,
  captureLogs,
  components,
  emptyReport,
  enqueueWork,
  MINUTE,
  runLoop,
  scheduledGone,
  scheduledIn,
  setupTest,
} from "./helpers.ts";

setDefaultTimeout(30_000);

let t: ReturnType<typeof setupTest>;
beforeEach(() => {
  t = setupTest();
});
const setGlobals = (logLevel = "DEBUG", maxParallelism = 10) =>
  t.run((ctx: any) => ctx.db.insert("globals", { logLevel, maxParallelism }));
const seedState = (running: unknown[] = []) =>
  t.run((ctx: any) =>
    ctx.db.insert("internalState", {
      generation: 0n,
      segmentCursors: { incoming: 0n, completion: 0n, cancelation: 0n },
      lastRecovery: 0n,
      report: emptyReport(Date.now()),
      running,
    }),
  );
const item = (over: Record<string, unknown> = {}) => ({
  fnHandle: "h",
  fnName: "myFn",
  fnArgs: {},
  fnType: "mutation" as const,
  runAt: t.now(),
  config: {},
  ...over,
});
const runningEntry = (workId: Id<"work">, scheduledId: Id<"_scheduled_functions">, started = t.now()) => ({
  workId,
  scheduledId,
  started,
});
const logsOf = async (fn: () => Promise<unknown>) => (await captureLogs(fn)).lines;

describe("config (§1.6)", () => {
  it("refuses maxParallelism above 200 and below 0, and warns above 100", async () => {
    await expect(t.mutation(api.config.update, { maxParallelism: 201 })).rejects.toThrow(
      "maxParallelism must be <= 200",
    );
    await expect(t.mutation(api.config.update, { maxParallelism: -1 })).rejects.toThrow("maxParallelism must be >= 0");
    const lines = await logsOf(() => t.mutation(api.config.update, { maxParallelism: 150 }));
    expect(lines).toContain(
      "warn: maxParallelism should be <= 100, but is set to 150. This will be an error in a future version.",
    );
    // The warning is at the config's level: none at ERROR.
    expect(await logsOf(async () => validateConfig({ maxParallelism: 150, logLevel: "ERROR" }))).toEqual([]);
    // 0 is allowed, and so is a fraction (no integer check).
    await t.mutation(api.config.update, { maxParallelism: 0 });
    await t.mutation(api.config.update, { maxParallelism: 2.5 });
    expect((await t.run((ctx: any) => ctx.db.query("globals").unique()))?.maxParallelism).toBe(2.5);
  });

  it("an invalid config writes nothing", async () => {
    await expect(t.mutation(api.lib.enqueue, item({ config: { maxParallelism: 500 } }))).rejects.toThrow(
      "maxParallelism must be <= 200",
    );
    expect(await t.run((ctx: any) => ctx.db.query("globals").collect())).toEqual([]);
  });

  it("update kicks the loop only when raising maxParallelism", async () => {
    const kind = async () =>
      ((await t.query(components.batchWorker.lib.status, { name: "main" })) as any)?.kind ?? null;
    await t.mutation(api.config.update, { maxParallelism: 5 });
    expect(await kind()).toBeNull();
    await t.mutation(api.config.update, { maxParallelism: 6 });
    expect(await kind()).toBe("running");
  });
});

describe("enqueue (§1.7)", () => {
  it("bounds a start time too old or too far ahead", async () => {
    const log = createLogger("REPORT");
    const now = Date.now();
    const old = await captureLogs(async () => boundScheduledTime(now - 2 * YEAR, log));
    expect(old.result).toBeGreaterThanOrEqual(now);
    expect(old.lines).toEqual([`error: scheduled time is too old, defaulting to now ${now - 2 * YEAR}`]);
    const far = await captureLogs(async () => boundScheduledTime(now + 5 * YEAR, log));
    // Past four years, the job runs one year from now.
    expect(far.result).toBeGreaterThanOrEqual(now + YEAR);
    expect(far.result).toBeLessThan(now + YEAR + 1000);
    expect(far.lines).toEqual([
      `error: scheduled time is too far in the future, defaulting to 1 year from now ${now + 5 * YEAR}`,
    ]);
    const ok = now + 3 * YEAR;
    expect(boundScheduledTime(ok, log)).toBe(ok);
  });

  it("refuses arguments or a context over 1 000 000 bytes", async () => {
    const big = "x".repeat(1_000_001);
    await expect(t.mutation(api.lib.enqueue, item({ fnArgs: { big } }))).rejects.toThrow(
      /Function arguments for function myFn too large: 1000\d{3} bytes \(max: 1000000 bytes\)/,
    );
    await expect(t.mutation(api.lib.enqueue, item({ onComplete: { fnHandle: "c", context: big } }))).rejects.toThrow(
      /OnComplete context for function myFn too large: 1000\d{3} bytes \(max: 1000000 bytes\)/,
    );
  });

  it("keeps small arguments and context inline, and moves large ones to payload", async () => {
    const row = (id: Id<"work">) =>
      t.run(async (ctx: any) => {
        const work = await ctx.db.get("work", id);
        return { work, payload: work.payloadId ? await ctx.db.get("payload", work.payloadId) : null };
      });
    const small = await t.mutation(
      api.lib.enqueue,
      item({ fnArgs: { a: 1 }, onComplete: { fnHandle: "c", context: 1 } }),
    );
    expect((await row(small)).work).toMatchObject({ fnArgs: { a: 1 }, onComplete: { context: 1 } });
    expect((await row(small)).work.payloadId).toBeUndefined();
    // Large arguments move; a small context stays.
    const largeArgs = await t.mutation(
      api.lib.enqueue,
      item({ fnArgs: { a: "x".repeat(9000) }, onComplete: { fnHandle: "c", context: 1 } }),
    );
    let r = await row(largeArgs);
    expect(r.work.fnArgs).toBeUndefined();
    expect(r.work.onComplete.context).toBe(1);
    expect(r.payload.args).toEqual({ a: "x".repeat(9000) });
    expect(r.work.payloadSize).toBeGreaterThan(9000);
    // Both large: both move.
    const both = await t.mutation(
      api.lib.enqueue,
      item({ fnArgs: { a: "x".repeat(9000) }, onComplete: { fnHandle: "c", context: "y".repeat(9000) } }),
    );
    r = await row(both);
    expect(r.work.onComplete.context).toBeUndefined();
    expect(r.payload.context).toBe("y".repeat(9000));
    // Small, but not together: the context alone moves.
    const together = await t.mutation(
      api.lib.enqueue,
      item({ fnArgs: { a: "x".repeat(5000) }, onComplete: { fnHandle: "c", context: "y".repeat(5000) } }),
    );
    r = await row(together);
    expect(r.work.fnArgs).toEqual({ a: "x".repeat(5000) });
    expect(r.work.onComplete.context).toBeUndefined();
    expect(r.payload).toMatchObject({ context: "y".repeat(5000) });
    expect(r.payload.args).toBeUndefined();
  });

  it("starts a job due in the past at the current segment", async () => {
    const id = await t.mutation(api.lib.enqueue, item({ runAt: t.now() - 60_000 }));
    const start = (await t.run((ctx: any) => ctx.db.query("pendingStart").unique())) as any;
    expect(start.workId).toBe(id);
    expect(Number(start.segment)).toBeGreaterThanOrEqual(Math.floor((t.now() - 1) / 100));
  });
});

describe("cancel (§1.8)", () => {
  it("warns about a job that is gone or already being canceled", async () => {
    await setGlobals("WARN");
    const id = await t.mutation(api.lib.enqueue, item());
    await t.mutation(api.lib.cancel, { id });
    expect(await logsOf(() => t.mutation(api.lib.cancel, { id }))).toEqual([
      `warn: [cancel] work ${id} has already been canceled`,
    ]);
    await t.run(async (ctx: any) => {
      await ctx.db.delete("work", id);
    });
    expect(await logsOf(() => t.mutation(api.lib.cancel, { id }))).toEqual([`warn: [cancel] work ${id} doesn't exist`]);
  });

  it("cancel overwrites the stored log level, never maxParallelism", async () => {
    await setGlobals("WARN", 7);
    const id = await t.mutation(api.lib.enqueue, item());
    await t.mutation(api.lib.cancel, { id, logLevel: "ERROR" });
    expect(await t.run((ctx: any) => ctx.db.query("globals").unique())).toMatchObject({
      logLevel: "ERROR",
      maxParallelism: 7,
    });
  });

  it("cancelAll with limit 1 re-reads its boundary row, and with limit 0 throws a TypeError", async () => {
    await setGlobals("WARN");
    // Due in an hour, so that the loop moving with the clock does not start it.
    const id = await t.mutation(api.lib.enqueue, item({ runAt: t.now() + 60 * MINUTE }));
    await t.advanceTime(2);
    await t.mutation(api.lib.cancelAll, { limit: 1 });
    // The page was full: the next page starts at that row's creation time, inclusive.
    const next = (await t.run((ctx: any) => ctx.db.system.query("_scheduled_functions").collect())) as any[];
    const again = next.find((s) => /^lib(\.js)?:cancelAll$/.test(s.name));
    expect(again.args[0]).toMatchObject({ limit: 1 });
    const work = (await t.run((ctx: any) => ctx.db.get("work", id))) as any;
    expect(again.args[0].before).toBe(work._creationTime);
    const lines = await logsOf(() => t.mutation(api.lib.cancelAll, again.args[0]));
    expect(lines).toEqual([`warn: [cancel] work ${id} has already been canceled`]);
    await expect(t.mutation(api.lib.cancelAll, { limit: 0 })).rejects.toThrow(/TypeError|undefined/);
  });
});

describe("the loop (§1.9)", () => {
  it("logs each skipped completion, retry, cancelation, recovery and start", async () => {
    await setGlobals("DEBUG");
    const [notRunning, noRetry, gone, retrying, alreadyQueued, missing] = await t.run(async (ctx: any) => {
      const ids: Id<"work">[] = [];
      for (let i = 0; i < 6; i++)
        ids.push(
          await ctx.db.insert("work", { fnType: "action", fnHandle: "h", fnName: "h", fnArgs: {}, attempts: 1 }),
        );
      return ids;
    });
    const scheduledId = await scheduledIn(t, "pending");
    await seedState([noRetry, gone, retrying, alreadyQueued].map((w) => runningEntry(w!, scheduledId)));
    await t.run(async (ctx: any) => {
      const completion = (workId: Id<"work">, retry: boolean) =>
        ctx.db.insert("pendingCompletion", {
          workId,
          segment: 1n,
          retry,
          runResult: { kind: "failed", error: "e" },
        });
      await completion(notRunning!, false);
      // A retry with no retryBehavior, one whose work is gone, one being canceled, one already queued.
      await completion(noRetry!, true);
      await completion(gone!, true);
      await ctx.db.delete("work", gone);
      await completion(retrying!, true);
      await ctx.db.patch("work", retrying, { retryBehavior: { maxAttempts: 5, initialBackoffMs: 1, base: 1 } });
      await ctx.db.insert("pendingCancelation", { workId: retrying, segment: 10n ** 13n });
      await completion(alreadyQueued!, true);
      await ctx.db.patch("work", alreadyQueued, { retryBehavior: { maxAttempts: 5, initialBackoffMs: 1, base: 1 } });
      await ctx.db.insert("pendingStart", { workId: alreadyQueued, segment: 10n ** 13n });
      // A cancelation of a job that is gone, and a start of one.
      await ctx.db.insert("pendingCancelation", { workId: missing, segment: 1n });
      await ctx.db.delete("work", missing);
      const startless = await ctx.db.insert("work", { fnType: "action", fnHandle: "h", fnName: "h", attempts: 0 });
      await ctx.db.insert("pendingStart", { workId: startless, segment: 1n });
      await ctx.db.delete("work", startless);
      return startless;
    });
    const lines = await logsOf(() => runLoop(t));
    expect(lines).toContain(`error: [main] completing ${notRunning} but it's not in "running"`);
    expect(lines).toContain(`warn: [main] ${noRetry} has no retryBehavior so not retrying`);
    expect(lines).toContain(`warn: [main] ${gone} is gone, but trying to complete`);
    expect(lines).toContain(`warn: [main] ${retrying} in pendingCancelation so not retrying`);
    expect(lines).toContain(`error: [main] ${alreadyQueued} already in pendingStart so not retrying`);
    expect(lines).toContain(`warn: [main] ${missing} is gone, but trying to cancel`);
    expect(lines.some((l) => /^error: Trying to start, but work not found: \w+$/.test(l))).toBe(true);
    expect(lines).toContain("debug: [main] completed 4 work");
    expect(lines).toContain("debug: [main] attempting to cancel 2");
  });

  it("logs a job already running, and one gone at recovery", async () => {
    await setGlobals("DEBUG");
    const scheduledId = await scheduledIn(t, "pending");
    const [running, gone] = await t.run(async (ctx: any) => {
      const a = await ctx.db.insert("work", { fnType: "action", fnHandle: "h", fnName: "h", attempts: 0 });
      const b = await ctx.db.insert("work", { fnType: "action", fnHandle: "h", fnName: "h", attempts: 0 });
      await ctx.db.insert("pendingStart", { workId: a, segment: 1n });
      await ctx.db.delete("work", b);
      return [a, b];
    });
    await seedState([runningEntry(running, scheduledId), runningEntry(gone, scheduledId, t.now() - 10 * MINUTE)]);
    const lines = await logsOf(() => runLoop(t));
    expect(lines).toContain(`error: [main] ${running} already running (skipping start)`);
    expect(lines).toContain(`error: [main] ${gone} already gone (skipping recovery)`);
  });

  it("throws on an unknown fnType", async () => {
    await setGlobals("ERROR");
    await seedState();
    // The schema refuses an unknown fnType; the loop's check is reached only through a stale row's shape, so the
    // helper is driven inline with one.
    await enqueueWork(t);
    const batch = (await t.query(api.loop.getBatch, { name: "main" })) as any;
    await t.run(async (ctx: any) => {
      const w = await ctx.db.query("work").first();
      const original = ctx.db.get.bind(ctx.db);
      ctx.db.get = async (table: string, id: string) => {
        const doc = await original(table, id);
        return table === "work" && id === w._id ? { ...doc, fnType: "cron" } : doc;
      };
      const { run } = await import("../src/component/loop.ts");
      const handler = (run as any)._handler ?? (run as any).handler;
      expect(handler).toBeDefined();
      await expect(handler(ctx, batch.batch)).rejects.toThrow("Unexpected fnType cron");
    });
  });
});

describe("running the work (§1.10)", () => {
  it("fails a job whose payload is gone with assert's empty message", async () => {
    await setGlobals("ERROR");
    const workId = await t.mutation(api.lib.enqueue, item({ fnType: "action", fnArgs: { a: "x".repeat(9000) } }));
    const payloadId = ((await t.run((ctx: any) => ctx.db.get("work", workId))) as any).payloadId;
    await t.run((ctx: any) => ctx.db.delete("payload", payloadId));
    await expect(t.query(api.worker.getWorkArgs, { payloadId })).rejects.toThrow();
    const err = await t.query(api.worker.getWorkArgs, { payloadId }).catch((e) => e);
    expect(err.message).toMatch(/^(Uncaught Error: ?)?\s*(\n|$)/);
  });
});

describe("complete (§1.11)", () => {
  it("logs zero jobs, a gone job, a mismatched attempt and a duplicate", async () => {
    await setGlobals("DEBUG");
    const lines0 = await logsOf(() => t.mutation(api.complete.complete, { jobs: [] }));
    expect(lines0).toEqual(["warn: Trying to complete 0 jobs"]);
    const id = await t.mutation(
      api.lib.enqueue,
      item({ retryBehavior: { maxAttempts: 5, initialBackoffMs: 1, base: 1 } }),
    );
    const failed = { kind: "failed", error: "e" };
    expect(
      await logsOf(() => t.mutation(api.complete.complete, { jobs: [{ workId: id, runResult: failed, attempt: 3 }] })),
    ).toContain(`warn: [complete] ${id} mismatched attempt number`);
    await t.mutation(api.complete.complete, { jobs: [{ workId: id, runResult: failed, attempt: 0 }] });
    expect(
      await logsOf(() => t.mutation(api.complete.complete, { jobs: [{ workId: id, runResult: failed, attempt: 1 }] })),
    ).toContain(`warn: [complete] ${id} already in pendingCompletion`);
    await t.run((ctx: any) => ctx.db.delete("work", id));
    expect(
      await logsOf(() => t.mutation(api.complete.complete, { jobs: [{ workId: id, runResult: failed, attempt: 2 }] })),
    ).toContain(`warn: [complete] ${id} is done, but its work is gone`);
  });

  it("logs a scheduled onComplete, one that cannot be scheduled, and a payload it cannot delete", async () => {
    await setGlobals("DEBUG");
    const handle = await t.run(() => createFunctionHandle(api.testing.complete));
    const ok = await t.mutation(api.lib.enqueue, item({ onComplete: { fnHandle: handle } }));
    expect(
      await logsOf(() =>
        t.mutation(api.complete.complete, { jobs: [{ workId: ok, runResult: { kind: "canceled" }, attempt: 0 }] }),
      ),
    ).toContain(`debug: [complete] onComplete for ${ok} scheduled`);
    const bad = await t.mutation(
      api.lib.enqueue,
      item({ fnArgs: { a: "x".repeat(9000) }, onComplete: { fnHandle: "not a handle" } }),
    );
    const payloadId = ((await t.run((ctx: any) => ctx.db.get("work", bad))) as any).payloadId;
    await t.run((ctx: any) => ctx.db.delete("payload", payloadId));
    const lines = await logsOf(() =>
      t.mutation(api.complete.complete, { jobs: [{ workId: bad, runResult: { kind: "canceled" }, attempt: 0 }] }),
    );
    expect(lines.some((l) => l.startsWith(`error: [complete] error running onComplete for ${bad}`))).toBe(true);
    expect(lines.some((l) => l.startsWith(`warn: [complete] couldn't delete payload for ${bad}: `))).toBe(true);
    // The job still ended.
    expect(await t.run((ctx: any) => ctx.db.get("work", bad))).toBeNull();
  });

  it("an inline onComplete that throws is logged and scheduled instead", async () => {
    await setGlobals("ERROR");
    const handle = await t.run(() => createFunctionHandle(api.testing.fail));
    const id = await t.mutation(api.lib.enqueue, item({ fnType: "action", onComplete: { fnHandle: handle } }));
    const lines = await logsOf(() =>
      t.mutation(api.complete.complete, {
        jobs: [{ workId: id, runResult: { kind: "success", returnValue: 1 }, attempt: 0, runOnCompleteInline: true }],
      }),
    );
    expect(
      lines.some((l) =>
        l.startsWith(`error: [complete] caught error while running onComplete inline for ${id}, scheduling instead: `),
      ),
    ).toBe(true);
  });
});

describe("recovery (§1.12)", () => {
  it("logs each skip and each state it finds", async () => {
    await setGlobals("DEBUG");
    const [completing, gone, moved, missing, failed, canceled] = await t.run(async (ctx: any) => {
      const ids: Id<"work">[] = [];
      for (let i = 0; i < 6; i++)
        ids.push(await ctx.db.insert("work", { fnType: "action", fnHandle: "h", fnName: "h", attempts: 0 }));
      await ctx.db.insert("pendingCompletion", {
        workId: ids[0],
        segment: 1n,
        retry: false,
        runResult: { kind: "success", returnValue: null },
      });
      await ctx.db.delete("work", ids[1]);
      await ctx.db.patch("work", ids[2], { attempts: 4 });
      return ids;
    });
    const gc = await scheduledGone(t);
    const f = await scheduledIn(t, "failed");
    const c = await scheduledIn(t, "canceled");
    const job = (workId: Id<"work">, scheduledId: Id<"_scheduled_functions">) => ({
      workId,
      scheduledId,
      attempt: 0,
      started: t.now(),
    });
    const lines = await logsOf(() =>
      t.mutation(api.recovery.recover, {
        jobs: [
          job(completing!, f),
          job(gone!, f),
          job(moved!, f),
          job(missing!, gc),
          job(failed!, f),
          job(canceled!, c),
        ],
      }),
    );
    const pre = (sid: string, wid: string) => `[recovery] Scheduled job ${sid} for work ${wid}`;
    expect(lines).toContain(`debug: ${pre(f, completing!)} already in pendingCompletion, skipping`);
    expect(lines).toContain(`warn: ${pre(f, gone!)} work not found, skipping`);
    expect(lines).toContain(`warn: ${pre(f, moved!)} attempts mismatch, skipping`);
    expect(lines).toContain(`warn: ${pre(gc, missing!)} not found in _scheduled_functions`);
    expect(lines).toContain(`debug: ${pre(f, failed!)} failed and detected in recovery`);
    expect(lines).toContain(`debug: ${pre(c, canceled!)} was canceled and detected in recovery`);
  });
});

describe("stats and logging (§1.13)", () => {
  it("refuses an unknown log level and a bad time range", async () => {
    expect(() => createLogger("LOUD" as never)).toThrow("Invalid log level: LOUD");
    for (const [startTime, endTimeExclusive] of [
      [Number.NaN, 1],
      [0, Number.POSITIVE_INFINITY],
      [10, 10],
      [0, 24 * 60 * MINUTE + 1],
    ]) {
      await expect(t.query(api.stats.scheduledFunctionsInRange, { startTime, endTimeExclusive })).rejects.toThrow(
        "Invalid scheduled-function time range",
      );
    }
  });

  it("running and diagnostics describe the queue", async () => {
    await setGlobals("WARN", 4);
    const scheduledId = await scheduledIn(t, "pending");
    const a = await t.mutation(api.lib.enqueue, item({ fnName: "a" }));
    const b = await t.mutation(api.lib.enqueue, item({ fnName: "b" }));
    await t.run((ctx: any) => ctx.db.delete("work", b));
    await seedState([runningEntry(a, scheduledId, 5), runningEntry(b, scheduledId, 6)]);
    expect(await t.query(api.stats.running, {})).toEqual([
      { workId: a, scheduledId, fnName: "a", started: 5, attempts: 0 },
      { workId: b, scheduledId, fnName: "<unknown>", started: 6, attempts: 0 },
    ]);
    await t.mutation(api.lib.cancel, { id: a });
    expect(await t.query(api.stats.diagnostics, {})).toEqual({
      canceling: 1,
      waiting: 2,
      running: 2,
      completing: 0,
      spareCapacity: 2,
      runStatus: "running",
    });
  });
});

describe("danger (§1.14)", () => {
  it("clears pending work and old work, with its lines", async () => {
    await setGlobals("WARN");
    const ids: Id<"work">[] = [];
    // Due in an hour, so that the loop moving with the clock does not start them.
    const later = t.now() + 60 * MINUTE;
    for (let i = 0; i < 3; i++) ids.push(await t.mutation(api.lib.enqueue, item({ fnArgs: { i }, runAt: later })));
    await t.advanceTime(2);
    const cutoff = t.now();
    const pending = await logsOf(() => t.mutation(api.danger.clearPending, { before: cutoff }));
    expect(pending).toEqual([
      `log: Clearing pending before ${new Date(cutoff).toUTCString()}`,
      "log: Done clearing pending entries. 3 in the last batch.",
    ]);
    expect(await t.run((ctx: any) => ctx.db.query("work").collect())).toEqual([]);

    const more = await t.mutation(api.lib.enqueue, item({ fnArgs: { j: 1 }, runAt: later }));
    await t.mutation(api.lib.cancel, { id: more });
    const old = await logsOf(() => t.mutation(api.danger.clearOldWork, { olderThan: 0 }));
    expect(old[0]).toMatch(/^log: Clearing old work before .+ GMT$/);
    expect(old).toContain("debug: cleared myFn: [object Object] (pendingStart, pendingCancelation)");
    expect(old.at(-1)).toBe("log: Done clearing old work. 1 in the last batch.");
  });

  it("stops after 100 rows and schedules the rest", async () => {
    await setGlobals("WARN");
    const later = t.now() + 60 * MINUTE;
    const items = Array.from({ length: 101 }, (_, i) => {
      const { config: _config, ...rest } = item({ fnArgs: { i }, runAt: later });
      return rest;
    });
    await t.mutation(api.lib.enqueueBatch, { items, config: {} });
    await t.advanceTime(2);
    const lines = await logsOf(() => t.mutation(api.danger.clearPending, { olderThan: 0 }));
    expect(lines[1]).toMatch(/^log: Continuing after 101 entries, \d+ bytes$/);
    const scheduled = (await t.run((ctx: any) => ctx.db.system.query("_scheduled_functions").collect())) as any[];
    expect(scheduled.some((s) => /^danger(\.js)?:clearPending$/.test(s.name))).toBe(true);
    expect(await t.run((ctx: any) => ctx.db.query("pendingStart").collect())).toHaveLength(1);
  });
});

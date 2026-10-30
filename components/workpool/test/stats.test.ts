// Upstream's `src/component/stats.test.ts` (get-convex/workpool 0.4.14 at 7fde769, STUDY-199 §1.19), ported: the
// minute's report, written inline when the overdue starts fit in one page, else by a scheduled
// `calculateBacklogAndReport`. Where upstream cannot see the scheduled mutation's event, this port reads it from the
// console.
// biome-ignore-all lint/suspicious/noExplicitAny: the inline functions' ctx is untyped
import { beforeEach, describe, expect, it, mock, setDefaultTimeout } from "bun:test";
import type { Logger } from "../src/component/logging.ts";
import { generateReport } from "../src/component/stats.ts";
import { api, captureLogs, MINUTE, setupTest } from "./helpers.ts";

setDefaultTimeout(30_000);

const createLoggerMock = () =>
  ({
    event: mock(),
    debug: mock(),
    info: mock(),
    warn: mock(),
    error: mock(),
    time: mock(),
    timeEnd: mock(),
  }) satisfies Logger;

let t: ReturnType<typeof setupTest>;
beforeEach(() => {
  t = setupTest();
});
const insertState = (report: Record<string, number>) =>
  t.run((ctx: any) =>
    ctx.db.insert("internalState", {
      generation: 1n,
      segmentCursors: { incoming: 0n, completion: 0n, cancelation: 0n },
      lastRecovery: 0n,
      report: { completed: 0, succeeded: 0, failed: 0, retries: 0, canceled: 0, lastReportTs: 0, ...report },
      running: [],
    }),
  );
const addPendingStarts = async (n: number, segment = 5n) => {
  for (let i = 0; i < n; i++) {
    await t.run(async (ctx: any) => {
      const workId = await ctx.db.insert("work", {
        fnType: "mutation",
        fnHandle: "testHandle",
        fnName: `testFunction${i}`,
        fnArgs: { test: i },
        attempts: 0,
      });
      await ctx.db.insert("pendingStart", { workId, segment });
    });
  }
};
const scheduledNames = () =>
  t.run(async (ctx: any) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).map((sf: any) => sf.name),
  ) as Promise<string[]>;

describe("generateReport", () => {
  it("should not generate a report when log level is above REPORT", async () => {
    const stateId = await insertState({});
    const logger = createLoggerMock();
    await t.run(async (ctx: any) => {
      const state = await ctx.db.get("internalState", stateId);
      await generateReport(ctx, logger, state, { maxParallelism: 10, logLevel: "WARN" });
    });
    expect(logger.event).not.toHaveBeenCalled();
  });

  it("should generate a report when backlog is small enough", async () => {
    const stateId = await insertState({ completed: 10, succeeded: 6, failed: 2, retries: 2 });
    await addPendingStarts(1);
    const logger = createLoggerMock();
    await t.run(async (ctx: any) => {
      const state = await ctx.db.get("internalState", stateId);
      await generateReport(ctx, logger, state, { maxParallelism: 10, logLevel: "REPORT" });
    });
    expect(logger.event).toHaveBeenCalledWith("report", {
      backlog: 1,
      running: 0,
      completed: 10,
      succeeded: 6,
      failed: 2,
      retries: 2,
      canceled: 0,
      // (2 + 2) / 10 and 2 / (10 - 2).
      failureRate: 0.4,
      permanentFailureRate: 0.25,
      lastReportTs: expect.any(Number),
    });
  });

  it("should schedule calculateBacklogAndReport when backlog is large", async () => {
    const stateId = await insertState({ completed: 10, succeeded: 8, failed: 1, retries: 1 });
    const maxParallelism = 50;
    await addPendingStarts(maxParallelism + 1);
    const logger = createLoggerMock();
    await t.run(async (ctx: any) => {
      const state = await ctx.db.get("internalState", stateId);
      await generateReport(ctx, logger, state, { maxParallelism, logLevel: "REPORT" });
    });
    expect((await scheduledNames()).some((n) => /^stats(\.js)?:calculateBacklogAndReport$/.test(n))).toBe(true);
    expect(logger.event).not.toHaveBeenCalled();
  });

  it("should calculate backlog and report correctly", async () => {
    const stateId = await insertState({ completed: 10, succeeded: 8, failed: 1, retries: 1 });
    await addPendingStarts(3);
    // And one in the future: the scheduled count takes the whole table (STUDY-199 §2.3).
    await addPendingStarts(1, 10n ** 13n);
    const state = (await t.run((ctx: any) => ctx.db.get("internalState", stateId))) as any;
    const { lines } = await captureLogs(() =>
      t.mutation(api.stats.calculateBacklogAndReport, {
        startSegment: 0n,
        endSegment: 10n ** 12n,
        report: state.report,
        running: state.running.length,
        logLevel: "REPORT",
      }),
    );
    expect((await scheduledNames()).some((n) => n.includes("calculateBacklogAndReport"))).toBe(false);
    const reports = lines.filter((l) => l.startsWith("info: ")).map((l) => JSON.parse(l.slice("info: ".length)));
    // The stored report's fields come back in the document's order (sorted), as from Convex's backend.
    expect(reports).toEqual([
      {
        component: "workpool",
        event: "report",
        completed: 10,
        succeeded: 8,
        failed: 1,
        retries: 1,
        canceled: 0,
        lastReportTs: 0,
        running: 0,
        backlog: 4,
        failureRate: 0.2,
        permanentFailureRate: 0.1111,
      },
    ]);
  });
});

// More (STUDY-199 §1.13): the report's cadence in `run`, and the events' fields.
describe("events", () => {
  it("writes enqueued, started and completed at INFO, and the report once a minute", async () => {
    await t.run(async (ctx: any) => {
      await ctx.db.insert("globals", { maxParallelism: 10, logLevel: "INFO" });
      await ctx.db.insert("internalState", {
        generation: 0n,
        segmentCursors: { incoming: 0n, completion: 0n, cancelation: 0n },
        lastRecovery: 0n,
        report: {
          completed: 0,
          succeeded: 0,
          failed: 0,
          retries: 0,
          canceled: 0,
          lastReportTs: Date.now() - 2 * MINUTE,
        },
        running: [],
      });
    });
    const { lines } = await captureLogs(async () => {
      const id = await t.mutation(api.lib.enqueue, {
        fnHandle: "h",
        fnName: "myFn",
        fnArgs: {},
        fnType: "mutation",
        runAt: t.now(),
        config: {},
      });
      const batch = (await t.query(api.loop.getBatch, { name: "main" })) as any;
      await t.mutation(api.loop.run, batch.batch);
      await t.mutation(api.complete.complete, {
        jobs: [{ workId: id, runResult: { kind: "success", returnValue: 1 }, attempt: 0 }],
      });
      return id;
    });
    const events = lines
      .filter((l) => l.startsWith('info: {"component":"workpool"'))
      .map((l) => JSON.parse(l.slice("info: ".length)));
    expect(events.map((e) => e.event)).toEqual(["enqueued", "started", "report", "completed"]);
    const [enqueued, started, report, completed] = events;
    expect(Object.keys(enqueued)).toEqual(["component", "event", "workId", "fnName", "runAt", "enqueuedAt"]);
    expect(enqueued.fnName).toBe("myFn");
    expect(Object.keys(started)).toEqual([
      "component",
      "event",
      "workId",
      "fnName",
      "enqueuedAt",
      "scheduledFunctionId",
      "startedAt",
      "startLag",
    ]);
    expect(Object.keys(report).sort()).toEqual(
      [
        "component",
        "event",
        "completed",
        "succeeded",
        "failed",
        "retries",
        "canceled",
        "lastReportTs",
        "running",
        "backlog",
        "failureRate",
        "permanentFailureRate",
      ].sort(),
    );
    expect(report).toMatchObject({ running: 1, backlog: 0, failureRate: 0, permanentFailureRate: 0 });
    // `onCompleteScheduledFunctionId` is undefined, so JSON leaves it out.
    expect(Object.keys(completed)).toEqual([
      "component",
      "event",
      "workId",
      "fnName",
      "completedAt",
      "attempts",
      "status",
    ]);
    expect(completed).toMatchObject({ attempts: 1, status: "success" });
    // The counters restart, and the next report is a minute after the last (or now, when that is long past).
    const state = (await t.run((ctx: any) => ctx.db.query("internalState").unique())) as any;
    expect(state.report).toEqual({
      completed: 0,
      succeeded: 0,
      failed: 0,
      retries: 0,
      canceled: 0,
      lastReportTs: expect.any(Number),
    });
    expect(Math.abs(state.report.lastReportTs - t.now())).toBeLessThan(1000);
  });
});

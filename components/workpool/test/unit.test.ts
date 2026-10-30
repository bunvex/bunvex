// Upstream's `config.test.ts`, `logging.test.ts`, `errors.test.ts` and `kick.test.ts` (get-convex/workpool 0.4.14,
// STUDY-199 §1.19), ported. The non-retryable marker is `__bunvexWorkpoolNonRetryable` and the base class
// `BunvexError` (DV-538).
// biome-ignore-all lint/suspicious/noExplicitAny: the inline functions' ctx is untyped
import { describe, expect, it, setDefaultTimeout, spyOn } from "bun:test";
import { BunvexError } from "@bunvex/values";
import { getOrUpdateGlobals } from "../src/component/config.ts";
import { getNonRetryableErrorMessage, isNonRetryableError, NonRetryableError } from "../src/component/errors.ts";
import { kickMainLoop } from "../src/component/kick.ts";
import { createLogger, DEFAULT_LOG_LEVEL, type LogLevel, shouldLog } from "../src/component/logging.ts";
import { DEFAULT_MAX_PARALLELISM } from "../src/component/shared.ts";
import { api, emptyReport, MINUTE, setupTest, workerStatus } from "./helpers.ts";

// Each test that pushes a deployment takes longer than bun's 5 s default on a busy machine.
setDefaultTimeout(30_000);

describe("config", () => {
  it("it updates the globals when they change", async () => {
    const t = setupTest();
    await t.run(async (ctx: any) => {
      await getOrUpdateGlobals(ctx, { maxParallelism: DEFAULT_MAX_PARALLELISM, logLevel: DEFAULT_LOG_LEVEL });
      const globals = await ctx.db.query("globals").unique();
      expect(globals).not.toBeNull();
      expect(globals.maxParallelism).toBe(DEFAULT_MAX_PARALLELISM);
      expect(globals.logLevel).toBe(DEFAULT_LOG_LEVEL);
      await getOrUpdateGlobals(ctx, { maxParallelism: DEFAULT_MAX_PARALLELISM + 1, logLevel: "ERROR" });
      const after = await ctx.db.query("globals").unique();
      expect(after.maxParallelism).toBe(DEFAULT_MAX_PARALLELISM + 1);
      expect(after.logLevel).toBe("ERROR");
    });
  });
});

describe("logging", () => {
  describe("shouldLog", () => {
    it("should return true if the log level is above the config level", () => {
      expect(shouldLog("INFO", "DEBUG")).toBe(false);
    });
    it("should return false if the log level is below the config level", () => {
      expect(shouldLog("INFO", "WARN")).toBe(true);
    });
    it("should return true if the log level is equal to the config level", () => {
      expect(shouldLog("INFO", "INFO")).toBe(true);
    });
  });

  // More (STUDY-199 §3.4): the lines and the events at each level, and the unknown level's error.
  it("writes the lines and JSON events of each level", () => {
    const spies = (["debug", "info", "warn", "error", "time", "timeEnd"] as const).map((m) =>
      spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      const write = (level?: LogLevel) => {
        for (const s of spies) s.mockClear();
        const log = createLogger(level);
        log.debug("d");
        log.info("i");
        log.warn("w");
        log.error("e");
        log.time("t");
        log.timeEnd("t");
        log.event("started", { workId: "w" });
        log.event("report", { running: 0 });
        return spies.map((s) => s.mock.calls.map((c) => c[0]));
      };
      const started = JSON.stringify({ component: "workpool", event: "started", workId: "w" });
      const report = JSON.stringify({ component: "workpool", event: "report", running: 0 });
      expect(write()).toEqual([[], [report], ["w"], ["e"], [], []]);
      expect(write("REPORT")).toEqual(write());
      expect(write("INFO")).toEqual([[], ["i", started, report], ["w"], ["e"], [], []]);
      expect(write("TRACE")).toEqual([[], ["i", started, report], ["w"], ["e"], ["t"], ["t"]]);
      expect(write("DEBUG")).toEqual([["d"], ["i", started, report], ["w"], ["e"], ["t"], ["t"]]);
      expect(write("WARN")).toEqual([[], [], ["w"], ["e"], [], []]);
      expect(write("ERROR")).toEqual([[], [], [], ["e"], [], []]);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it("refuses an unknown level", () => {
    expect(() => createLogger("LOUD" as LogLevel)).toThrow("Invalid log level: LOUD");
  });
});

class CustomTerminalError extends NonRetryableError {}

describe("errors", () => {
  it("identifies non-retryable error subclasses", () => {
    const error = new CustomTerminalError("invalid input");
    expect(isNonRetryableError(error)).toBe(true);
    expect(getNonRetryableErrorMessage(error)).toBe("invalid input");
    // The data is what crosses a function boundary.
    expect(error.data).toEqual({ __bunvexWorkpoolNonRetryable: true, message: "invalid input" });
    expect(error.name).toBe("CustomTerminalError");
    expect(error).toBeInstanceOf(BunvexError);
  });

  it("identifies BunvexError data from nested mutations", () => {
    const error = new BunvexError({ __bunvexWorkpoolNonRetryable: true, message: "invalid input" });
    expect(isNonRetryableError(error)).toBe(true);
    expect(getNonRetryableErrorMessage(error)).toBe("invalid input");
  });

  it("identifies marker-compatible errors", () => {
    const error = new Error("invalid input");
    Object.assign(error, { __bunvexWorkpoolNonRetryable: true });
    expect(isNonRetryableError(error)).toBe(true);
    expect(getNonRetryableErrorMessage(error)).toBe("invalid input");
  });

  it("does not identify ordinary errors as non-retryable", () => {
    expect(isNonRetryableError(new Error("temporary failure"))).toBe(false);
  });

  // More: the edges of the data check.
  it("keeps the cause, and needs a string message in the data", () => {
    const cause = new Error("root");
    expect(new NonRetryableError("x", { cause }).cause).toBe(cause);
    expect(isNonRetryableError(new BunvexError({ __bunvexWorkpoolNonRetryable: true, message: 1 }))).toBe(false);
    expect(isNonRetryableError(new BunvexError({ __bunvexWorkpoolNonRetryable: false, message: "x" }))).toBe(false);
    expect(getNonRetryableErrorMessage(new BunvexError("plain"))).toBeUndefined();
    expect(getNonRetryableErrorMessage({ __bunvexWorkpoolNonRetryable: true, message: 3 })).toBeUndefined();
    expect(getNonRetryableErrorMessage(new Error("plain"))).toBeUndefined();
  });
});

describe("kickMainLoop", () => {
  async function seedRunningState(t: ReturnType<typeof setupTest>, maxParallelism = 1) {
    await t.run(async (ctx: any) => {
      await ctx.db.insert("globals", { logLevel: "WARN", maxParallelism });
      const workId = await ctx.db.insert("work", {
        fnType: "action",
        fnHandle: "test_handle",
        fnName: "test_handle",
        fnArgs: {},
        attempts: 0,
      });
      // Upstream schedules the legacy `runActionWrapper` (not built, DV-539); any pending job holds the slot.
      const scheduledId = await ctx.scheduler.runAfter(MINUTE, api.testing.noop, {});
      await ctx.db.insert("internalState", {
        generation: 0n,
        segmentCursors: { incoming: 0n, completion: 0n, cancelation: 0n },
        lastRecovery: 0n,
        report: emptyReport(Date.now()),
        running: [{ workId, scheduledId, started: Date.now() }],
      });
    });
  }

  it("pings on enqueue", async () => {
    const t = setupTest();
    await seedRunningState(t, 1);
    await t.run((ctx: any) => kickMainLoop(ctx, "enqueue"));
    expect(await workerStatus(t)).toBe("running");
  });

  it("pings on every source even when saturated", async () => {
    for (const source of ["enqueue", "complete", "retry", "cancel", "kick"] as const) {
      const t = setupTest();
      await seedRunningState(t, 1);
      await t.run((ctx: any) => kickMainLoop(ctx, source));
      expect(await workerStatus(t)).toBe("running");
      await t.close();
    }
  });

  // More: `forceKick` stops the worker and starts it again.
  it("forceKick restarts a stopped worker", async () => {
    const t = setupTest();
    await seedRunningState(t, 1);
    await t.run((ctx: any) => kickMainLoop(ctx));
    await t.mutation(api.kick.forceKick, {});
    expect(await workerStatus(t)).toBe("running");
  });
});

// What upstream's tests leave out (STUDY-196 §3.5): at-least-once processing (a worker mutation that throws is
// retried by the monitor `monitorLagMs` later, with the same batch), `setCursor`'s error, and the logger's levels and
// JSON events.
// biome-ignore-all lint/suspicious/noExplicitAny: the app's api is untyped
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { anyApi } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import { createLogger, type LogLevel, shouldLog } from "../src/component/logging.ts";
import { MONITOR_LAG_MS } from "../src/component/shared.ts";

const worker = (anyApi as any).worker;
const APP = join(import.meta.dir, "fixtures", "app");
const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
function deployment() {
  const t = bunvexTest({ cwd: APP });
  open.push(t);
  return t;
}
/** The states of the loop's runs, oldest first: the component's own scheduled jobs (the harness's view of them). */
const loopRuns = async (t: TestBunvex) =>
  ((await (t as any).backend.jobs()) as { udfPath: string; state: { type: string } }[])
    .filter((j) => j.udfPath === "loop.js:loop")
    .map((j) => j.state.type);

describe("failure handling", () => {
  test("a worker mutation that throws is retried after the monitor's lag, with the same batch", async () => {
    const t = deployment();
    await t.mutation(worker.enqueueJob, { value: 7 });
    await t.finishInProgressScheduledFunctions();
    await t.advanceTime(1);
    // The run failed and scheduled nothing: the job is still queued and the worker still says running.
    expect(await t.query(worker.jobsLeft, {})).toBe(1);
    expect((await t.query(worker.jobStatus, {}))?.kind).toBe("running");
    expect(await loopRuns(t)).toEqual(["failed"]);

    // Just before the monitor's lag, nothing has retried it.
    await t.advanceTime(MONITOR_LAG_MS - 1000);
    expect(await loopRuns(t)).toEqual(["failed"]);

    // The monitor restarts the loop, which fails again on the same job.
    await t.advanceTime(2000);
    expect(await loopRuns(t)).toEqual(["failed", "failed"]);
    expect(await t.query(worker.jobsLeft, {})).toBe(1);

    // Once the mutation succeeds, the next restart processes the job exactly once.
    await t.mutation(worker.allow, {});
    await t.advanceTime(MONITOR_LAG_MS);
    await t.finishAllScheduledFunctions(undefined, 1000);
    expect(await t.query(worker.jobsLeft, {})).toBe(0);
    expect(await t.query(worker.jobsDone, {})).toEqual([7]);
    expect((await t.query(worker.jobStatus, {}))?.kind).toBe("idle");
  });
});

describe("cooling down", () => {
  test("after work, the loop polls the empty queue every pollIntervalMs until cooldownMs has passed", async () => {
    const t = deployment();
    // The `items` worker's query answers `idle` with `cooldownMs: 100, pollIntervalMs: 10`.
    await t.mutation(worker.enqueue, { value: 1 });
    await t.finishAllScheduledFunctions(undefined, 1000);
    const runs = (await loopRuns(t)).filter((s) => s === "success");
    // One run with the batch, then about 100 / 10 polls, then the run that goes idle.
    expect(runs.length).toBeGreaterThanOrEqual(10);
    expect(runs.length).toBeLessThanOrEqual(13);
    expect((await t.query(worker.status, {}))?.kind).toBe("idle");
  });
});

describe("setCursor", () => {
  test("refuses a worker that was never pinged", async () => {
    const t = deployment();
    await expect(t.mutation(worker.setJobCursor, { name: "ghost" })).rejects.toThrow(
      '[setCursor] no worker named "ghost". Ping it first.',
    );
  });
});

describe("logging", () => {
  const LEVELS: LogLevel[] = ["DEBUG", "TRACE", "INFO", "REPORT", "WARN", "ERROR"];

  test("each level logs itself and the levels after it", () => {
    for (const [i, config] of LEVELS.entries())
      for (const [j, level] of LEVELS.entries()) expect(shouldLog(config, level)).toBe(i <= j);
  });

  test("the console lines and the JSON events, by level", () => {
    const spies = (["debug", "info", "warn", "error"] as const).map((m) =>
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
        log.event("restart", { name: "n" });
        log.event("report", { name: "n" });
        return spies.map((s) => s.mock.calls.map((c) => c[0]));
      };
      const event = (name: string) => JSON.stringify({ component: "worker", event: name, name: "n" });

      // REPORT, the default: no debug or info lines, and only the `report` event.
      expect(write()).toEqual([[], [event("report")], ["w"], ["e"]]);
      expect(write("REPORT")).toEqual(write());
      expect(write("INFO")).toEqual([[], ["i", event("restart"), event("report")], ["w"], ["e"]]);
      expect(write("DEBUG")).toEqual([["d"], ["i", event("restart"), event("report")], ["w"], ["e"]]);
      expect(write("WARN")).toEqual([[], [], ["w"], ["e"]]);
      expect(write("ERROR")).toEqual([[], [], [], ["e"]]);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  test("an unknown level throws", () => {
    expect(() => createLogger("LOUD" as LogLevel)).toThrow("Invalid log level: LOUD");
  });
});

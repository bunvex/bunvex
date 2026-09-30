// The contract suite for the deployment's other features (UI-01 §14): each block runs when the source has
// the feature's methods. Reads are safe on any deployment; what changes data (cancelling scheduled runs)
// runs only when the caller opts in.
import { expect } from "bun:test";
import { type DashboardDataSource, DataSourceError, type Page, type ScheduledFunction } from "./data-source.ts";

export type DeploymentContractOptions = {
  /** Lets the suite cancel scheduled runs — every pending run of one function. Never on data you keep. */
  schedules?: { cancel: boolean };
};

type Ctx = {
  make: () => DashboardDataSource | Promise<DashboardDataSource>;
  test: (name: string, fn: () => Promise<void>) => void;
  watchTimeoutMs: number;
  opts: DeploymentContractOptions;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function expectCode(p: Promise<unknown>, code: DataSourceError["code"]) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(DataSourceError);
  expect((e as DataSourceError).code).toBe(code);
}

async function allScheduled(src: DashboardDataSource, fn?: string): Promise<ScheduledFunction[]> {
  const out: ScheduledFunction[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 1000; i++) {
    const p: Page<ScheduledFunction> = await src.listScheduledFunctions!({ numItems: 7, cursor, function: fn });
    out.push(...p.page);
    if (p.isDone) return out;
    cursor = p.continueCursor;
  }
  throw new Error("pagination did not finish");
}

export function describeDeploymentContract({ make, test, watchTimeoutMs, opts }: Ctx) {
  // ---------------------------------------------------------------- scheduled functions and crons
  test("scheduled functions (when offered): nearest first, paged, one function's on request", async () => {
    const src = await make();
    if (!src.listScheduledFunctions) return;
    const all = await allScheduled(src);
    expect(new Set(all.map((j) => j.id)).size).toBe(all.length);
    for (let i = 1; i < all.length; i++)
      expect(all[i]!.scheduledTime).toBeGreaterThanOrEqual(all[i - 1]!.scheduledTime);
    for (const j of all) expect(["pending", "inProgress"]).toContain(j.state);
    const fn = all[0]?.function;
    if (fn === undefined) return;
    const mine = await allScheduled(src, fn);
    expect(mine.length).toBe(all.filter((j) => j.function === fn).length);
    expect(mine.every((j) => j.function === fn)).toBe(true);
  });

  test("cron jobs (when offered): each with its schedule, next run and runs newest first", async () => {
    const src = await make();
    if (!src.listCronJobs || !src.listCronRuns) return;
    const jobs = await src.listCronJobs();
    for (const job of jobs) {
      expect(typeof job.schedule.type).toBe("string");
      const runs = await src.listCronRuns(job.name);
      for (let i = 1; i < runs.length; i++) expect(runs[i]!.time).toBeLessThanOrEqual(runs[i - 1]!.time);
      if (job.lastRun) expect(runs[0]?.time).toBe(job.lastRun.time);
      if (job.lastRun) expect(job.nextRun).toBeGreaterThan(job.lastRun.time);
    }
    await expectCode(src.listCronRuns("no such cron job"), "not_found");
  });

  if (opts.schedules?.cancel)
    test("cancelling (opt-in): one run, then all of a function's; watchers hear it", async () => {
      const src = await make();
      if (!src.listScheduledFunctions || !src.cancelScheduledFunction || !src.cancelAllScheduledFunctions)
        throw new Error("schedules.cancel was enabled but the source cannot cancel scheduled runs");
      let heard = 0;
      const off = src.watchScheduledFunctions?.(
        () => heard++,
        () => {},
      );
      const pending = (await allScheduled(src)).filter((j) => j.state === "pending");
      const one = pending[0];
      if (!one) throw new Error("the cancel tests need a pending scheduled run");
      await src.cancelScheduledFunction(one.id);
      expect((await allScheduled(src)).some((j) => j.id === one.id)).toBe(false);
      await expectCode(src.cancelScheduledFunction(one.id), "not_found");
      const fn = pending.find((j) => j.id !== one.id)?.function;
      if (fn !== undefined) {
        const { canceled } = await src.cancelAllScheduledFunctions(fn);
        expect(canceled).toBeGreaterThan(0);
        expect((await allScheduled(src, fn)).filter((j) => j.state === "pending")).toEqual([]);
      }
      if (off) {
        const deadline = performance.now() + watchTimeoutMs;
        while (heard === 0 && performance.now() < deadline) await sleep(5);
        off();
        expect(heard).toBeGreaterThan(0);
      }
    });
}

// The mock's scheduler (UI-01 §14, STUDY-12 §8): pending runs and cron jobs over a clock that starts at the
// fixture's `now`. While someone watches, due runs run (logged like any execution) and now and then a new
// run is scheduled, as a live app would. Pure state; MockDataSource wraps it in its latency and gates.
import {
  type CronJob,
  type CronRun,
  type CronSchedule,
  DataSourceError,
  type FunctionInfo,
  type Page,
  type ScheduledFunction,
  type ScheduledFunctionQuery,
  type Value,
} from "../data-source.ts";
import { nextRunAfter } from "../schedules/cron.ts";
import type { Random } from "./random.ts";

/** What the scheduler needs from the source. */
export type SchedulerHost = {
  rnd: Random;
  functions: FunctionInfo[];
  /** Logs an execution of `fn` at `time`; returns its outcome. */
  run: (fn: FunctionInfo, time: number) => { failed: boolean; error?: string; durationMs: number; lines: string[] };
  paginate: <T>(
    items: T[],
    key: (t: T) => Value[],
    q: { numItems: number; cursor: string | null },
    query: string,
  ) => Page<T>;
};

type CronDef = { name: string; function: string; args: Record<string, Value>; schedule: CronSchedule };

const CRONS: CronDef[] = [
  {
    name: "purge old messages",
    function: "messages:purgeOld",
    args: { olderThanDays: 30 },
    schedule: { type: "daily", hourUTC: 3, minuteUTC: 0 },
  },
  { name: "summarize tasks", function: "tasks:summarize", args: {}, schedule: { type: "interval", seconds: 900 } },
  {
    name: "sync users",
    function: "users:syncFromAuth",
    args: { full: false },
    schedule: { type: "cron", cronExpr: "*/30 * * * *" },
  },
  {
    name: "weekly digest",
    function: "messages:send",
    args: { channel: "general", digest: true },
    schedule: { type: "weekly", dayOfWeek: 1, hourUTC: 9, minuteUTC: 30 },
  },
];

/** Runs kept per cron job, as Convex keeps 5. */
const KEPT_RUNS = 5;

export class MockScheduler {
  private jobs: ScheduledFunction[] = [];
  private readonly crons: (CronDef & { nextRun: number; runs: CronRun[] })[];
  private readonly watchers = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly t0 = Date.now();

  constructor(
    private readonly host: SchedulerHost,
    /** The mock clock's start: the fixture's now. */
    private readonly start: number,
    pending = 24,
  ) {
    const { rnd } = host;
    const targets = host.functions.filter((f) => f.kind !== "query");
    for (let i = 0; i < pending; i++) {
      const fn = rnd.pick(targets);
      const created = start - rnd.int(1, 3_600) * 1000;
      this.jobs.push({
        id: rnd.id(),
        creationTime: created,
        function: fn.path,
        args: fn.path === "tasks:toggle" ? { id: rnd.id() } : { attempt: rnd.int(1, 3) },
        scheduledTime: start + rnd.int(60, 48 * 3_600) * 1000,
        state: "pending",
      });
    }
    // one that is running right now
    const busy = rnd.pick(targets);
    this.jobs.push({
      id: rnd.id(),
      creationTime: start - 90_000,
      function: busy.path,
      args: {},
      scheduledTime: start - 2_000,
      state: "inProgress",
    });
    this.crons = CRONS.map((c) => {
      // the past runs, oldest first, at the schedule's own times
      const times: number[] = [];
      for (let t = nextRunAfter(c.schedule, start - 40 * 86_400_000); t <= start; t = nextRunAfter(c.schedule, t))
        times.push(t);
      const fn = host.functions.find((f) => f.path === c.function)!;
      const runs = times
        .slice(-KEPT_RUNS)
        .map((time) => this.cronRun(c, fn, time, false))
        .reverse();
      return { ...c, nextRun: nextRunAfter(c.schedule, start), runs };
    });
  }

  /** The mock's clock: the fixture's now, moving with real time. */
  now = () => this.start + (Date.now() - this.t0);

  private cronRun(c: CronDef, fn: FunctionInfo, time: number, log: boolean): CronRun {
    const r: ReturnType<SchedulerHost["run"]> = log
      ? this.host.run(fn, time)
      : { failed: this.host.rnd.chance(0.1), durationMs: this.host.rnd.int(5, 400), lines: [] };
    const run: CronRun = {
      name: c.name,
      time,
      function: c.function,
      status: r.failed ? "failure" : "success",
      durationMs: r.durationMs,
      logLines: r.lines,
    };
    if (r.failed) run.error = r.error ?? "Uncaught Error: timeout";
    return run;
  }

  // ---------------------------------------------------------------- reads

  list(q: ScheduledFunctionQuery): Page<ScheduledFunction> {
    const rows = this.jobs
      .filter((j) => q.function === undefined || j.function === q.function)
      .sort((a, b) => a.scheduledTime - b.scheduledTime || (a.id < b.id ? -1 : 1));
    const copies = rows.map((j) => ({ ...j, args: structuredClone(j.args) }));
    return this.host.paginate(copies, (j) => [j.scheduledTime, j.id], q, `scheduled\u0000${q.function ?? ""}`);
  }

  cronJobs(): CronJob[] {
    return [...this.crons]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((c) => ({
        name: c.name,
        function: c.function,
        args: structuredClone(c.args),
        schedule: { ...c.schedule },
        nextRun: c.nextRun,
        lastRun: c.runs[0] ? { ...c.runs[0], logLines: [...c.runs[0].logLines] } : null,
        running: false,
      }));
  }

  cronRuns(name: string): CronRun[] {
    const c = this.crons.find((x) => x.name === name);
    if (!c) throw new DataSourceError("not_found", `no cron job "${name}"`);
    return c.runs.map((r) => ({ ...r, logLines: [...r.logLines] }));
  }

  // ---------------------------------------------------------------- writes

  cancel(id: string) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new DataSourceError("not_found", `no scheduled run "${id}"`);
    if (job.state !== "pending")
      throw new DataSourceError("invalid_request", "this run has started: it can no longer be canceled");
    this.jobs = this.jobs.filter((j) => j !== job);
    this.changed();
  }

  cancelAll(fn?: string): { canceled: number } {
    const gone = this.jobs.filter((j) => j.state === "pending" && (fn === undefined || j.function === fn));
    this.jobs = this.jobs.filter((j) => !gone.includes(j));
    if (gone.length > 0) this.changed();
    return { canceled: gone.length };
  }

  /** Not part of the contract: schedules a run of `fn` in `delayMs`, as `ctx.scheduler.runAfter` would. */
  schedule(fn: string, delayMs: number, args: Record<string, Value> = {}): ScheduledFunction {
    const now = this.now();
    const job: ScheduledFunction = {
      id: this.host.rnd.id(),
      creationTime: now,
      function: fn,
      args,
      scheduledTime: now + delayMs,
      state: "pending",
    };
    this.jobs.push(job);
    this.changed();
    return job;
  }

  // ---------------------------------------------------------------- time passing

  /** Not part of the contract: runs what is due at the mock clock's now (the watch timer calls it). */
  tick() {
    const now = this.now();
    let changed = false;
    for (const job of this.jobs.filter((j) => j.scheduledTime <= now)) {
      const fn = this.host.functions.find((f) => f.path === job.function);
      if (fn) this.host.run(fn, now);
      this.jobs = this.jobs.filter((j) => j !== job);
      changed = true;
    }
    for (const c of this.crons)
      while (c.nextRun <= now) {
        const fn = this.host.functions.find((f) => f.path === c.function)!;
        c.runs = [this.cronRun(c, fn, c.nextRun, true), ...c.runs].slice(0, KEPT_RUNS);
        c.nextRun = nextRunAfter(c.schedule, c.nextRun);
        changed = true;
      }
    // a live app keeps scheduling
    if (this.host.rnd.chance(0.3)) {
      const fn = this.host.rnd.pick(this.host.functions.filter((f) => f.kind !== "query"));
      this.jobs.push({
        id: this.host.rnd.id(),
        creationTime: now,
        function: fn.path,
        args: {},
        scheduledTime: now + this.host.rnd.int(5, 600) * 1000,
        state: "pending",
      });
      changed = true;
    }
    if (changed) this.changed();
  }

  watch(onChange: () => void, intervalMs: number): () => void {
    this.watchers.add(onChange);
    this.timer ??= setInterval(() => this.tick(), intervalMs);
    return () => {
      this.watchers.delete(onChange);
      if (this.watchers.size === 0 && this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  private changed() {
    if (this.watchers.size === 0) return;
    setTimeout(() => {
      for (const w of this.watchers) w();
    }, 0);
  }
}

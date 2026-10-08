// Scheduled functions (STUDY-30), after Convex's scheduler syscalls (crates/isolate/src/environment/udf/
// async_syscall.rs `schedule`/`cancel_job`, npm-packages/convex/src/server/impl/scheduler_impl.ts) and its
// executor (crates/application/src/scheduled_jobs):
//
// - `ctx.scheduler` in a mutation writes the job in the mutation's transaction; in an action, each call
//   is its own transaction.
// - The executor runs due jobs, `nextTs` first, up to 8 at a time, as no one (no identity).
//   - A mutation runs exactly once: its job is finished in the same transaction as its writes.
//   - An action runs at most once: its job is marked in progress (committed) before it starts. A job
//     found in progress that this process is not running was cut short (a crash), so it fails with
//     "Transient error while executing action" and never runs again.
// - Jobs live in `_scheduled_jobs`, their arguments in `_scheduled_job_args` (STUDY-125); the executor reads both.
// - Completed jobs are deleted with their arguments after the retention window (7 days).
import {
  BACKEND_STATE_TABLE,
  type Caller,
  CommitterStoppedError,
  cancelJob,
  completeJob,
  deleteCompletedJobs,
  dueJobs,
  type Engine,
  getJob,
  IndexesUnavailableError,
  insertJob,
  isJobId,
  isStopped,
  type JobDoc,
  jobArgs,
  nextJobTs,
  OccError,
  patchJob,
  readBackendState,
  SCHEDULED_BY_NEXT_TS,
  SCHEDULED_JOBS_TABLE,
  SPAN_KIND,
  stringifyValue,
  TooManyWritesError,
  type Tx,
  wallClock,
} from "@bunvex/core";
import {
  type AnyFunctionReference,
  type FunctionReference,
  getFunctionName,
  type OptionalRestArgs,
} from "@bunvex/protocol";
import {
  type GenericId,
  hasCommitTs,
  isSimpleObject,
  MAX_VALUE_NESTING,
  measureRawValue,
  rawValueSize,
  refuseLoneSurrogates,
  TOO_NESTED_MESSAGE,
  toJsonValue,
  type Value,
} from "@bunvex/values";
import { describeUncaught, newRequestId } from "./errors.ts";
import { functionAddress, functionNameOf } from "./function-handles.ts";
import { type Functions, type SourcedCaller, THROTTLED } from "./functions.ts";

/** A function to schedule: a reference (`api.module.fn`) or its name (`"module:fn"`). */
export type SchedulableFunction = AnyFunctionReference | string;

/** A mutation or action to schedule, as Convex's `SchedulableFunctionReference`. */
export type SchedulableFunctionReference = FunctionReference<"mutation" | "action", "public" | "internal">;
type ScheduledId = GenericId<"_scheduled_functions">;

/**
 * `ctx.scheduler`, as Convex's `Scheduler`: a reference's arguments are typed (none may be left out when
 * it takes some); a plain name (`"module:fn"`) is untyped.
 */
export interface Scheduler {
  runAfter<F extends SchedulableFunctionReference>(
    delayMs: number,
    fn: F,
    ...args: OptionalRestArgs<F>
  ): Promise<ScheduledId>;
  runAfter(delayMs: number, fn: string, args?: Record<string, unknown>): Promise<ScheduledId>;
  runAt<F extends SchedulableFunctionReference>(
    timestamp: number | Date,
    fn: F,
    ...args: OptionalRestArgs<F>
  ): Promise<ScheduledId>;
  runAt(timestamp: number | Date, fn: string, args?: Record<string, unknown>): Promise<ScheduledId>;
  cancel(id: ScheduledId): Promise<void>;
}

const FIVE_YEARS_MS = 5 * 366 * 24 * 3600 * 1000;

/** Rust's `Debug` for a `Duration` of `secs` seconds, as Convex prints a `UnixTimestamp` in its messages. */
function unixTimestampDebug(secs: number): string {
  const whole = Math.floor(secs);
  const nanos = Math.round((secs - whole) * 1e9);
  const frac = nanos === 0 ? "" : `.${String(nanos).padStart(9, "0").replace(/0+$/, "")}`;
  return `UnixTimestamp(${whole}${frac}s)`;
}

function parseScheduleArgs(args: unknown): Record<string, Value> {
  if (args === undefined) return {};
  if (!isSimpleObject(args))
    throw new Error(`The arguments to a bunvex function must be an object. Received: ${args as unknown}`);
  return args as Record<string, Value>;
}

/** Where a scheduler writes: a mutation's transaction, or (an action) one transaction per call. */
type Target = { db: Tx; job?: string } | { engine: Engine; job?: string; systemIdentity?: boolean; requestId?: string };

export function makeScheduler(functions: Functions, target: Target): Scheduler {
  const write = <T>(f: (db: Tx) => Promise<T>): Promise<T> =>
    "db" in target ? f(target.db) : target.engine.mutation((db) => f(db), "_system/scheduler");

  const schedule = async (tsMs: number, fn: SchedulableFunction, args: Record<string, Value>) => {
    // Convex's `schedule` text (scheduler_impl.ts): an action's request id, the function's address, the time
    // in seconds, then the arguments; serde reads it before anything is checked (STUDY-135).
    refuseLoneSurrogates(args, () =>
      JSON.stringify({
        ...("engine" in target ? { requestId: target.requestId ?? "" } : {}),
        ...functionAddress(fn),
        ts: tsMs / 1000,
        args: toJsonValue(args),
      }),
    );
    // As Convex: the time, then the target (it must exist; its kind is checked when it runs).
    if (Number.isNaN(tsMs))
      throw new Error(
        "Invalid arguments for `ts`: cannot convert float seconds to Duration: value is either too big or NaN",
      );
    if (tsMs < 0)
      throw new Error("Invalid arguments for `ts`: cannot convert float seconds to Duration: value is negative");
    const now = Date.now();
    if (tsMs - now > FIVE_YEARS_MS)
      throw new Error(`${unixTimestampDebug(tsMs / 1000)} is more than 5 years in the future`);
    if (tsMs - now < -FIVE_YEARS_MS)
      throw new Error(`${unixTimestampDebug(tsMs / 1000)} is more than 5 years in the past`);
    // A function handle (STUDY-50) names its function by its row, read in the scheduling transaction.
    const name = functions.scheduledTarget(
      await functionNameOf(fn, "db" in target ? target.db : null, functions.engineOf()),
      "db" in target ? target.db.systemIdentity : target.systemIdentity === true,
    );
    // As Convex's `validate_schedule_args`: the positional args, `[args]`, are parsed as a value, so they nest
    // at most 63 levels (STUDY-109); they travel as plain values, so a commit timestamp placeholder cannot
    // (STUDY-53).
    const measured = measureRawValue([args]);
    if (measured.nesting > MAX_VALUE_NESTING) throw new Error(`Invalid arguments for ${name}: ${TOO_NESTED_MESSAGE}`);
    // An array over 8192 elements or an object over 1024 fields (DV-439).
    if (measured.tooBig !== undefined) throw new Error(`Invalid arguments for ${name}: ${measured.tooBig}`);
    if (hasCommitTs(args))
      throw new Error(`Invalid arguments for ${name}: Field name $commitTs starts with '$', which is reserved.`);
    return write(async (db) => {
      // What a canceled running action schedules is born canceled (Convex's parent check).
      const parent = target.job ? await getJob(db, target.job) : null;
      return insertJob(db, {
        name,
        args: [args],
        scheduledTime: tsMs,
        now,
        canceled: parent?.state.kind === "canceled",
      });
    });
  };

  return {
    async runAfter(delayMs: number, fn: SchedulableFunction, args?: Record<string, unknown>) {
      if (typeof delayMs !== "number") throw new Error("`delayMs` must be a number");
      if (!Number.isFinite(delayMs)) throw new Error("`delayMs` must be a finite number");
      if (delayMs < 0) throw new Error("`delayMs` must be non-negative");
      return schedule(Date.now() + delayMs, fn, parseScheduleArgs(args));
    },
    async runAt(timestamp: number | Date, fn: SchedulableFunction, args?: Record<string, unknown>) {
      let ms: number;
      if (timestamp instanceof Date) ms = timestamp.valueOf();
      else if (typeof timestamp === "number") ms = timestamp;
      else throw new Error("The invoke time must a Date or a timestamp");
      return schedule(ms, fn, parseScheduleArgs(args));
    },
    async cancel(id: string) {
      if (typeof id !== "string")
        throw new Error(`Invalid argument \`id\` for \`cancel\`, expected string but got '${typeof id}': ${id}`);
      await write(async (db) => {
        if (!isJobId(db, id))
          throw new Error("Invalid scheduled function ID. The ID must be an ID on the '_scheduled_functions' table.");
        if ("db" in target && target.job === id) throw new Error("A mutation cannot cancel itself");
        await cancelJob(db, id, Date.now());
      });
    },
  } as Scheduler;
}

/** Convex's knobs, from the environment where Convex reads them. */
export type SchedulerOptions = {
  /** SCHEDULED_JOB_EXECUTION_PARALLELISM: jobs run at once (8). */
  parallelism?: number;
  /** SCHEDULED_JOB_RETENTION: seconds a completed job is kept (7 days). */
  retentionSeconds?: number;
  /** Backoffs, in ms: OCC retries (100 ms → 60 s) and system errors (500 ms → 2 h). */
  occInitialBackoffMs?: number;
  occMaxBackoffMs?: number;
  errorInitialBackoffMs?: number;
  errorMaxBackoffMs?: number;
};

export function schedulerOptionsFromEnv(env = process.env): SchedulerOptions {
  const num = (k: string) => {
    const v = env[k];
    if (v === undefined || v === "") return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${k}: not a number: ${v}`);
    return n;
  };
  return { parallelism: num("SCHEDULED_JOB_EXECUTION_PARALLELISM"), retentionSeconds: num("SCHEDULED_JOB_RETENTION") };
}

/** Convex's backoff: `initial · 2^(n-1)`, capped, with full jitter. */
const backoff = (failures: number, initialMs: number, maxMs: number) =>
  Math.random() * Math.min(maxMs, initialMs * 2 ** Math.max(0, failures - 1));

const NO_ONE: Caller = { identity: null, key: "" };
/** A scheduled function runs with no identity, for a request of its own that names it (STUDY-44). */
const asJob = (jobId: string): SourcedCaller => ({
  ...NO_ONE,
  source: "Scheduler",
  request: { ip: null, userAgent: null, requestId: newRequestId(), authToken: null, scheduledFunctionId: jobId },
});
const randomId = () => crypto.randomUUID().replaceAll("-", "");

export class ScheduledJobExecutor {
  private readonly running = new Map<string, Promise<void>>();
  private stopped = false;
  private wake: (() => void) | null = null;
  /** Bumped by every poke, so one that lands while the loop is busy is not lost. */
  private pokes = 0;
  private loop: Promise<void> | null = null;
  private gcTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly o: Required<SchedulerOptions>;
  /** For tests and benchmarks. */
  readonly stats = { started: 0, succeeded: 0, failed: 0, systemErrors: 0, occRetries: 0 };

  constructor(
    private readonly engine: Engine,
    private readonly functions: Functions,
    options: SchedulerOptions = {},
  ) {
    this.o = {
      parallelism: options.parallelism ?? 8,
      retentionSeconds: options.retentionSeconds ?? 7 * 24 * 3600,
      occInitialBackoffMs: options.occInitialBackoffMs ?? 100,
      occMaxBackoffMs: options.occMaxBackoffMs ?? 60_000,
      errorInitialBackoffMs: options.errorInitialBackoffMs ?? 500,
      errorMaxBackoffMs: options.errorMaxBackoffMs ?? 2 * 3600 * 1000,
    };
  }

  start() {
    // Woken by commits that touch the queue (a job scheduled, canceled or rescheduled): no polling.
    let jobs = this.engine.catalog.table(SCHEDULED_JOBS_TABLE);
    let byNextTs = jobs.indexes.get(SCHEDULED_BY_NEXT_TS)!.id;
    // And by a pause or unpause (STUDY-63), as Convex's executors subscribe to `_backend_state`.
    const backendState = this.engine.catalog.table(BACKEND_STATE_TABLE).byId.id;
    this.engine.committer.onCommit((entries) => {
      // The table replaced with an empty one (`/api/delete_scheduled_functions_table`, STUDY-113; the catalog
      // changes before the listeners run): its new index from now on, and the sleep until a job that is gone
      // dropped. A job running meanwhile finds its document gone, and records nothing.
      const now = this.engine.catalog.table(SCHEDULED_JOBS_TABLE);
      if (now.id !== jobs.id) {
        jobs = now;
        byNextTs = now.indexes.get(SCHEDULED_BY_NEXT_TS)!.id;
        this.poke();
        return;
      }
      if (entries.some((e) => e.writes.some((w) => w.index === byNextTs || w.index === backendState))) this.poke();
    }, "scheduler");
    this.loop = this.run();
    this.scheduleGc(1000);
  }

  async stop() {
    this.stopped = true;
    this.poke();
    if (this.gcTimer) clearTimeout(this.gcTimer);
    await this.loop;
    await Promise.allSettled(this.running.values());
  }

  private poke() {
    this.pokes++;
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  private async run() {
    while (!this.stopped) {
      const pokesSeen = this.pokes;
      let nextAt: number | null = null;
      try {
        const now = wallClock();
        const free = this.o.parallelism - this.running.size;
        // Stopped (paused): no polling until a commit to `_backend_state` wakes the loop (Convex).
        if (await this.engine.query(async (db) => isStopped(await readBackendState(db)))) {
          if (this.stopped) return;
          if (this.pokes !== pokesSeen) continue;
          await new Promise<void>((resolve) => {
            this.wake = resolve;
          });
          continue;
        }
        // The next job ready to start, for the app metrics' lag: a due job left waiting, else the next one.
        let ready: number | null | undefined;
        if (free > 0) {
          // Each job with its arguments (`_scheduled_job_args`), read at the same snapshot; a job whose arguments
          // cannot be read fails its attempt as a system error.
          const due = await this.engine.query(async (db) => {
            const jobs = await dueJobs(db, now, free + this.running.size);
            return Promise.all(
              jobs.map(async (job) => ({
                job,
                args: this.running.has(job._id)
                  ? []
                  : await jobArgs(db, job).catch((e: unknown) => ({ error: (e as Error).message })),
              })),
            );
          });
          for (const { job, args } of due) {
            if (this.running.size >= this.o.parallelism) {
              if (!this.running.has(job._id)) ready = job.nextTs;
              break;
            }
            if (this.running.has(job._id)) continue;
            const p = this.execute(job, args).finally(() => {
              this.running.delete(job._id);
              this.poke();
            });
            this.running.set(job._id, p);
          }
        }
        nextAt = await this.engine.query((db) => nextJobTs(db, now));
        // At full capacity Convex keeps the time it had.
        const oldest = free > 0 ? (ready === undefined ? nextAt : ready) : this.lastReady;
        this.oldestReady = oldest;
        this.logStats(oldest, now);
      } catch (e) {
        if (e instanceof CommitterStoppedError) return;
        console.error("scheduled functions: the executor failed, retrying", e);
        nextAt = wallClock() + 1000;
      }
      if (this.stopped) return;
      if (this.pokes !== pokesSeen) continue; // something happened meanwhile: look again
      // Sleep until the next job is due, a commit adds one, or a running job finishes.
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        if (nextAt !== null) {
          const t = setTimeout(() => this.poke(), Math.max(0, nextAt - wallClock()));
          const prev = resolve;
          this.wake = () => {
            clearTimeout(t);
            prev();
          };
        }
      });
    }
  }

  private lastStatsLog = 0;
  private lastReady: number | null = null;
  /** The ready time of the oldest runnable job the last loop saw (`/metrics`), ms; null with none. */
  private oldestReady: number | null = null;

  /** Scheduled functions running now. */
  get runningJobs(): number {
    return this.running.size;
  }

  /**
   * Convex's `scheduled_job_backlog_seconds`: how long the oldest runnable job has waited, 0 with none. It
   * keeps growing while the loop does not run again, so a stalled executor shows.
   */
  backlogSeconds(now = wallClock()): number {
    return this.oldestReady === null ? 0 : Math.max(0, now - this.oldestReady) / 1000;
  }

  /**
   * Convex's scheduler stats for the app metrics (`log_scheduled_job_stats`): logged when the next ready
   * time moves by 30 s or more, appears or goes, and every 30 s while a job is overdue.
   */
  private logStats(ready: number | null, now: number) {
    const last = this.lastReady;
    const moved = last === null || ready === null ? last !== ready : Math.abs(last - ready) >= 30_000;
    if (moved || (ready !== null && ready <= now && now - this.lastStatsLog >= 30_000)) {
      this.functions.appMetrics?.recordScheduledJobs(ready, now);
      // And to log streams (Convex's `ScheduledJobLag` when late, `SchedulerStats` when late or busy).
      const lag = ready === null ? Number.NEGATIVE_INFINITY : (now - ready) / 1000;
      const logs = this.functions.logManager;
      if (logs?.active) {
        if (lag > 0) logs.send([{ timestamp: now, event: { topic: "scheduled_job_lag", lagSeconds: lag } }]);
        if (lag > 0 || this.running.size > 0)
          logs.send([
            {
              timestamp: now,
              event: { topic: "scheduler_stats", lagSeconds: Math.max(lag, 0), numRunningJobs: this.running.size },
            },
          ]);
      }
      this.lastReady = ready;
      this.lastStatsLog = now;
    }
  }

  /** Re-read the job: an attempt goes ahead only if nothing changed it since it was picked (Convex). */
  private async unchanged(db: Tx, job: JobDoc) {
    const now = await getJob(db, job._id);
    return now !== null && stringifyValue(now) === stringifyValue(job);
  }

  /**
   * Traced (STUDY-131 AD-26), each run is a `scheduler/run` trace of its own, with the function's execution
   * under it (Convex's scheduler opens a root span per job too).
   */
  private execute(job: JobDoc, args: Value[] | { error: string }): Promise<void> {
    const tracer = this.engine.tracer;
    if (!tracer.on) return this.executeJob(job, args);
    const span = tracer.root("scheduler/run", SPAN_KIND.consumer);
    span?.set("bunvex.scheduler.job_id", job._id).set("bunvex.function.path", job.name);
    return tracer.within(span, () => this.executeJob(job, args)).finally(() => span?.finish());
  }

  private async executeJob(job: JobDoc, args: Value[] | { error: string }) {
    this.stats.started++;
    const target = this.functions.scheduledKind(job.name);
    try {
      if (!Array.isArray(args)) throw new Error(args.error);
      if (job.state.kind === "inProgress") {
        // Picked up in progress, but not running here: an action cut short. Never run it again.
        await this.finish(job, { kind: "failed", error: "Transient error while executing action" });
      } else if ("error" in target) {
        await this.finish(job, { kind: "failed", error: target.error });
      } else if (target.kind === "mutation") {
        await this.runMutation(job, args[0]);
      } else {
        await this.runAction(job, args[0]);
      }
    } catch (e) {
      if (e instanceof CommitterStoppedError) return;
      // A system error: try again later, with Convex's backoff. Counted once the attempt is recorded.
      const failures = job.systemErrors + 1;
      const delay = backoff(failures, this.o.errorInitialBackoffMs, this.o.errorMaxBackoffMs);
      await this.engine
        .mutation(async (db) => {
          if (await this.unchanged(db, job))
            await patchJob(db, job._id, { systemErrors: failures, nextTs: wallClock() + delay });
        }, "_system/scheduled_job_system_error")
        .catch(() => {});
      this.stats.systemErrors++;
    }
  }

  private async finish(job: JobDoc, state: JobDoc["state"]) {
    await this.engine.mutation(async (db) => {
      if (await this.unchanged(db, job)) await completeJob(db, job._id, state, Date.now());
    }, "_system/scheduled_job");
    if (state.kind === "failed") this.stats.failed++;
  }

  private async runMutation(job: JobDoc, args: Value | undefined) {
    const body = this.functions.scheduledMutationBody(job.name, args, job._id);
    const retries = { n: 0 };
    for (let occFailures = 0; ; ) {
      try {
        // Exactly once: the job is finished in the transaction that commits the mutation's writes.
        const caller: SourcedCaller = { ...asJob(job._id), retries, retriesOcc: true };
        let value: unknown;
        const ran = await this.functions.logged(
          "Mutation",
          job.name,
          caller,
          () =>
            this.engine.mutation(
              async (db) => {
                if (!(await this.unchanged(db, job))) return false;
                await patchJob(db, job._id, {
                  state: { kind: "inProgress", requestId: randomId(), executionId: randomId() },
                });
                value = await body(db);
                await completeJob(db, job._id, { kind: "success" }, Date.now());
                return true;
              },
              job.name,
              caller,
              THROTTLED,
            ),
          // A job that changed meanwhile did not run.
          (ran) => (ran ? { returnBytes: rawValueSize((value ?? null) as Value) } : { skip: true }),
          undefined,
          args,
        );
        if (ran) this.stats.succeeded++;
        return;
      } catch (e) {
        // A lost conflict, or the write throughput limit (STUDY-78): the job stays pending and runs again
        // later, as long as it takes (Convex retries both without limit).
        if (e instanceof OccError || e instanceof TooManyWritesError) {
          this.stats.occRetries++;
          await Bun.sleep(backoff(++occFailures, this.o.occInitialBackoffMs, this.o.occMaxBackoffMs));
          continue;
        }
        if (isSystemFailure(e)) throw e;
        // The mutation's own error: its writes are gone; record it.
        await this.finish(job, { kind: "failed", error: describeUncaught(e).message });
        return;
      }
    }
  }

  private async runAction(job: JobDoc, args: Value | undefined) {
    const requestId = randomId();
    const executionId = randomId();
    const started = await this.engine.mutation(async (db) => {
      if (!(await this.unchanged(db, job))) return null;
      await patchJob(db, job._id, { state: { kind: "inProgress", requestId, executionId } });
      return getJob(db, job._id);
    }, "_system/scheduled_job");
    if (!started) return;
    let state: JobDoc["state"];
    try {
      await this.functions.runAction(job.name, args, asJob(job._id), {
        job: job._id,
        internal: true,
        waitForPermit: true,
      });
      state = { kind: "success" };
    } catch (e) {
      state = { kind: "failed", error: describeUncaught(e).message };
    }
    // Recorded until it sticks; a job canceled meanwhile stays canceled (`completeJob` is a no-op then).
    for (let n = 1; ; n++) {
      try {
        await this.engine.mutation((db) => completeJob(db, job._id, state, Date.now()), "_system/scheduled_job");
        break;
      } catch (e) {
        if (e instanceof CommitterStoppedError) return;
        await Bun.sleep(backoff(n, this.o.errorInitialBackoffMs, this.o.errorMaxBackoffMs));
      }
    }
    if (state.kind === "success") this.stats.succeeded++;
    else this.stats.failed++;
  }

  /** Delete jobs completed before the retention window, in batches of 100, then wait. */
  private scheduleGc(delayMs: number) {
    if (this.stopped) return;
    this.gcTimer = setTimeout(async () => {
      let next = 60_000;
      try {
        const before = wallClock() - this.o.retentionSeconds * 1000;
        const n = await this.engine.mutation((db) => deleteCompletedJobs(db, before, 100), "_system/scheduled_job_gc");
        if (n === 100) next = 1000; // more to delete
      } catch (e) {
        if (e instanceof CommitterStoppedError) return;
        next = 30_000;
      }
      this.scheduleGc(next);
    }, delayMs);
  }
}

/** A failure of the system rather than of the function: the job is retried later, not failed. */
function isSystemFailure(e: unknown) {
  // An index still being rebuilt after a start (STUDY-79) is the system's too: the job runs later.
  return e instanceof CommitterStoppedError || e instanceof IndexesUnavailableError;
}

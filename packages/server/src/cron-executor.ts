// The cron executor (Convex's crates/application/src/cron_jobs): due crons run by `nextTs`, at most one
// run per cron at a time, as no one.
// - A mutation runs exactly once: its log and the next run are written in the transaction that commits it.
// - An action runs at most once: in progress is committed first; one found in progress that no one runs
//   was cut short, so it is logged as "Transient error while executing action" and the cron moves on.
import { CommitterStoppedError, type Engine, OccError, stringifyValue, type Tx, wallClock } from "@bunvex/core";
import { displayValue, type Value, valueSize } from "@bunvex/values";
import type { CronSpec } from "./cron.ts";
import {
  applyCrons,
  CRON_LOG_MAX_RESULT_LENGTH,
  type CronJob,
  type CronStatus,
  completeRun,
  currentJob,
  dueCrons,
  insertLog,
  type NextOpts,
  nextCronTs,
  setCronState,
  truncateLogLines,
} from "./cron-model.ts";
import { describeUncaught } from "./errors.ts";
import type { Functions, SourcedCaller } from "./functions.ts";
import { collectLogs, currentLogLines } from "./logs.ts";

export type CronExecutorOptions = NextOpts & {
  parallelism?: number;
  occInitialBackoffMs?: number;
  occMaxBackoffMs?: number;
  errorInitialBackoffMs?: number;
  errorMaxBackoffMs?: number;
};

const backoff = (failures: number, initialMs: number, maxMs: number) =>
  Math.random() * Math.min(maxMs, initialMs * 2 ** Math.max(0, failures - 1));
const randomId = () => crypto.randomUUID().replaceAll("-", "");
/** A cron runs with no identity (Convex's `Identity::Unknown`), logged as the `Cron` caller (STUDY-47). */
const NO_ONE: SourcedCaller = { identity: null, key: "", source: "Cron" };

function resultStatus(value: unknown): CronStatus {
  const v = (value ?? null) as Value;
  const s = displayValue(v);
  return s.length <= CRON_LOG_MAX_RESULT_LENGTH
    ? { type: "success", result: { type: "default", value: v } }
    : { type: "success", result: { type: "truncated", truncated_log: s.slice(0, CRON_LOG_MAX_RESULT_LENGTH) } };
}

export class CronJobExecutor {
  private readonly running = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();
  private stopped = false;
  private wake: (() => void) | null = null;
  private pokes = 0;
  private loop: Promise<void> | null = null;
  private readonly o: Required<Omit<CronExecutorOptions, "rng">> & NextOpts;
  readonly stats = { runs: 0, skippedLogs: 0 };

  constructor(
    private readonly engine: Engine,
    private readonly functions: Functions,
    private specs: Map<string, CronSpec>,
    options: CronExecutorOptions = {},
  ) {
    this.o = {
      parallelism: options.parallelism ?? 8,
      occInitialBackoffMs: options.occInitialBackoffMs ?? 100,
      occMaxBackoffMs: options.occMaxBackoffMs ?? 60_000,
      errorInitialBackoffMs: options.errorInitialBackoffMs ?? 500,
      errorMaxBackoffMs: options.errorMaxBackoffMs ?? 15_000,
      cronSplaySeconds: options.cronSplaySeconds ?? 60,
      rng: options.rng,
    };
  }

  /**
   * Register the declared crons (S1: the start is the push), then run them. `apply: false` (a deployable
   * server, STUDY-35): the stored crons stay as they are until a code version pushes its own.
   */
  async start(apply = true) {
    const diff = apply
      ? await this.engine.mutation((db) => applyCrons(db, this.specs, Date.now(), this.o), "cron_push")
      : undefined;
    const byNextTs = this.engine.catalog.table("_cron_next_run").indexes.get("by_next_ts")!.id;
    this.engine.committer.onCommit((entries) => {
      if (entries.some((e) => e.writes.some((w) => w.index === byNextTs))) this.poke();
    });
    this.loop = this.run();
    return diff;
  }

  /** The same diff inside a transaction of the caller's (a push's commit, STUDY-35); `wake()` once it commits. */
  applyIn(db: Tx, specs: Map<string, CronSpec>) {
    this.specs = specs;
    return applyCrons(db, specs, Date.now(), this.o);
  }

  /** Look at the stored crons again (after a commit that changed them). */
  refresh() {
    this.poke();
  }

  /** A new code version's crons (STUDY-35): the same diff as at start, against what is stored. */
  async push(specs: Map<string, CronSpec>) {
    this.specs = specs;
    const diff = await this.engine.mutation((db) => applyCrons(db, specs, Date.now(), this.o), "cron_push");
    this.poke();
    return diff;
  }

  async stop() {
    this.stopped = true;
    this.poke();
    await this.loop;
    await Promise.allSettled(this.tasks);
  }

  private poke() {
    this.pokes++;
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  private async run() {
    while (!this.stopped) {
      const seen = this.pokes;
      let nextAt: number | null = null;
      try {
        const now = wallClock();
        if (this.running.size < this.o.parallelism) {
          const due = await this.engine.query((db) => dueCrons(db, now, this.o.parallelism + this.running.size));
          for (const job of due) {
            if (this.running.size >= this.o.parallelism) break;
            if (this.running.has(job.id)) continue; // never two runs of one cron at once
            this.running.add(job.id);
            const t = this.execute(job).finally(() => {
              this.running.delete(job.id);
              this.tasks.delete(t);
              this.poke();
            });
            this.tasks.add(t);
          }
        }
        nextAt = await this.engine.query((db) => nextCronTs(db, now));
      } catch (e) {
        if (e instanceof CommitterStoppedError) return;
        console.error("cron jobs: the executor failed, retrying", e);
        nextAt = wallClock() + 1000;
      }
      if (this.stopped) return;
      if (this.pokes !== seen) continue;
      await new Promise<void>((resolve) => {
        const t = nextAt === null ? null : setTimeout(() => this.poke(), Math.max(0, nextAt - wallClock()));
        this.wake = () => {
          if (t) clearTimeout(t);
          resolve();
        };
      });
    }
  }

  /** An attempt goes ahead only if the cron is still as it was picked (Convex's `new_transaction_for_job_state`). */
  private async unchanged(db: Tx, job: CronJob) {
    const now = await currentJob(db, job.id);
    return now !== null && stringifyValue(now as never) === stringifyValue(job as never);
  }

  private async execute(job: CronJob) {
    for (let failures = 0; ; failures++) {
      try {
        if (job.state.type === "inProgress") return await this.finishCutShort(job);
        const target = this.functions.scheduledKind(job.cronSpec.udfPath);
        if ("error" in target) throw new Error(`Cron trying to execute missing function: ${target.error}`);
        if (target.kind === "mutation") return await this.runMutation(job);
        return await this.runAction(job);
      } catch (e) {
        if (e instanceof CommitterStoppedError || this.stopped) return;
        // A system error: retry, with backoff (Convex retries these without end).
        console.error(`cron ${job.name}:`, e);
        await Bun.sleep(backoff(failures + 1, this.o.errorInitialBackoffMs, this.o.errorMaxBackoffMs));
      }
    }
  }

  private async finishCutShort(job: CronJob) {
    await this.engine.mutation(async (db) => {
      if (!(await this.unchanged(db, job))) return;
      await insertLog(
        db,
        job,
        job.nextTs,
        { type: "err", error: "Transient error while executing action" },
        { logLines: [], isTruncated: false },
        0,
      );
      await completeRun(db, job, Date.now(), this.o);
    }, "cron_transient_error");
  }

  private async runMutation(job: CronJob) {
    const body = this.functions.scheduledMutationBody(job.cronSpec.udfPath, job.cronSpec.udfArgs[0]);
    for (let occ = 0; ; ) {
      const t0 = performance.now();
      let value: unknown;
      const r = await collectLogs(() =>
        this.functions.logged(
          "Mutation",
          job.cronSpec.udfPath,
          NO_ONE,
          () =>
            this.engine.mutation(
              async (db) => {
                if (!(await this.unchanged(db, job))) return false;
                value = await body(db);
                // The log of this run, with its lines so far, and the next run: in the run's own transaction.
                const lines = truncateLogLines(currentLogLines());
                await insertLog(db, job, job.nextTs, resultStatus(value), lines, (performance.now() - t0) / 1000);
                await completeRun(db, job, Date.now(), this.o);
                return true;
              },
              job.cronSpec.udfPath,
              NO_ONE,
            ),
          // A cron that changed meanwhile did not run.
          (ran) => (ran ? { returnBytes: valueSize((value ?? null) as Value) } : { skip: true }),
        ),
      );
      if (r.ok) {
        if (r.value) this.stats.runs++;
        return;
      }
      if (r.error instanceof OccError) {
        await Bun.sleep(backoff(++occ, this.o.occInitialBackoffMs, this.o.occMaxBackoffMs));
        continue;
      }
      if (r.error instanceof CommitterStoppedError) throw r.error;
      // The function's own error: log it and move on, in a new transaction.
      const error = describeUncaught(r.error).message;
      await this.engine.mutation(async (db) => {
        if (!(await this.unchanged(db, job))) return;
        await insertLog(
          db,
          job,
          job.nextTs,
          { type: "err", error },
          truncateLogLines(r.logLines),
          (performance.now() - t0) / 1000,
        );
        await completeRun(db, job, Date.now(), this.o);
      }, "cron_save_mutation_error");
      this.stats.runs++;
      return;
    }
  }

  private async runAction(job: CronJob) {
    const state = { type: "inProgress" as const, requestId: randomId(), executionId: randomId() };
    const started = await this.engine.mutation(async (db) => {
      if (!(await this.unchanged(db, job))) return null;
      await setCronState(db, job, state);
      return currentJob(db, job.id);
    }, "cron_in_progress");
    if (!started) return;
    const t0 = performance.now();
    const r = await collectLogs(() =>
      this.functions.runAction(job.cronSpec.udfPath, job.cronSpec.udfArgs[0], NO_ONE, { internal: true }),
    );
    const status: CronStatus = r.ok ? resultStatus(r.value) : { type: "err", error: describeUncaught(r.error).message };
    const elapsed = (performance.now() - t0) / 1000;
    for (let n = 1; ; n++) {
      try {
        await this.engine.mutation(async (db) => {
          // Recorded only if the cron is still the run that started (a changed schedule drops it).
          if (!(await this.unchanged(db, started))) return;
          await insertLog(db, started, started.nextTs, status, truncateLogLines(r.logLines), elapsed);
          await completeRun(db, started, Date.now(), this.o);
        }, "cron_complete_action");
        this.stats.runs++;
        return;
      } catch (e) {
        if (e instanceof CommitterStoppedError) return;
        await Bun.sleep(backoff(n, this.o.errorInitialBackoffMs, this.o.errorMaxBackoffMs));
      }
    }
  }
}

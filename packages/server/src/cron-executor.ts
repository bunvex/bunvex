// The cron executor (Convex's crates/application/src/cron_jobs): due crons run by `nextTs`, at most one
// run per cron at a time, as no one.
// - A mutation runs exactly once: its log and the next run are written in the transaction that commits it.
// - An action runs at most once: in progress is committed first; one found in progress that no one runs
//   was cut short, so it is logged as "Transient error while executing action" and the cron moves on.
// - Every namespace's crons (STUDY-157 PR 2), as Convex's executor merges them: a component's cron runs its own
//   component's function; its next run and its logs are its namespace's.
import {
  BACKEND_STATE_TABLE,
  CommitterStoppedError,
  CRON_NEXT_RUN_TABLE,
  type Engine,
  isStopped,
  OccError,
  readBackendState,
  SPAN_KIND,
  stringifyValue,
  TooManyWritesError,
  type Tx,
  timerDelay,
} from "@bunvex/core";
import { displayValue, rawValueSize, type Value } from "@bunvex/values";
import type { CronSpec } from "./cron.ts";
import {
  applyCrons,
  CRON_LOG_MAX_RESULT_LENGTH,
  type CronDiff,
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
import { type Functions, type SourcedCaller, THROTTLED } from "./functions.ts";
import { collectLogs, currentLogLines } from "./logs.ts";
import { inNamespace } from "./scheduler.ts";

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

/** A cron as the executor holds it: with the namespace it lives in (a `_components` id; null the app's). */
type Queued = CronJob & { ns: string | null };
/** A running cron's key: ids of different namespaces may share a table number. */
const runningKey = (job: Queued) => `${job.ns ?? ""}\u0000${job.id}`;

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
  /** Ends a backoff sleep early (on stop). */
  private interrupt: (() => void) | null = null;
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
   *
   * Resolves with the diff once the crons are registered, or with undefined if the executor stops first. It
   * never rejects: a failed registration (the store failing a read, say) is logged and retried with backoff,
   * as Convex's background workers do (crates/application/src/cron_jobs/mod.rs `CronJobExecutor::run`), and
   * the crons run once it succeeds — a store fault at startup never takes the process down.
   */
  start(apply = true): Promise<CronDiff | undefined> {
    // Started late (a deployable server starts it once its code is loaded) after a stop: nothing to run.
    if (this.stopped) return Promise.resolve(undefined);
    // Woken by a commit to any namespace's next runs (a push adds a component's: the set follows the catalog), and
    // by a pause or unpause (STUDY-63), as Convex's executors subscribe to `_backend_state`.
    const backendState = this.engine.catalog.table(BACKEND_STATE_TABLE).byId.id;
    let catalog = this.engine.catalog;
    let watched = this.queueIndexes();
    this.engine.committer.onCommit((entries) => {
      if (this.engine.catalog !== catalog) {
        catalog = this.engine.catalog;
        watched = this.queueIndexes();
      }
      if (entries.some((e) => e.writes.some((w) => watched.has(w.index) || w.index === backendState))) this.poke();
    }, "cron executor");
    const registered = apply ? this.register() : Promise.resolve(undefined);
    this.loop = registered.then(() => (this.stopped ? undefined : this.run()));
    return registered;
  }

  /**
   * The namespaces whose crons run: the app's (null) and each component's whose code is installed, by `_components`
   * id. A push commits a component's crons before it installs its code, then `refresh()`es: until then they wait.
   */
  private namespaces(): (string | null)[] {
    const ids = [...this.engine.catalog.components]
      .filter(([id, c]) => c.tables.has(CRON_NEXT_RUN_TABLE) && this.functions.componentPathOf(id) !== undefined)
      .map(([id]) => id);
    return [null, ...ids];
  }

  /** Each namespace's `_cron_next_run.by_next_ts`. */
  private queueIndexes(): Set<string> {
    const catalog = this.engine.catalog;
    const ids = new Set<string>();
    for (const c of [catalog, ...catalog.components.values()]) {
      const index = c.tables.get(CRON_NEXT_RUN_TABLE)?.indexes.get("by_next_ts");
      if (index) ids.add(index.id);
    }
    return ids;
  }

  /** The first `limit` crons due at `now` across the namespaces, by next run (Convex merges them). */
  private async dueCrons(db: Tx, now: number, limit: number): Promise<Queued[]> {
    const order = this.namespaces();
    const all: Queued[] = [];
    for (const ns of order)
      for (const job of await inNamespace(db, ns, () => dueCrons(db, now, limit))) all.push({ ...job, ns });
    all.sort((a, b) => a.nextTs - b.nextTs || order.indexOf(a.ns) - order.indexOf(b.ns));
    return all.slice(0, limit);
  }

  /** The earliest next run after `now` (ms) across the namespaces, if any. */
  private async nextCronTs(db: Tx, now: number): Promise<number | null> {
    let next: number | null = null;
    for (const ns of this.namespaces()) {
      const t = await inNamespace(db, ns, () => nextCronTs(db, now));
      if (t !== null && (next === null || t < next)) next = t;
    }
    return next;
  }

  /** The startup diff, until it commits (or the executor stops). */
  private async register(): Promise<CronDiff | undefined> {
    for (let failures = 1; !this.stopped; failures++) {
      try {
        return await this.engine.mutation((db) => applyCrons(db, this.specs, Date.now(), this.o), "_system/cron_push");
      } catch (e) {
        if (e instanceof CommitterStoppedError || this.stopped) return undefined;
        const delay = backoff(failures, this.o.errorInitialBackoffMs, this.o.errorMaxBackoffMs);
        console.error(`cron jobs: registering the crons failed, retrying in ${Math.round(delay)} ms`, e);
        await this.pause(delay);
      }
    }
    return undefined;
  }

  /** Sleep `ms`, or less if the executor stops. */
  private pause(ms: number) {
    return new Promise<void>((resolve) => {
      const t = this.engine.runtime.setTimeout(done, ms);
      const self = this;
      function done() {
        self.engine.runtime.clearTimeout(t);
        self.interrupt = null;
        resolve();
      }
      this.interrupt = done;
    });
  }

  /** The same diff inside a transaction of the caller's (a push's commit, STUDY-35); `wake()` once it commits. */
  applyIn(db: Tx, specs: Map<string, CronSpec>) {
    this.specs = specs;
    return applyCrons(db, specs, Date.now(), this.o);
  }

  /**
   * A component's crons in its namespace, inside a push's commit (Convex's `CronModel::apply` per component); the
   * executor runs them with the app's (STUDY-157 PR 2).
   */
  applyInComponent(db: Tx, namespace: string, specs: Map<string, CronSpec>) {
    return db.inComponent(namespace, () => applyCrons(db, specs, Date.now(), this.o));
  }

  /** Look at the stored crons again (after a commit that changed them). */
  refresh() {
    this.poke();
  }

  /** A new code version's crons (STUDY-35): the same diff as at start, against what is stored. */
  async push(specs: Map<string, CronSpec>) {
    this.specs = specs;
    const diff = await this.engine.mutation((db) => applyCrons(db, specs, Date.now(), this.o), "_system/cron_push");
    this.poke();
    return diff;
  }

  async stop() {
    this.stopped = true;
    this.interrupt?.();
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
    let failures = 0;
    while (!this.stopped) {
      const seen = this.pokes;
      let nextAt: number | null = null;
      try {
        const now = this.engine.runtime.now();
        // Stopped (paused): no polling until a commit to `_backend_state` wakes the loop (Convex).
        if (await this.engine.query(async (db) => isStopped(await readBackendState(db)))) {
          if (this.stopped) return;
          if (this.pokes !== seen) continue;
          await new Promise<void>((resolve) => {
            this.wake = resolve;
          });
          continue;
        }
        if (this.running.size < this.o.parallelism) {
          const due = await this.engine.query((db) => this.dueCrons(db, now, this.o.parallelism + this.running.size));
          for (const job of due) {
            const key = runningKey(job);
            if (this.running.size >= this.o.parallelism) break;
            if (this.running.has(key)) continue; // never two runs of one cron at once
            this.running.add(key);
            const t = this.execute(job).finally(() => {
              this.running.delete(key);
              this.tasks.delete(t);
              this.poke();
            });
            this.tasks.add(t);
          }
        }
        nextAt = await this.engine.query((db) => this.nextCronTs(db, now));
        failures = 0;
      } catch (e) {
        if (e instanceof CommitterStoppedError) return;
        // As Convex's executor loop: log, back off (500 ms to 15 s), and look again.
        const delay = backoff(++failures, this.o.errorInitialBackoffMs, this.o.errorMaxBackoffMs);
        console.error(`cron jobs: the executor failed, retrying in ${Math.round(delay)} ms`, e);
        nextAt = this.engine.runtime.now() + delay;
      }
      if (this.stopped) return;
      if (this.pokes !== seen) continue;
      await new Promise<void>((resolve) => {
        // Capped (STUDY-174 F3): a yearly cron wakes the loop every 24.8 days, which looks again.
        // Capped (STUDY-174 F3): a yearly cron wakes the loop every 24.8 days, which looks again.
        const t =
          nextAt === null
            ? null
            : this.engine.runtime.setTimeout(() => this.poke(), timerDelay(nextAt - this.engine.runtime.now()));
        this.wake = () => {
          if (t) this.engine.runtime.clearTimeout(t);
          resolve();
        };
      });
    }
  }

  /** An attempt goes ahead only if the cron is still as it was picked (Convex's `new_transaction_for_job_state`). */
  private async unchanged(db: Tx, job: Queued) {
    const { ns, ...cron } = job;
    const now = await inNamespace(db, ns, () => currentJob(db, job.id));
    return now !== null && stringifyValue(now as never) === stringifyValue(cron as never);
  }

  /** Traced (STUDY-131 AD-26), each run is a `cron/run` trace of its own, its function's execution under it. */
  private execute(job: Queued): Promise<void> {
    const tracer = this.engine.tracer;
    if (!tracer.on) return this.executeJob(job);
    const span = tracer.root("cron/run", SPAN_KIND.consumer);
    span?.set("bunvex.cron.name", job.name).set("bunvex.function.path", job.cronSpec.udfPath);
    return tracer.within(span, () => this.executeJob(job)).finally(() => span?.finish());
  }

  private async executeJob(job: Queued) {
    for (let failures = 0; ; failures++) {
      try {
        if (job.state.type === "inProgress") return await this.finishCutShort(job);
        // Its own component's function (a component whose code is gone has none).
        const target = this.functions.scheduledKind(
          job.cronSpec.udfPath,
          this.functions.componentPathOf(job.ns) ?? "\u0000gone",
        );
        if ("error" in target) {
          // As Convex's `run_function`: the job is checked before the function. A push that deleted the cron
          // with its function leaves nothing to run; only a cron that still exists is a (retried) system error.
          if (!(await this.engine.query((db) => this.unchanged(db, job)))) return;
          throw new Error(`Cron trying to execute missing function: ${target.error}`);
        }
        if (target.kind === "mutation") return await this.runMutation(job, target.key);
        return await this.runAction(job, target.key);
      } catch (e) {
        if (e instanceof CommitterStoppedError || this.stopped) return;
        // A system error: retry, with backoff (Convex retries these without end).
        console.error(`cron ${job.name}:`, e);
        await this.engine.runtime.sleep(backoff(failures + 1, this.o.errorInitialBackoffMs, this.o.errorMaxBackoffMs));
      }
    }
  }

  private async finishCutShort(job: Queued) {
    await this.engine.mutation(async (db) => {
      if (!(await this.unchanged(db, job))) return;
      await inNamespace(db, job.ns, async () => {
        await insertLog(
          db,
          job,
          job.nextTs,
          { type: "err", error: "Transient error while executing action" },
          { logLines: [], isTruncated: false },
          0,
        );
        await completeRun(db, job, Date.now(), this.o);
      });
    }, "_system/cron_transient_error");
  }

  /** `name`: what to run it by (`scheduledKind`'s `key`). */
  private async runMutation(job: Queued, name: string) {
    const body = this.functions.scheduledMutationBody(name, job.cronSpec.udfArgs[0]);
    const retries = { n: 0 };
    for (let occ = 0; ; ) {
      const t0 = this.engine.runtime.monotonicNow();
      let value: unknown;
      const r = await collectLogs(() =>
        this.functions.logged(
          "Mutation",
          name,
          { ...NO_ONE, retries, retriesOcc: true } as SourcedCaller,
          () =>
            this.engine.mutation(
              async (db) => {
                if (!(await this.unchanged(db, job))) return false;
                value = await body(db);
                // The log of this run, with its lines so far, and the next run: in the run's own transaction, in
                // the cron's namespace.
                const lines = truncateLogLines(currentLogLines());
                await inNamespace(db, job.ns, async () => {
                  await insertLog(
                    db,
                    job,
                    job.nextTs,
                    resultStatus(value),
                    lines,
                    (this.engine.runtime.monotonicNow() - t0) / 1000,
                  );
                  await completeRun(db, job, Date.now(), this.o);
                });
                return true;
              },
              job.cronSpec.udfPath,
              NO_ONE,
              THROTTLED,
            ),
          // A cron that changed meanwhile did not run.
          (ran) => (ran ? { returnBytes: rawValueSize((value ?? null) as Value) } : { skip: true }),
          job.cronSpec.udfArgs[0],
        ),
      );
      if (r.ok) {
        if (r.value) this.stats.runs++;
        return;
      }
      // A lost conflict, or the write throughput limit (STUDY-78): run again later, as Convex's loop does.
      if (r.error instanceof OccError || r.error instanceof TooManyWritesError) {
        await this.engine.runtime.sleep(backoff(++occ, this.o.occInitialBackoffMs, this.o.occMaxBackoffMs));
        continue;
      }
      if (r.error instanceof CommitterStoppedError) throw r.error;
      // The function's own error: log it and move on, in a new transaction.
      const error = describeUncaught(r.error).message;
      await this.engine.mutation(async (db) => {
        if (!(await this.unchanged(db, job))) return;
        await inNamespace(db, job.ns, async () => {
          await insertLog(
            db,
            job,
            job.nextTs,
            { type: "err", error },
            truncateLogLines(r.logLines),
            (this.engine.runtime.monotonicNow() - t0) / 1000,
          );
          await completeRun(db, job, Date.now(), this.o);
        });
      }, "_system/cron_save_mutation_error");
      this.stats.runs++;
      return;
    }
  }

  /** `name`: what to run it by (`scheduledKind`'s `key`). */
  private async runAction(job: Queued, name: string) {
    const state = { type: "inProgress" as const, requestId: randomId(), executionId: randomId() };
    const started = await this.engine.mutation(async (db) => {
      if (!(await this.unchanged(db, job))) return null;
      return inNamespace(db, job.ns, async () => {
        await setCronState(db, job, state);
        const now = await currentJob(db, job.id);
        return now && { ...now, ns: job.ns };
      });
    }, "_system/cron_in_progress");
    if (!started) return;
    const t0 = this.engine.runtime.monotonicNow();
    const r = await collectLogs(() =>
      this.functions.runAction(name, job.cronSpec.udfArgs[0], NO_ONE, {
        internal: true,
        waitForPermit: true,
      }),
    );
    const status: CronStatus = r.ok ? resultStatus(r.value) : { type: "err", error: describeUncaught(r.error).message };
    const elapsed = (this.engine.runtime.monotonicNow() - t0) / 1000;
    for (let n = 1; ; n++) {
      try {
        await this.engine.mutation(async (db) => {
          // Recorded only if the cron is still the run that started (a changed schedule drops it).
          if (!(await this.unchanged(db, started))) return;
          await inNamespace(db, started.ns, async () => {
            await insertLog(db, started, started.nextTs, status, truncateLogLines(r.logLines), elapsed);
            await completeRun(db, started, Date.now(), this.o);
          });
        }, "_system/cron_complete_action");
        this.stats.runs++;
        return;
      } catch (e) {
        if (e instanceof CommitterStoppedError) return;
        await this.engine.runtime.sleep(backoff(n, this.o.errorInitialBackoffMs, this.o.errorMaxBackoffMs));
      }
    }
  }
}

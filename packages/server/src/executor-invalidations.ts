// The subscription invalidations Convex counts for its own executors (STUDY-149 PR 5, DV-480 resolved to match
// Convex). Convex's scheduler and cron executor wait on database subscriptions (application/src/scheduled_jobs/
// mod.rs:331, cron_jobs/mod.rs:211), so its Health chart shows `<mutation>:_scheduled_jobs` for a commit that
// schedules and `<function>:_cron_next_run` for each cron run (function_log.rs:1302-1320). bunvex's executors are
// woken by the committer instead; this records what those subscriptions would count.
//
// Each executor's read reaches its first job that is not due yet (`stream_jobs_to_run` stops there), so a commit
// counts when it writes a key of the queue's index before that job, or anywhere when there is none; the job itself
// is not in the range (cancelling it counts nothing, as Convex's binary). A scheduled mutation's own run counts
// twice, as the binary does: the run's commit invalidates the subscription taken before the job was due and the
// one taken after (`jobRan`). Paused, the executors read only `_backend_state`: nothing counts.
import {
  BACKEND_STATE_TABLE,
  CRON_NEXT_RUN_TABLE,
  compareKeys,
  type Engine,
  encodeKey,
  indexKey,
  isStopped,
  type LogEntry,
  readBackendState,
  SCHEDULED_BY_NEXT_TS,
  SCHEDULED_JOBS_TABLE,
} from "@bunvex/core";

/** Where a commit's invalidations go: its source as the metric names it, the table, the count. */
export type RecordInvalidations = (source: string, table: string, count: number) => void;

/**
 * Convex's executors' write sources (`commit_with_write_source`), by bunvex's name for the same commit; the
 * other system commits are not attributed. A function's source is its canonical path (`nameOf`).
 */
export const EXECUTOR_SOURCES: Readonly<Record<string, string>> = {
  "_system/scheduled_job_gc": "scheduled_job_gc",
  "_system/scheduled_job_system_error": "scheduled_job_system_error",
  "_system/scheduled_job_progress": "scheduled_job_progress",
  "_system/scheduled_job_complete_action": "scheduled_job_complete_action",
  "_system/cron_in_progress": "cron_in_progress",
  "_system/cron_complete_action": "cron_complete_action",
  "_system/cron_save_mutation_error": "cron_save_mutation_error",
  "_system/cancel_job": "cancel_job",
  "_system/cancel_all_jobs": "cancel_all_jobs",
};

/** The lowest key with an int64 first value: a pending job's (`nextTs > null`). */
const PENDING_LO = encodeKey([-(2n ** 63n)]);

/** An executor's read: its queue's index, and its first job not due yet (null: none, the range is open). */
type Queue = {
  table: string;
  index: string;
  boundary: { key: Uint8Array; atMs: number } | null;
  refreshing: Promise<void> | null;
  again: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

export class ExecutorInvalidations {
  private readonly scheduler: Queue = this.queue(SCHEDULED_JOBS_TABLE, SCHEDULED_BY_NEXT_TS);
  private readonly crons: Queue = this.queue(CRON_NEXT_RUN_TABLE, "by_next_ts");
  private stopped = false;
  private paused = false;

  constructor(
    private readonly engine: Engine,
    private readonly record: RecordInvalidations,
    /** A commit's source as the metric names it, or undefined when Convex attributes it to nothing. */
    private readonly nameOf: (source: string) => string | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  private queue(table: string, index: string): Queue {
    return { table, index, boundary: null, refreshing: null, again: false, timer: null };
  }

  /** Listens to the committer; reads both boundaries once. */
  start() {
    this.engine.committer.onCommit((entries) => this.observe(entries), "executor invalidations");
    this.refresh(this.scheduler);
    this.refresh(this.crons);
  }

  stop() {
    this.stopped = true;
    for (const q of [this.scheduler, this.crons]) if (q.timer) clearTimeout(q.timer);
  }

  /** A scheduled mutation ran (its commit is already observed): the second subscription its run invalidates. */
  jobRan(source: string) {
    if (this.paused) return;
    const name = this.nameOf(source);
    if (name !== undefined) this.record(name, SCHEDULED_JOBS_TABLE, 1);
  }

  /** Counts each commit against both executors' reads, then moves the reads it changed. */
  observe(entries: readonly LogEntry[]) {
    const catalog = this.engine.catalog;
    const jobs = catalog.table(this.scheduler.table).indexes.get(this.scheduler.index)?.id;
    const runs = catalog.table(this.crons.table).indexes.get(this.crons.index)?.id;
    const state = catalog.table(BACKEND_STATE_TABLE).byId.id;
    const now = this.now();
    let jobsMoved = false;
    let runsMoved = false;
    let stateMoved = false;
    for (const e of entries) {
      let inJobs = false;
      let inRuns = false;
      for (const w of e.writes) {
        if (w.index === jobs) {
          jobsMoved = true;
          inJobs ||= this.inRange(this.scheduler, w.key, now);
        } else if (w.index === runs) {
          runsMoved = true;
          inRuns ||= this.inRange(this.crons, w.key, now);
        } else if (w.index === state) stateMoved = true;
      }
      if ((!inJobs && !inRuns) || this.paused || e.source === undefined) continue;
      const name = this.nameOf(e.source);
      if (name === undefined) continue;
      if (inJobs) this.record(name, SCHEDULED_JOBS_TABLE, 1);
      if (inRuns) this.record(name, CRON_NEXT_RUN_TABLE, 1);
    }
    if (jobsMoved || stateMoved) this.refresh(this.scheduler);
    if (runsMoved || stateMoved) this.refresh(this.crons);
  }

  /** In the executor's read: a pending key before its first job not due yet (that job included once due). */
  private inRange(q: Queue, key: Uint8Array, now: number): boolean {
    if (compareKeys(key, PENDING_LO) < 0) return false;
    const b = q.boundary;
    if (b === null) return true;
    const c = compareKeys(key, b.key);
    // the boundary job fell due before the executor read again: it is read now
    return c < 0 || (c === 0 && b.atMs <= now);
  }

  /** Reads the queue's first job not due yet, as the executor's next read; again at its time. */
  private refresh(q: Queue) {
    if (this.stopped) return;
    if (q.refreshing) {
      q.again = true;
      return;
    }
    q.refreshing = this.read(q)
      .catch(() => {})
      .finally(() => {
        q.refreshing = null;
        if (q.again) {
          q.again = false;
          this.refresh(q);
        }
      });
  }

  private async read(q: Queue) {
    const now = this.now();
    const def = this.engine.catalog.table(q.table).indexes.get(q.index);
    if (!def) return;
    const { paused, next } = await this.engine.query(async (db) => {
      const stopped = isStopped(await readBackendState(db));
      const [doc] = (await db.asSystem(() =>
        db
          .query(q.table)
          .withIndex(q.index, (r) => r.gt("nextTs", BigInt(Math.floor(now)) * 1_000_000n))
          .take(1),
      )) as unknown as (Record<string, unknown> & { _id: string; nextTs: bigint })[];
      return { paused: stopped, next: doc ?? null };
    });
    this.paused = paused;
    if (q.timer) clearTimeout(q.timer);
    q.timer = null;
    q.boundary = next ? { key: indexKey(def, next as never), atMs: Number(next.nextTs / 1_000_000n) } : null;
    if (q.boundary && !this.stopped) {
      const wait = Math.min(2 ** 31 - 1, Math.max(0, q.boundary.atMs - this.now() + 1));
      q.timer = setTimeout(() => this.refresh(q), wait);
      (q.timer as { unref?: () => void }).unref?.();
    }
  }
}

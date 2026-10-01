// Cron jobs in the database (Convex's CronModel, crates/model/src/cron_jobs/mod.rs):
//   `_cron_jobs {name, cronSpec}`, `_cron_next_run {cronJobId, state, prevTs, nextTs}` and
//   `_cron_job_logs {name, ts, udfPath, udfArgs, status, logLines, executionTime}` (newest 5 per cron).
import { CRON_JOB_LOGS_TABLE, CRON_JOBS_TABLE, CRON_NEXT_RUN_TABLE, type Tx } from "@bunvex/core";
import type { Value } from "@bunvex/values";
import type { CronSpec } from "./cron.ts";
import { computeNextTs, type Rng } from "./cron-next.ts";

export type CronState = { type: "pending" } | { type: "inProgress"; requestId: string; executionId: string };
export type CronJobDoc = { _id: string; _creationTime: number; name: string; cronSpec: CronSpec };
export type CronNextRunDoc = {
  _id: string;
  _creationTime: number;
  cronJobId: string;
  state: CronState;
  prevTs: number | null;
  nextTs: number;
};
/** A cron with its next run: what the executor works on. */
export type CronJob = {
  id: string;
  name: string;
  cronSpec: CronSpec;
  runId: string;
  state: CronState;
  prevTs: number | null;
  nextTs: number;
};
export type CronStatus =
  | { type: "success"; result: { type: "default"; value: Value } | { type: "truncated"; truncated_log: string } }
  | { type: "err"; error: string }
  | { type: "canceled"; num_canceled: number };

/** Convex's MAX_LOGS_PER_CRON (a constant there too). */
export const MAX_LOGS_PER_CRON = 5;
export const CRON_LOG_MAX_RESULT_LENGTH = 1000;
export const CRON_LOG_MAX_LOG_LINE_LENGTH = 1000;

const sys = <T>(db: Tx, f: () => Promise<T>) => db.asSystem(f);
export type NextOpts = { rng?: Rng; cronSplaySeconds?: number };

async function listJobs(db: Tx): Promise<Map<string, CronJobDoc>> {
  const docs = (await sys(db, () => db.query(CRON_JOBS_TABLE).collect())) as unknown as CronJobDoc[];
  return new Map(docs.map((d) => [d.name, d]));
}
async function nextRunOf(db: Tx, cronJobId: string): Promise<CronNextRunDoc | null> {
  return (await sys(db, () =>
    db
      .query(CRON_NEXT_RUN_TABLE)
      .withIndex("by_cron_job_id", (q) => q.eq("cronJobId", cronJobId))
      .unique(),
  )) as unknown as CronNextRunDoc | null;
}

const sameSpec = (a: CronSpec, b: CronSpec) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
        )
      : typeof v === "bigint"
        ? `${v}n`
        : v;

/** Convex's `CronModel::apply`: the declared crons against the stored ones, by name. */
export async function applyCrons(db: Tx, specs: Map<string, CronSpec>, now: number, o: NextOpts = {}) {
  const old = await listJobs(db);
  const diff = { added: [] as string[], updated: [] as string[], deleted: [] as string[] };
  for (const [name, spec] of specs) {
    const job = old.get(name);
    if (!job) {
      const cronJobId = await sys(db, () => db.insert(CRON_JOBS_TABLE, { name, cronSpec: spec }));
      await sys(db, () =>
        db.insert(CRON_NEXT_RUN_TABLE, {
          cronJobId,
          state: { type: "pending" },
          prevTs: null,
          nextTs: computeNextTs(spec.cronSchedule, null, now, o),
        }),
      );
      diff.added.push(name);
    } else if (!sameSpec(job.cronSpec, spec)) {
      if (JSON.stringify(sortKeys(job.cronSpec.cronSchedule)) !== JSON.stringify(sortKeys(spec.cronSchedule))) {
        // Convex's heuristic against conflicting with a running cron: move the next run only when the old
        // schedule's runs are more than 30 s apart.
        const next = computeNextTs(job.cronSpec.cronSchedule, null, now, o);
        const nextNext = computeNextTs(job.cronSpec.cronSchedule, next, next, o);
        if (nextNext - now > 30_000) {
          const run = await nextRunOf(db, job._id);
          if (!run) throw new Error("No next run found");
          await sys(db, () =>
            db.patch(CRON_NEXT_RUN_TABLE, run._id, { nextTs: computeNextTs(spec.cronSchedule, null, now, o) }),
          );
        }
      }
      await sys(db, () => db.replace(CRON_JOBS_TABLE, job._id, { name, cronSpec: spec }));
      diff.updated.push(name);
    }
  }
  for (const [name, job] of old) {
    if (specs.has(name)) continue;
    // The job, its next run and all its logs.
    await sys(db, () => db.delete(CRON_JOBS_TABLE, job._id));
    const run = await nextRunOf(db, job._id);
    if (run) await sys(db, () => db.delete(CRON_NEXT_RUN_TABLE, run._id));
    await trimLogs(db, name, 0);
    diff.deleted.push(name);
  }
  return diff;
}

async function toJob(db: Tx, run: CronNextRunDoc): Promise<CronJob | null> {
  const job = (await sys(db, () => db.get(CRON_JOBS_TABLE, run.cronJobId))) as unknown as CronJobDoc | null;
  if (!job) return null;
  return {
    id: job._id,
    name: job.name,
    cronSpec: job.cronSpec,
    runId: run._id,
    state: run.state,
    prevTs: run.prevTs,
    nextTs: run.nextTs,
  };
}

/** The cron as it is now (the executor re-reads it before each attempt), or null if gone. */
export async function currentJob(db: Tx, cronJobId: string): Promise<CronJob | null> {
  const run = await nextRunOf(db, cronJobId);
  return run && toJob(db, run);
}

export async function dueCrons(db: Tx, now: number, limit: number): Promise<CronJob[]> {
  const runs = (await sys(db, () =>
    db
      .query(CRON_NEXT_RUN_TABLE)
      .withIndex("by_next_ts", (q) => q.lte("nextTs", now))
      .take(limit),
  )) as unknown as CronNextRunDoc[];
  return (await Promise.all(runs.map((r) => toJob(db, r)))).filter((j): j is CronJob => j !== null);
}

export async function nextCronTs(db: Tx, now: number): Promise<number | null> {
  const [r] = (await sys(db, () =>
    db
      .query(CRON_NEXT_RUN_TABLE)
      .withIndex("by_next_ts", (q) => q.gt("nextTs", now))
      .take(1),
  )) as unknown as CronNextRunDoc[];
  return r?.nextTs ?? null;
}

export async function setCronState(db: Tx, job: CronJob, state: CronState) {
  await sys(db, () => db.patch(CRON_NEXT_RUN_TABLE, job.runId, { state }));
}

/** Keep the newest `keep` logs of cron `name`. */
async function trimLogs(db: Tx, name: string, keep: number) {
  const logs = await sys(db, () =>
    db
      .query(CRON_JOB_LOGS_TABLE)
      .withIndex("by_name_and_ts", (q) => q.eq("name", name))
      .order("desc")
      .collect(),
  );
  for (const l of logs.slice(keep)) await sys(db, () => db.delete(CRON_JOB_LOGS_TABLE, l._id));
}

export async function insertLog(
  db: Tx,
  job: CronJob,
  ts: number,
  status: CronStatus,
  logLines: { logLines: string[]; isTruncated: boolean },
  executionTime: number,
) {
  await trimLogs(db, job.name, MAX_LOGS_PER_CRON - 1);
  await sys(db, () =>
    db.insert(CRON_JOB_LOGS_TABLE, {
      name: job.name,
      ts,
      udfPath: job.cronSpec.udfPath,
      udfArgs: job.cronSpec.udfArgs,
      status,
      logLines,
      executionTime,
    }),
  );
}

/**
 * Convex's `complete_job_run`: the next run after this one; occurrences already in the past are skipped
 * (not replayed), and an interval's skips are logged as one `canceled` run.
 */
export async function completeRun(db: Tx, job: CronJob, now: number, o: NextOpts = {}) {
  const prevTs = job.nextTs;
  let nextTs = computeNextTs(job.cronSpec.cronSchedule, prevTs, now, o);
  const firstSkipped = nextTs;
  let skipped = 0;
  while (nextTs < now) {
    skipped++;
    nextTs = computeNextTs(job.cronSpec.cronSchedule, nextTs, now, o);
  }
  if (skipped > 0) {
    console.error(`Skipping ${skipped} run(s) of job ${job.id} because multiple scheduled runs are in the past`);
    await insertLog(
      db,
      job,
      firstSkipped,
      { type: "canceled", num_canceled: skipped },
      { logLines: [], isTruncated: false },
      0,
    );
  }
  await sys(db, () => db.patch(CRON_NEXT_RUN_TABLE, job.runId, { state: { type: "pending" }, prevTs, nextTs }));
}

/** Convex's truncation of a run's log lines: up to 1000 characters in all. */
export function truncateLogLines(lines: string[]) {
  const out: string[] = [];
  let size = 0;
  for (const l of lines) {
    if (size + l.length > CRON_LOG_MAX_LOG_LINE_LENGTH) return { logLines: out, isTruncated: true };
    out.push(l);
    size += l.length;
  }
  return { logLines: out, isTruncated: false };
}

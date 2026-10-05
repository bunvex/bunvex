// Scheduled functions (STUDY-30), after Convex's SchedulerModel (crates/model/src/scheduled_jobs):
//
// - A job is a document of the system table `_scheduled_functions`, written in the scheduling transaction,
//   so a job scheduled by a mutation exists exactly when that mutation commits.
// - Apps read it through `db.system`, projected to Convex's public shape
//   `{_id, _creationTime, name, args, scheduledTime, completedTime?, state}`. Convex keeps a virtual table over
//   `_scheduled_jobs`; bunvex stores the public fields plus internal ones and hides those (S2).
// - `nextTs` exists while the job is pending or in progress (the executor's `by_next_ts` index);
//   `completedTime` once it is done (`by_completed_ts`, for garbage collection).
import { rawValueSize, type Value } from "@bunvex/values";
import { SCHEDULED_FUNCTIONS_TABLE } from "./catalog.ts";
import type { Tx } from "./tx.ts";

export const SCHEDULED_BY_NEXT_TS = "by_next_ts";
export const SCHEDULED_BY_NAME_AND_NEXT_TS = "by_udf_path_and_next_event_ts";
export const SCHEDULED_BY_COMPLETED_TS = "by_completed_ts";
export const SCHEDULED_FUNCTIONS_INDEXES = {
  [SCHEDULED_BY_NEXT_TS]: ["nextTs"],
  [SCHEDULED_BY_NAME_AND_NEXT_TS]: ["name", "nextTs"],
  [SCHEDULED_BY_COMPLETED_TS]: ["completedTime"],
};

export { TRANSACTION_MAX_NUM_SCHEDULED, TRANSACTION_MAX_SCHEDULED_TOTAL_ARGUMENT_SIZE_BYTES } from "./tx.ts";

export type JobState =
  | { kind: "pending" }
  | { kind: "inProgress"; requestId: string; executionId: string }
  | { kind: "success" }
  | { kind: "failed"; error: string }
  | { kind: "canceled" };

/** A job as stored. */
export type JobDoc = {
  _id: string;
  _creationTime: number;
  /** The canonical path, `module.js:function`, as Convex's `name`. */
  name: string;
  args: Value[];
  /** When it was asked to run (ms), never changed. */
  scheduledTime: number;
  completedTime?: number;
  state: JobState;
  /** When it should run next (ms): `max(scheduledTime, now)`, later after a system error. Unset when done. */
  nextTs?: number;
  /** System errors so far (Convex's `attempts.systemErrors`), for the retry backoff. */
  systemErrors?: number;
};

/** What apps see (Convex's `_scheduled_functions` document). */
export type PublicJob = Pick<
  JobDoc,
  "_id" | "_creationTime" | "name" | "args" | "scheduledTime" | "completedTime" | "state"
>;

export function publicJob(d: JobDoc): PublicJob {
  const { _id, _creationTime, name, args, scheduledTime, completedTime, state } = d;
  return completedTime === undefined
    ? { _id, _creationTime, name, args, scheduledTime, state }
    : { _id, _creationTime, name, args, scheduledTime, completedTime, state };
}

/**
 * Insert a job, counting toward the transaction's limits. `canceled`: the job is born canceled (scheduled by
 * a running action whose own job was canceled, as Convex does).
 */
export async function insertJob(
  db: Tx,
  job: { name: string; args: Value[]; scheduledTime: number; now: number; canceled?: boolean },
): Promise<string> {
  // Convex's `check_scheduling_limits`, against the transaction's limits (a nested call's are lowered).
  const size = rawValueSize(job.args as Value);
  if (db.scheduledCount >= db.limits.functionsScheduled)
    throw new Error(`Too many functions scheduled by this mutation (limit: ${db.limits.functionsScheduled})`);
  if (db.scheduledBytes + size > db.limits.scheduledFunctionArgsBytes)
    throw new Error(
      `Too large total size of the arguments of scheduled functions from this mutation (limit: ${db.limits.scheduledFunctionArgsBytes} bytes)`,
    );
  db.scheduledCount++;
  db.scheduledBytes += size;
  db.scheduledMaxBytes = Math.max(db.scheduledMaxBytes, size);
  const doc: Omit<JobDoc, "_id" | "_creationTime"> = job.canceled
    ? {
        name: job.name,
        args: job.args,
        scheduledTime: job.scheduledTime,
        completedTime: job.now,
        state: { kind: "canceled" },
      }
    : {
        name: job.name,
        args: job.args,
        scheduledTime: job.scheduledTime,
        state: { kind: "pending" },
        nextTs: Math.max(job.scheduledTime, job.now),
      };
  return db.asSystem(() => db.insert(SCHEDULED_FUNCTIONS_TABLE, doc));
}

export async function getJob(db: Tx, id: string): Promise<JobDoc | null> {
  return (await db.asSystem(() => db.get(SCHEDULED_FUNCTIONS_TABLE, id))) as JobDoc | null;
}

/** Whether `id` is an id of `_scheduled_functions` (Convex refuses any other table's ids in `cancel`). */
export function isJobId(db: Tx, id: string): boolean {
  return db.asSystemSync(() => db.normalizeId(SCHEDULED_FUNCTIONS_TABLE, id)) !== null;
}

/** Finish a job (no-op when it is already done, as Convex's `complete`). */
export async function completeJob(db: Tx, id: string, state: JobState, now: number) {
  const job = await getJob(db, id);
  if (!job || job.completedTime !== undefined) return;
  await db.asSystem(() => db.patch(SCHEDULED_FUNCTIONS_TABLE, id, { state, completedTime: now, nextTs: undefined }));
}

/** Convex's `SchedulerModel::cancel`: pending or in progress → canceled; anything else is a no-op. */
export async function cancelJob(db: Tx, id: string, now: number) {
  const job = await getJob(db, id);
  if (!job || (job.state.kind !== "pending" && job.state.kind !== "inProgress")) return;
  await completeJob(db, id, { kind: "canceled" }, now);
}

export async function patchJob(db: Tx, id: string, fields: Partial<Omit<JobDoc, "_id" | "_creationTime">>) {
  await db.asSystem(() => db.patch(SCHEDULED_FUNCTIONS_TABLE, id, fields as Record<string, unknown>));
}

/** The first `limit` jobs due at `now` (pending or in progress), by `nextTs`. */
export async function dueJobs(db: Tx, now: number, limit: number): Promise<JobDoc[]> {
  return (await db.asSystem(() =>
    db
      .query(SCHEDULED_FUNCTIONS_TABLE)
      .withIndex(SCHEDULED_BY_NEXT_TS, (q) => q.gt("nextTs", null).lte("nextTs", now))
      .take(limit),
  )) as unknown as JobDoc[];
}

/** The earliest `nextTs` after `now`, if any (when to wake up next). */
export async function nextJobTs(db: Tx, now: number): Promise<number | null> {
  const [next] = (await db.asSystem(() =>
    db
      .query(SCHEDULED_FUNCTIONS_TABLE)
      .withIndex(SCHEDULED_BY_NEXT_TS, (q) => q.gt("nextTs", now))
      .take(1),
  )) as unknown as JobDoc[];
  return next?.nextTs ?? null;
}

/** Delete up to `limit` jobs completed before `before`; the number deleted. */
export async function deleteCompletedJobs(db: Tx, before: number, limit: number): Promise<number> {
  const old = (await db.asSystem(() =>
    db
      .query(SCHEDULED_FUNCTIONS_TABLE)
      .withIndex(SCHEDULED_BY_COMPLETED_TS, (q) => q.gt("completedTime", null).lt("completedTime", before))
      .take(limit),
  )) as unknown as JobDoc[];
  await db.asSystem(async () => {
    for (const d of old) await db.delete(SCHEDULED_FUNCTIONS_TABLE, d._id);
  });
  return old.length;
}

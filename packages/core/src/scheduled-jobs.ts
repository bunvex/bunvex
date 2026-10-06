// Scheduled functions (STUDY-30, STUDY-125), after Convex's SchedulerModel (crates/model/src/scheduled_jobs):
//
// - A job is a document of the system table `_scheduled_jobs`, its arguments one of `_scheduled_job_args`
//   (`{args}`: the bytes of the arguments array's JSON), both written in the scheduling transaction, so a job
//   scheduled by a mutation exists exactly when that mutation commits. The job points to its arguments by
//   `argsId`; deleting a job (garbage collection) deletes them too.
// - The documents are Convex's: `{component, udfPath, udfArgs, argsId, state: {type, …}, nextTs, completedTs,
//   originalScheduledTs, attempts: {systemErrors, occErrors}}`, times in ns as int64, absent ones null.
// - `nextTs` is set while the job is pending or in progress (the executor's `by_next_ts` index);
//   `completedTs` once it is done (`by_completed_ts`, for garbage collection).
// - Apps read jobs through the virtual table `_scheduled_functions` (virtual-tables.ts): `virtualJob` builds
//   Convex's public document `{_id, _creationTime, name, args, scheduledTime, completedTime?, state: {kind, …}}`,
//   joining the arguments in.
import { fromJsonValue, type JSONValue, rawValueSize, toJsonValue, type Value } from "@bunvex/values";
import { SCHEDULED_JOB_ARGS_TABLE, SCHEDULED_JOBS_TABLE } from "./catalog.ts";
import type { Doc } from "./schema.ts";
import type { Tx } from "./tx.ts";

export const SCHEDULED_BY_NEXT_TS = "by_next_ts";
export const SCHEDULED_BY_NAME_AND_NEXT_TS = "by_udf_path_and_next_event_ts";
export const SCHEDULED_BY_COMPLETED_TS = "by_completed_ts";
/** Convex's `ScheduledJobsTable::indexes()`. */
export const SCHEDULED_JOBS_INDEXES = {
  [SCHEDULED_BY_COMPLETED_TS]: ["completedTs"],
  [SCHEDULED_BY_NEXT_TS]: ["nextTs"],
  [SCHEDULED_BY_NAME_AND_NEXT_TS]: ["udfPath", "nextTs"],
};

export { TRANSACTION_MAX_NUM_SCHEDULED, TRANSACTION_MAX_SCHEDULED_TOTAL_ARGUMENT_SIZE_BYTES } from "./tx.ts";

/** A job's state as apps see it (`_scheduled_functions`' `state`, Convex's `type` renamed `kind`). */
export type JobState =
  | { kind: "pending" }
  | { kind: "inProgress"; requestId: string; executionId: string }
  | { kind: "success" }
  | { kind: "failed"; error: string }
  | { kind: "canceled" };

/** A job's state as `_scheduled_jobs` stores it (Convex's `SerializedScheduledJobState`). */
export type StoredJobState =
  | { type: "pending" }
  | { executionId: string; requestId: string; type: "inProgress" }
  | { type: "success" }
  | { error: string; type: "failed" }
  | { type: "canceled" };

/** A `_scheduled_jobs` document (Convex's `SerializedScheduledJob`). */
export type ScheduledJobDoc = {
  _id: string;
  _creationTime: number;
  /** The component that scheduled it: "" for the root (bunvex has no components). */
  component: string;
  /** The canonical path, `module.js:function`. */
  udfPath: string;
  /** Arguments kept inline: no longer written (Convex keeps reading them for old jobs). */
  udfArgs: ArrayBuffer | null;
  /** The `_scheduled_job_args` document that holds the arguments. */
  argsId: string | null;
  state: StoredJobState;
  /** When it should run next (ns): `max(original, now)`, later after a system error. Null when done. */
  nextTs: bigint | null;
  completedTs: bigint | null;
  /** When it was asked to run (ns), never changed. */
  originalScheduledTs: bigint;
  attempts: { systemErrors: bigint; occErrors: bigint };
};

/** A job read for the engine: the stored document, its times in ms and its state as apps name it. */
export type JobDoc = {
  _id: string;
  _creationTime: number;
  name: string;
  argsId: string | null;
  udfArgs: ArrayBuffer | null;
  /** When it was asked to run (ms). */
  scheduledTime: number;
  completedTime?: number;
  state: JobState;
  /** When it should run next (ms), while pending or in progress. */
  nextTs?: number;
  /** System errors so far (Convex's `attempts.systemErrors`), for the retry backoff. */
  systemErrors: number;
};

/** What apps see (Convex's `_scheduled_functions` document). */
export type PublicJob = {
  _id: string;
  _creationTime: number;
  name: string;
  args: Value[];
  scheduledTime: number;
  completedTime?: number;
  state: JobState;
};

/** Milliseconds (a float, as `Date.now()` or a requested time) as a Convex timestamp in ns. */
export function msToNs(ms: number): bigint {
  const whole = Math.floor(ms);
  return BigInt(whole) * 1_000_000n + BigInt(Math.round((ms - whole) * 1e6));
}

/** Convex's `timestamp_to_ms`: whole milliseconds, plus the rest as a fraction. */
export function nsToMs(ns: bigint): number {
  return Number(ns / 1_000_000n) + Number(ns % 1_000_000n) * 1e-6;
}

const toStored = (s: JobState): StoredJobState =>
  s.kind === "inProgress"
    ? { executionId: s.executionId, requestId: s.requestId, type: "inProgress" }
    : s.kind === "failed"
      ? { error: s.error, type: "failed" }
      : { type: s.kind };

/** Convex's virtual state: `type` renamed `kind`, the other fields kept (keys in Convex's order). */
const fromStored = (s: StoredJobState): JobState =>
  s.type === "inProgress"
    ? ({ executionId: s.executionId, kind: "inProgress", requestId: s.requestId } as JobState)
    : s.type === "failed"
      ? ({ error: s.error, kind: "failed" } as JobState)
      : { kind: s.type };

export function parseJob(d: ScheduledJobDoc): JobDoc {
  const job: JobDoc = {
    _id: d._id,
    _creationTime: d._creationTime,
    name: d.udfPath,
    argsId: d.argsId,
    udfArgs: d.udfArgs,
    scheduledTime: nsToMs(d.originalScheduledTs),
    state: fromStored(d.state),
    systemErrors: Number(d.attempts.systemErrors),
  };
  if (d.completedTs !== null) job.completedTime = nsToMs(d.completedTs);
  if (d.nextTs !== null) job.nextTs = nsToMs(d.nextTs);
  return job;
}

/** Convex's `args_to_bytes`: the arguments array's JSON, as bytes. */
export const argsToBytes = (args: Value[]): ArrayBuffer =>
  new TextEncoder().encode(JSON.stringify(toJsonValue(args as Value))).buffer as ArrayBuffer;
/** Convex's `args_from_bytes`. */
export const argsFromBytes = (bytes: ArrayBuffer): Value[] =>
  fromJsonValue(JSON.parse(new TextDecoder().decode(bytes)) as JSONValue) as Value[];

/**
 * Insert a job, counting toward the transaction's limits: its arguments first, then the job pointing to them
 * (Convex's `SchedulerModel::schedule`). `canceled`: the job is born canceled (scheduled by a running action
 * whose own job was canceled), completed and scheduled at `now`, as Convex's.
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
  return db.asSystem(async () => {
    const argsId = await db.insert(SCHEDULED_JOB_ARGS_TABLE, { args: argsToBytes(job.args) });
    const now = msToNs(job.now);
    const scheduled = msToNs(job.scheduledTime);
    const doc: Omit<ScheduledJobDoc, "_id" | "_creationTime"> = {
      component: "",
      udfPath: job.name,
      udfArgs: null,
      argsId,
      state: { type: job.canceled ? "canceled" : "pending" },
      // Never in the past, so the executor does not count it late; the original time stays as asked.
      nextTs: job.canceled ? null : scheduled > now ? scheduled : now,
      completedTs: job.canceled ? now : null,
      originalScheduledTs: job.canceled ? now : scheduled,
      attempts: { systemErrors: 0n, occErrors: 0n },
    };
    return db.insert(SCHEDULED_JOBS_TABLE, doc as unknown as Record<string, Value>);
  });
}

async function getStored(db: Tx, id: string): Promise<ScheduledJobDoc | null> {
  return (await db.asSystem(() => db.get(SCHEDULED_JOBS_TABLE, id))) as unknown as ScheduledJobDoc | null;
}

export async function getJob(db: Tx, id: string): Promise<JobDoc | null> {
  const d = await getStored(db, id);
  return d && parseJob(d);
}

/**
 * A job's arguments (Convex's `scheduled_job_from_metadata`): its `_scheduled_job_args` document, read in `db`,
 * or the inline bytes of a job that has none.
 */
export async function jobArgs(db: Tx, job: Pick<JobDoc, "_id" | "argsId" | "udfArgs">): Promise<Value[]> {
  if (job.argsId !== null) {
    const id = job.argsId;
    const d = (await db.asSystem(() => db.get(SCHEDULED_JOB_ARGS_TABLE, id))) as { args: ArrayBuffer } | null;
    if (!d) throw new Error(`Missing scheduled job args document for id ${id}`);
    return argsFromBytes(d.args);
  }
  if (job.udfArgs === null) throw new Error(`Missing udf_args_bytes in scheduled job metadata with id ${job._id}`);
  return argsFromBytes(job.udfArgs);
}

/** A `_scheduled_jobs` document as the virtual `_scheduled_functions` gives it (Convex's `ScheduledJobsDocMapper`). */
export async function virtualJob(db: Tx, d: Doc): Promise<Doc> {
  const job = parseJob(d as unknown as ScheduledJobDoc);
  const args = await jobArgs(db, job);
  // Keys in Convex's order (its documents are sorted maps).
  const out: Record<string, unknown> = { _creationTime: job._creationTime, _id: job._id, args };
  if (job.completedTime !== undefined) out.completedTime = job.completedTime;
  out.name = job.name;
  out.scheduledTime = job.scheduledTime;
  out.state = job.state;
  return out as Doc;
}

/** Whether `id` is an id of `_scheduled_functions` (Convex refuses any other table's ids in `cancel`). */
export function isJobId(db: Tx, id: string): boolean {
  return db.asSystemSync(() => db.normalizeId(SCHEDULED_JOBS_TABLE, id)) !== null;
}

/** Finish a job (no-op when it is already done, as Convex's `complete`): `nextTs` cleared, `completedTs` set. */
export async function completeJob(db: Tx, id: string, state: JobState, now: number) {
  const job = await getStored(db, id);
  if (!job || job.completedTs !== null) return;
  await db.asSystem(() =>
    db.patch(SCHEDULED_JOBS_TABLE, id, { state: toStored(state), nextTs: null, completedTs: msToNs(now) } as Record<
      string,
      Value
    >),
  );
}

/** Convex's `SchedulerModel::cancel`: pending or in progress → canceled; anything else is a no-op. */
export async function cancelJob(db: Tx, id: string, now: number) {
  const job = await getStored(db, id);
  if (!job || (job.state.type !== "pending" && job.state.type !== "inProgress")) return;
  await completeJob(db, id, { kind: "canceled" }, now);
}

/** Change a running job: its state, its next time (ms) or its count of system errors. */
export async function patchJob(
  db: Tx,
  id: string,
  fields: { state?: JobState; nextTs?: number; systemErrors?: number },
) {
  const patch: Record<string, Value> = {};
  if (fields.state !== undefined) patch.state = toStored(fields.state) as unknown as Value;
  if (fields.nextTs !== undefined) patch.nextTs = msToNs(fields.nextTs);
  // bunvex never counts OCC retries, as Convex no longer does (`occErrors` is deprecated there).
  if (fields.systemErrors !== undefined)
    patch.attempts = { systemErrors: BigInt(fields.systemErrors), occErrors: 0n } as unknown as Value;
  await db.asSystem(() => db.patch(SCHEDULED_JOBS_TABLE, id, patch));
}

/** The first `limit` jobs due at `now` (pending or in progress), by `nextTs`. */
export async function dueJobs(db: Tx, now: number, limit: number): Promise<JobDoc[]> {
  const docs = (await db.asSystem(() =>
    db
      .query(SCHEDULED_JOBS_TABLE)
      .withIndex(SCHEDULED_BY_NEXT_TS, (q) => q.gt("nextTs", null).lte("nextTs", msToNs(now)))
      .take(limit),
  )) as unknown as ScheduledJobDoc[];
  return docs.map(parseJob);
}

/** The earliest `nextTs` after `now` (ms), if any (when to wake up next). */
export async function nextJobTs(db: Tx, now: number): Promise<number | null> {
  const [next] = (await db.asSystem(() =>
    db
      .query(SCHEDULED_JOBS_TABLE)
      .withIndex(SCHEDULED_BY_NEXT_TS, (q) => q.gt("nextTs", msToNs(now)))
      .take(1),
  )) as unknown as ScheduledJobDoc[];
  return next?.nextTs != null ? nsToMs(next.nextTs) : null;
}

/** Delete a job and its arguments (Convex's `SchedulerModel::delete`). */
export async function deleteJob(db: Tx, job: Pick<ScheduledJobDoc, "_id" | "argsId">) {
  await db.asSystem(async () => {
    await db.delete(SCHEDULED_JOBS_TABLE, job._id);
    if (job.argsId !== null) await db.delete(SCHEDULED_JOB_ARGS_TABLE, job.argsId);
  });
}

/** Delete up to `limit` jobs completed before `before` (ms), with their arguments; the number deleted. */
export async function deleteCompletedJobs(db: Tx, before: number, limit: number): Promise<number> {
  const old = (await db.asSystem(() =>
    db
      .query(SCHEDULED_JOBS_TABLE)
      .withIndex(SCHEDULED_BY_COMPLETED_TS, (q) => q.gt("completedTs", null).lt("completedTs", msToNs(before)))
      .take(limit),
  )) as unknown as ScheduledJobDoc[];
  for (const d of old) await deleteJob(db, d);
  return old.length;
}

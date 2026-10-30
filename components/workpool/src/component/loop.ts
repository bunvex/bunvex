// The pool's loop (STUDY-199 §1.9), as Convex's workpool 0.4.14 runs it on the batch worker: `getBatch` is the work
// query, which reads the three queues (completions, cancelations, starts due) from cursors and hands `run` a batch,
// or tells the batch worker how long to stay warm and when to look again; `run` is the worker mutation, which, in
// one transaction, retires completions (rescheduling retries), applies cancelations, schedules recovery of jobs
// running too long, starts jobs up to `maxParallelism`, writes the minute's report and moves the cursors.
//
// The deprecated forwarders `loop:main` and `loop:updateRunStatus` are not built (DV-539). `getBatch` declares the
// batch worker's `vQueryReturns`, whose work branch has an optional `cursor`, where Convex's declares `vBatchResult`
// (STUDY-199 W-2).
import { type BatchResult, defineBatchWorkerValidators } from "@bunvex/batch-worker";
import type { WithoutSystemFields } from "@bunvex/server";
import { type Infer, v } from "@bunvex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { CompleteJob } from "./complete";
import { createLogger, DEFAULT_LOG_LEVEL, type Logger, type LogLevel } from "./logging";
import {
  type Config,
  DEFAULT_MAX_PARALLELISM,
  fromSegment,
  getCurrentSegment,
  MINUTE,
  type RunResult,
  SECOND,
  toSegment,
  vResult,
} from "./shared";
import { generateReport, recordCompleted, recordStarted } from "./stats";

/** Cancelations read per iteration: the one queue with no bound of its own. */
const CANCELLATION_BATCH_SIZE = 64;
/** Jobs per scheduled `recover`. */
const RECOVERY_BATCH_SIZE = 32;
/** Actions and queries per scheduled `runBatch`. */
const START_BATCH_SIZE = 32;
/** The most completions, and the most starts, in one iteration: the loop runs again at once while it drains. */
const MAIN_BATCH_SIZE = 64;
/** A job running longer than this is checked against the scheduler. */
const RECOVERY_THRESHOLD_MS = 5 * MINUTE;
/** How often a recovery iteration happens, while something runs. */
export const RECOVERY_PERIOD_SEGMENTS = toSegment(1 * MINUTE);
/** How long the loop stays warm after its last work, polling, before it idles. */
export const STATUS_COOLDOWN = 2 * SECOND;
/** The same when the pool is full: longer, so that most enqueues find the loop running and their ping is a no-op. */
export const SATURATED_STATUS_COOLDOWN = 10 * SECOND;
/** How often the warm loop polls. */
export const COOLDOWN_CHECK_INTERVAL = 200;
/**
 * Scans start this far behind each cursor, for rows committed late behind it. A later straggler is found by the
 * recovery iteration, which scans from the start.
 */
const CURSOR_BUFFER_SEGMENTS = toSegment(15 * SECOND);

export const INITIAL_STATE: WithoutSystemFields<Doc<"internalState">> = {
  generation: 0n,
  segmentCursors: { incoming: 0n, completion: 0n, cancelation: 0n },
  lastRecovery: 0n,
  report: { completed: 0, succeeded: 0, failed: 0, retries: 0, canceled: 0, lastReportTs: 0 },
  running: [],
};

const vCompletion = v.object({
  _id: v.id("pendingCompletion"),
  workId: v.id("work"),
  runResult: vResult,
  retry: v.boolean(),
  segment: v.int64(),
});
type Completion = Infer<typeof vCompletion>;

const vCancelation = v.object({
  _id: v.id("pendingCancelation"),
  workId: v.id("work"),
  segment: v.int64(),
});
type Cancelation = Infer<typeof vCancelation>;

const vStart = v.object({
  _id: v.id("pendingStart"),
  workId: v.id("work"),
  segment: v.int64(),
});
type Start = Infer<typeof vStart>;

/** What `getBatch` hands `run`. */
const batchFields = {
  // "Now" when the batch was read.
  segment: v.int64(),
  // Whether this iteration checks the long-running jobs.
  recovery: v.boolean(),
  completions: v.array(vCompletion),
  cancelations: v.array(vCancelation),
  starts: v.array(vStart),
};
type Batch = Infer<ReturnType<typeof v.object<typeof batchFields>>>;

const { vQueryReturns } = defineBatchWorkerValidators({ batch: v.object(batchFields) });

export const getBatch = internalQuery({
  args: { name: v.string() },
  returns: vQueryReturns,
  handler: async (ctx): Promise<BatchResult<Batch>> => {
    const globals = await getGlobals(ctx);
    const state = await ctx.db.query("internalState").unique();
    const running = state?.running ?? INITIAL_STATE.running;
    const cursors = state?.segmentCursors ?? INITIAL_STATE.segmentCursors;
    const lastRecovery = state?.lastRecovery ?? INITIAL_STATE.lastRecovery;
    const segment = getCurrentSegment();

    // About once a minute while something runs, scan every queue from the start, and check the running jobs.
    const recovery = running.length > 0 && segment - lastRecovery >= RECOVERY_PERIOD_SEGMENTS;
    const from = (cursor: bigint) => (recovery ? 0n : cursor - CURSOR_BUFFER_SEGMENTS);
    const { allStarts, cancelations, completions } = await queryPending(ctx, {
      completionCursor: from(cursors.completion),
      cancelationCursor: from(cursors.cancelation),
      incomingCursor: from(cursors.incoming),
      maxParallelism: globals.maxParallelism,
      runningCount: running.length,
    });
    const starts = allStarts.filter((s) => s.segment <= segment);

    if (completions.length > 0 || cancelations.length > 0 || starts.length > 0 || recovery) {
      return {
        kind: "work",
        batch: {
          segment,
          recovery,
          completions: completions.map(({ _id, workId, runResult, retry, segment }) => ({
            _id,
            workId,
            runResult,
            retry,
            segment,
          })),
          cancelations: cancelations.map(({ _id, workId, segment }) => ({ _id, workId, segment })),
          starts: starts.map(({ _id, workId, segment }) => ({ _id, workId, segment })),
        },
      };
    }

    // Nothing now. Look again at the next future start, or the next recovery iteration while something runs,
    // whichever is sooner; a ping wakes the loop before that.
    const waits: number[] = [];
    const futureStart = allStarts.find((s) => s.segment > segment);
    if (futureStart) waits.push(fromSegment(futureStart.segment) - Date.now());
    if (running.length > 0) waits.push(fromSegment(lastRecovery + RECOVERY_PERIOD_SEGMENTS) - Date.now());
    return {
      kind: "idle",
      cooldownMs: running.length >= globals.maxParallelism ? SATURATED_STATUS_COOLDOWN : STATUS_COOLDOWN,
      pollIntervalMs: COOLDOWN_CHECK_INTERVAL,
      ...(waits.length > 0 ? { timeoutMs: Math.max(0, Math.min(...waits)) } : {}),
    };
  },
});

export const run = internalMutation({
  args: batchFields,
  returns: v.null(),
  handler: async (ctx, batch) => {
    const state = await getOrCreateState(ctx);
    const globals = await getGlobals(ctx);
    const console = createLogger(globals.logLevel);
    const segment = getCurrentSegment();

    const completionLabel = `[main] pendingCompletion(${batch.completions.length})`;
    console.time(completionLabel);
    const toCancel = await handleCompletions(ctx, state, batch.completions, console);
    console.timeEnd(completionLabel);

    const cancelationLabel = `[main] pendingCancelation(${batch.cancelations.length})`;
    console.time(cancelationLabel);
    await handleCancelation(ctx, state, batch.cancelations, console, toCancel);
    console.timeEnd(cancelationLabel);

    if (state.running.length === 0) {
      state.lastRecovery = segment;
    } else if (batch.recovery) {
      const recoveryLabel = `[main] recovery(${state.running.length})`;
      console.time(recoveryLabel);
      await handleRecovery(ctx, state, console);
      console.timeEnd(recoveryLabel);
      state.lastRecovery = segment;
    }

    // The completions above may have freed room; a pool already above its limit starts nothing.
    const capacity = globals.maxParallelism - state.running.length;
    const toStart = capacity > 0 ? batch.starts.slice(0, capacity) : [];
    const startLabel = `[main] pendingStart(${toStart.length})`;
    console.time(startLabel);
    await handleStart(ctx, state, toStart, console, globals);
    console.timeEnd(startLabel);

    if (Date.now() - state.report.lastReportTs >= MINUTE) {
      // A minute after the last report, against drift; or now, if that is long past.
      let lastReportTs = state.report.lastReportTs + MINUTE;
      if (Date.now() > lastReportTs + MINUTE / 2) lastReportTs = Date.now();
      const reportLabel = "[main] report";
      console.time(reportLabel);
      await generateReport(ctx, console, state, globals);
      console.timeEnd(reportLabel);
      state.report = { completed: 0, succeeded: 0, failed: 0, retries: 0, canceled: 0, lastReportTs };
    }

    // Move each cursor past what this iteration drained, so the next scan skips the deleted rows.
    const lastCompletion = batch.completions.at(-1);
    if (lastCompletion) state.segmentCursors.completion = lastCompletion.segment;
    const lastCancelation = batch.cancelations.at(-1);
    if (lastCancelation) state.segmentCursors.cancelation = lastCancelation.segment;
    const lastStart = toStart.at(-1);
    if (lastStart) state.segmentCursors.incoming = lastStart.segment;
    else if (capacity > 0 && batch.starts.length === 0) state.segmentCursors.incoming = segment;

    await ctx.db.replace("internalState", state._id, state);
    // Null: the batch worker runs again at once, and idles on `getBatch`'s hints once nothing is left.
    return null;
  },
});

/** The three queues, from their cursors: completions and starts within what the pool may take. */
async function queryPending(
  ctx: QueryCtx,
  args: {
    completionCursor: bigint;
    cancelationCursor: bigint;
    incomingCursor: bigint;
    maxParallelism: number;
    runningCount: number;
  },
) {
  const completions = await ctx.db
    .query("pendingCompletion")
    .withIndex("segment", (q) => q.gte("segment", args.completionCursor))
    .take(Math.min(args.maxParallelism, MAIN_BATCH_SIZE));
  const cancelations = await ctx.db
    .query("pendingCancelation")
    .withIndex("segment", (q) => q.gte("segment", args.cancelationCursor))
    .take(CANCELLATION_BATCH_SIZE);
  // The room left once these completions are retired, plus one row to tell a full page from a future start.
  const startLimit = Math.min(
    MAIN_BATCH_SIZE,
    Math.max(0, args.maxParallelism - args.runningCount + completions.length),
  );
  const excluded = [...completions.map((c) => c.workId), ...cancelations.map((c) => c.workId)];
  const allStarts =
    startLimit === 0
      ? []
      : await ctx.db
          .query("pendingStart")
          .withIndex("segment", (q) => q.gte("segment", args.incomingCursor))
          .filter((q) => q.and(...excluded.map((id) => q.neq(q.field("workId"), id))))
          .take(startLimit + 1);
  return { completions, cancelations, allStarts };
}

/** Retire the completed jobs from `running`, rescheduling retries. Returns the retries a cancelation stopped. */
async function handleCompletions(
  ctx: MutationCtx,
  state: Doc<"internalState">,
  completed: Completion[],
  console: Logger,
): Promise<CompleteJob[]> {
  const toCancel: CompleteJob[] = [];
  await Promise.all(
    completed.map(async (c) => {
      await ctx.db.delete("pendingCompletion", c._id);
      if (!state.running.some((r) => r.workId === c.workId)) {
        console.error(`[main] completing ${c.workId} but it's not in "running"`);
        return;
      }
      if (!c.retry) {
        if (c.runResult.kind === "success") state.report.succeeded++;
        else if (c.runResult.kind === "failed") state.report.failed++;
        return;
      }
      const work = await ctx.db.get("work", c.workId);
      if (!work) {
        console.warn(`[main] ${c.workId} is gone, but trying to complete`);
        return;
      }
      if (await rescheduleJob(ctx, work, console)) {
        state.report.retries++;
        recordCompleted(console, work, "retrying", undefined);
      } else {
        // Canceled since: it ends as canceled instead.
        state.report.canceled++;
        toCancel.push({ workId: c.workId, runResult: { kind: "canceled" }, attempt: work.attempts });
      }
    }),
  );
  // After the loop above, which needed to know what was running.
  const before = state.running.length;
  state.running = state.running.filter((r) => !completed.some((c) => c.workId === r.workId));
  const count = before - state.running.length;
  state.report.completed += count;
  console.debug(`[main] completed ${count} work`);
  return toCancel;
}

/**
 * Apply the cancelations: a job is marked so it is not retried, and, if it has not started, its start is removed and
 * it ends as canceled. A running job finishes its attempt. The canceled jobs, with `toCancel`, go to one `complete`.
 */
async function handleCancelation(
  ctx: MutationCtx,
  state: Doc<"internalState">,
  canceled: Cancelation[],
  console: Logger,
  toCancel: CompleteJob[],
): Promise<void> {
  if (canceled.length) console.debug(`[main] attempting to cancel ${canceled.length}`);
  const done = new Set<Id<"work">>();
  const runResult: RunResult = { kind: "canceled" };
  const jobs = await Promise.all(
    canceled.map(async ({ _id, workId }): Promise<CompleteJob | null> => {
      if (!(await ctx.db.get("pendingCancelation", _id))) return null;
      await ctx.db.delete("pendingCancelation", _id);
      if (done.has(workId)) {
        console.error(`[main] ${workId} already canceled`);
        return null;
      }
      const work = await ctx.db.get("work", workId);
      if (!work) {
        console.warn(`[main] ${workId} is gone, but trying to cancel`);
        return null;
      }
      await ctx.db.patch("work", workId, { canceled: true });
      const pendingStart = await ctx.db
        .query("pendingStart")
        .withIndex("workId", (q) => q.eq("workId", workId))
        .unique();
      if (pendingStart && !done.has(workId)) {
        state.report.canceled++;
        await ctx.db.delete("pendingStart", pendingStart._id);
        done.add(workId);
        return { workId, runResult, attempt: work.attempts };
      }
      return null;
    }),
  );
  const all = [...toCancel, ...jobs.filter((job) => job !== null)];
  if (all.length) await ctx.scheduler.runAfter(0, internal.complete.complete, { jobs: all });
}

/** Schedule `recover` for the jobs running longer than five minutes; drop from `running` those already gone. */
async function handleRecovery(ctx: MutationCtx, state: Doc<"internalState">, console: Logger): Promise<void> {
  const gone = new Set<Id<"work">>();
  const startedBefore = Date.now() - RECOVERY_THRESHOLD_MS;
  const checks = await Promise.all(
    state.running.map(async (r) => {
      if (r.started >= startedBefore) return null;
      const work = await ctx.db.get("work", r.workId);
      if (work) return { ...r, attempt: work.attempts };
      const pendingCompletion = await ctx.db
        .query("pendingCompletion")
        .withIndex("workId", (q) => q.eq("workId", r.workId))
        .first();
      if (pendingCompletion) {
        console.debug(`[main] ${r.workId} already gone but has pendingCompletion`);
      } else {
        gone.add(r.workId);
        console.error(`[main] ${r.workId} already gone (skipping recovery)`);
      }
      return null;
    }),
  );
  const jobs = checks.filter((job) => job !== null);
  state.running = state.running.filter((r) => !gone.has(r.workId));
  for (let i = 0; i < jobs.length; i += RECOVERY_BATCH_SIZE) {
    await ctx.scheduler.runAfter(0, internal.recovery.recover, { jobs: jobs.slice(i, i + RECOVERY_BATCH_SIZE) });
  }
}

/** Start the given jobs, adding them to `running`. */
async function handleStart(
  ctx: MutationCtx,
  state: Doc<"internalState">,
  pending: Start[],
  console: Logger,
  { logLevel }: Config,
): Promise<void> {
  console.debug(`[main] scheduling ${pending.length} pending work`);
  const starts = await Promise.all(
    pending.map(async ({ _id, workId, segment }) => {
      if (state.running.some((r) => r.workId === workId)) {
        // Its `pendingStart` stays: the loop reads it again until the job completes.
        console.error(`[main] ${workId} already running (skipping start)`);
        return null;
      }
      // A cancelation in this same iteration may have removed it.
      if (!(await ctx.db.get("pendingStart", _id))) return null;
      const work = await ctx.db.get("work", workId);
      await ctx.db.delete("pendingStart", _id);
      if (!work) {
        console.error(`Trying to start, but work not found: ${workId}`);
        return null;
      }
      return { work, lagMs: Date.now() - fromSegment(segment) };
    }),
  );
  state.running.push(
    ...(await beginWorkBatch(
      ctx,
      starts.filter((s) => s !== null),
      console,
      logLevel,
    )),
  );
}

type Running = Doc<"internalState">["running"][number];

/**
 * Schedule the jobs: actions and queries 32 to a `runBatch` (all of them recording that one scheduled id), each
 * mutation in its own `runMutationWrapper`.
 */
async function beginWorkBatch(
  ctx: MutationCtx,
  starts: { work: Doc<"work">; lagMs: number }[],
  console: Logger,
  logLevel: LogLevel,
): Promise<Running[]> {
  const running: Running[] = [];
  const actionsAndQueries = starts.filter(({ work }) => work.fnType === "action" || work.fnType === "query");
  for (let i = 0; i < actionsAndQueries.length; i += START_BATCH_SIZE) {
    const chunk = actionsAndQueries.slice(i, i + START_BATCH_SIZE);
    const scheduledId = await ctx.scheduler.runAfter(0, internal.worker.runBatch, {
      logLevel,
      items: chunk.map(({ work }) => ({
        workId: work._id,
        fnHandle: work.fnHandle,
        fnArgs: work.fnArgs,
        payloadId: work.payloadId,
        attempt: work.attempts,
        fnType: work.fnType as "action" | "query",
      })),
    });
    const started = Date.now();
    for (const { work, lagMs } of chunk) {
      recordStarted(console, work, lagMs, scheduledId);
      running.push({ workId: work._id, scheduledId, started });
    }
  }

  for (const { work, lagMs } of starts.filter(({ work }) => work.fnType === "mutation")) {
    const scheduledId = await ctx.scheduler.runAfter(0, internal.worker.runMutationWrapper, {
      workId: work._id,
      fnHandle: work.fnHandle,
      fnArgs: work.fnArgs,
      payloadId: work.payloadId,
      logLevel,
      attempt: work.attempts,
      fnType: "mutation",
    });
    recordStarted(console, work, lagMs, scheduledId);
    running.push({ workId: work._id, scheduledId, started: Date.now() });
  }

  const unexpected = starts.find(({ work }) => !["action", "query", "mutation"].includes(work.fnType));
  if (unexpected) throw new Error(`Unexpected fnType ${unexpected.work.fnType}`);
  return running;
}

/**
 * Queue a failed job's next attempt, after its backoff with jitter. Not when it is being canceled, was canceled, has
 * no retry behavior or is already queued. Whether it was queued.
 */
async function rescheduleJob(ctx: MutationCtx, work: Doc<"work">, console: Logger): Promise<boolean> {
  const pendingCancelation = await ctx.db
    .query("pendingCancelation")
    .withIndex("workId", (q) => q.eq("workId", work._id))
    .unique();
  if (pendingCancelation) {
    console.warn(`[main] ${work._id} in pendingCancelation so not retrying`);
    return false;
  }
  if (work.canceled) return false;
  if (!work.retryBehavior) {
    console.warn(`[main] ${work._id} has no retryBehavior so not retrying`);
    return false;
  }
  const existing = await ctx.db
    .query("pendingStart")
    .withIndex("workId", (q) => q.eq("workId", work._id))
    .first();
  if (existing) {
    console.error(`[main] ${work._id} already in pendingStart so not retrying`);
    return false;
  }
  // `attempts` already counts the one that failed.
  const backoffMs = work.retryBehavior.initialBackoffMs * work.retryBehavior.base ** (work.attempts - 1);
  await ctx.db.insert("pendingStart", { workId: work._id, segment: toSegment(Date.now() + withJitter(backoffMs)) });
  return true;
}

/** `delay` times a random factor in [0.5, 1.5). */
export function withJitter(delay: number): number {
  return delay * (0.5 + Math.random());
}

async function getGlobals(ctx: QueryCtx): Promise<Config> {
  return (
    (await ctx.db.query("globals").unique()) ?? { maxParallelism: DEFAULT_MAX_PARALLELISM, logLevel: DEFAULT_LOG_LEVEL }
  );
}

async function getOrCreateState(ctx: MutationCtx): Promise<Doc<"internalState">> {
  const state = await ctx.db.query("internalState").unique();
  if (state) return state;
  createLogger((await getGlobals(ctx)).logLevel).debug("Creating initial internalState for main loop");
  return (await ctx.db.get("internalState", await ctx.db.insert("internalState", INITIAL_STATE)))!;
}

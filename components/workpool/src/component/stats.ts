// The pool's events and diagnostics (STUDY-199 §1.13), as Convex's workpool 0.4.14 (at 7fde769) writes them: one
// JSON line per `enqueued`, `started` and `completed` job at `INFO` and below, and a `report` once a minute while the
// loop runs, for log pipelines to parse. The backlog in a report is the overdue starts when they fit in one page,
// else every `pendingStart` row, counted by a scheduled mutation.
import { v } from "@bunvex/values";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { createLogger, type Logger, logLevel, shouldLog } from "./logging";
import schema from "./schema";
import { type Config, DEFAULT_MAX_PARALLELISM, getCurrentSegment, WORKER_NAME } from "./shared";

// `count()` is on bunvex's query initializers, but not in their public type, as in Convex's (STUDY-107).
type Countable = { count(): Promise<number> };
const countRows = (query: unknown) => (query as Countable).count();

export function recordEnqueued(console: Logger, data: { workId: Id<"work">; fnName: string; runAt: number }): void {
  console.event("enqueued", { ...data, enqueuedAt: Date.now() });
}

export function recordStarted(
  console: Logger,
  work: Doc<"work">,
  lagMs: number,
  scheduledFunctionId: Id<"_scheduled_functions">,
): void {
  console.event("started", {
    workId: work._id,
    fnName: work.fnName,
    enqueuedAt: work._creationTime,
    scheduledFunctionId,
    startedAt: Date.now(),
    startLag: lagMs,
  });
}

export function recordCompleted(
  console: Logger,
  work: Doc<"work">,
  status: "success" | "failed" | "canceled" | "retrying",
  onCompleteScheduledFunctionId: Id<"_scheduled_functions"> | undefined,
): void {
  console.event("completed", {
    workId: work._id,
    fnName: work.fnName,
    completedAt: Date.now(),
    onCompleteScheduledFunctionId,
    attempts: work.attempts,
    status,
  });
}

/** Write the minute's report, from the loop: inline when the overdue starts fit in one page, else scheduled. */
export async function generateReport(
  ctx: MutationCtx,
  console: Logger,
  state: Doc<"internalState">,
  { maxParallelism, logLevel }: Config,
): Promise<void> {
  // Nothing is written above REPORT, so nothing is read.
  if (!shouldLog(logLevel, "REPORT")) return;
  const now = getCurrentSegment();
  const overdue = await ctx.db
    .query("pendingStart")
    .withIndex("segment", (q) => q.gte("segment", state.segmentCursors.incoming).lt("segment", now))
    .paginate({ numItems: Math.max(maxParallelism, 10), cursor: null });
  if (overdue.isDone) {
    recordReport(console, { ...state.report, running: state.running.length, backlog: overdue.page.length });
    return;
  }
  await ctx.scheduler.runAfter(0, internal.stats.calculateBacklogAndReport, {
    startSegment: 0n,
    endSegment: now,
    report: state.report,
    running: state.running.length,
    logLevel,
  });
}

export const calculateBacklogAndReport = internalMutation({
  args: {
    startSegment: v.int64(),
    endSegment: v.int64(),
    // Not read: kept so that calls scheduled by older versions still validate.
    cursor: v.optional(v.string()),
    report: schema.tables.internalState.validator.fields.report,
    running: v.number(),
    logLevel,
  },
  handler: async (ctx, args) => {
    const backlog = await countRows(ctx.db.query("pendingStart"));
    recordReport(createLogger(args.logLevel), { ...args.report, running: args.running, backlog });
  },
});

function recordReport(
  console: Logger,
  report: Doc<"internalState">["report"] & { running: number; backlog: number },
): void {
  const { completed, failed, retries } = report;
  const firstAttempts = completed - retries;
  const failureRate = completed ? (failed + retries) / completed : 0;
  const permanentFailureRate = firstAttempts ? failed / firstAttempts : 0;
  console.event("report", {
    ...report,
    failureRate: Number(failureRate.toFixed(4)),
    permanentFailureRate: Number(permanentFailureRate.toFixed(4)),
  });
}

/** The running jobs, with their function's name and attempts. Read it from a query: in a mutation it conflicts. */
export const running = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      workId: v.id("work"),
      scheduledId: v.id("_scheduled_functions"),
      fnName: v.string(),
      started: v.number(),
      attempts: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const state = await ctx.db.query("internalState").unique();
    if (!state) return [];
    return Promise.all(
      state.running.map(async ({ workId, scheduledId, started }) => {
        const work = await ctx.db.get("work", workId);
        return { workId, scheduledId, fnName: work?.fnName ?? "<unknown>", started, attempts: work?.attempts ?? 0 };
      }),
    );
  },
});

/** The queue's state at a glance, while developing. Read it from a query: in a mutation it conflicts. */
export const diagnostics = internalQuery({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const globals = await ctx.db.query("globals").unique();
    const state = await ctx.db.query("internalState").unique();
    const inProgress = state?.running.length ?? 0;
    const maxParallelism = globals?.maxParallelism ?? DEFAULT_MAX_PARALLELISM;
    const waiting = await countRows(ctx.db.query("pendingStart"));
    const completing = await countRows(ctx.db.query("pendingCompletion"));
    const canceling = await countRows(ctx.db.query("pendingCancelation"));
    const runStatus = await ctx.runQuery(components.batchWorker.lib.status, { name: WORKER_NAME });
    return {
      canceling,
      waiting,
      running: inProgress - completing,
      completing,
      spareCapacity: maxParallelism - inProgress,
      runStatus: runStatus?.kind,
    };
  },
});

/**
 * How many scheduled functions were created in `[startTime, endTimeExclusive)`, up to 1000 (`overflow` past that),
 * for benchmarks of the scheduler's load. The range must be finite, not empty, and at most a day.
 */
export const scheduledFunctionsInRange = internalQuery({
  args: { startTime: v.number(), endTimeExclusive: v.number() },
  returns: v.object({ count: v.number(), overflow: v.boolean() }),
  handler: async (ctx, { startTime, endTimeExclusive }) => {
    if (
      !Number.isFinite(startTime) ||
      !Number.isFinite(endTimeExclusive) ||
      endTimeExclusive <= startTime ||
      endTimeExclusive - startTime > 24 * 60 * 60 * 1000
    ) {
      throw new Error("Invalid scheduled-function time range");
    }
    const rows = await ctx.db.system
      .query("_scheduled_functions")
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", startTime).lt("_creationTime", endTimeExclusive))
      .take(1_001);
    return { count: Math.min(rows.length, 1_000), overflow: rows.length > 1_000 };
  },
});

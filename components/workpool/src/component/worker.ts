// Running the jobs (STUDY-199 §1.10), as Convex's workpool 0.4.14 does. `runBatch`, an action, runs up to 32 actions
// and queries at once, each completed inline (`complete` in its own transaction, called from the action, scheduled
// if that call fails). `runMutationWrapper` runs one mutation, nested, so a throw rolls back only the job's writes,
// and schedules its `complete`. Neither retries: the loop does.
//
// The legacy `worker:runActionWrapper` is not built (DV-539).
import { assert } from "@bunvex/helpers";
import type { FunctionHandle } from "@bunvex/server";
import { v } from "@bunvex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type ActionCtx, internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { CompleteJob } from "./complete";
import { getNonRetryableErrorMessage, isNonRetryableError } from "./errors";
import { createLogger, type Logger, logLevel } from "./logging";
import type { RunResult } from "./shared";

const actionOrQueryRunArgs = {
  workId: v.id("work"),
  fnHandle: v.string(),
  fnArgs: v.optional(v.record(v.string(), v.any())),
  payloadId: v.optional(v.id("payload")),
  attempt: v.number(),
  fnType: v.union(v.literal("action"), v.literal("query")),
};

export const runMutationWrapper = internalMutation({
  args: {
    workId: v.id("work"),
    fnHandle: v.string(),
    payloadId: v.optional(v.id("payload")),
    fnArgs: v.optional(v.record(v.string(), v.any())),
    fnType: v.union(v.literal("query"), v.literal("mutation")),
    logLevel,
    attempt: v.number(),
  },
  handler: async (ctx, { workId, attempt, ...args }) => {
    const console = createLogger(args.logLevel);
    let fnArgs = args.fnArgs;
    if (!fnArgs) {
      assert(args.payloadId);
      const payload = await ctx.db.get("payload", args.payloadId);
      assert(payload?.args);
      fnArgs = payload.args;
    }
    try {
      const returnValue = await (args.fnType === "query"
        ? ctx.runQuery(args.fnHandle as FunctionHandle<"query">, fnArgs)
        : ctx.runMutation(args.fnHandle as FunctionHandle<"mutation">, fnArgs));
      // Scheduled rather than called: a transaction of its own conflicts less. Inside the `try`, as Convex's is: if
      // scheduling the success fails, the job fails with that error.
      await ctx.scheduler.runAfter(0, internal.complete.complete, {
        jobs: [{ workId, runResult: { kind: "success", returnValue }, attempt }],
      });
    } catch (e) {
      console.error(e);
      await ctx.scheduler.runAfter(0, internal.complete.complete, {
        jobs: [
          {
            workId,
            runResult: { kind: "failed", error: formatError(e) },
            attempt,
            nonRetryable: isNonRetryableError(e),
          },
        ],
      });
    }
  },
});

function formatError(e: unknown): string {
  const nonRetryable = getNonRetryableErrorMessage(e);
  if (nonRetryable !== undefined) return nonRetryable;
  if (e instanceof Error) return e.message;
  return String(e);
}

export const runBatch = internalAction({
  args: { items: v.array(v.object(actionOrQueryRunArgs)), logLevel },
  handler: async (ctx, { items, logLevel }) => {
    const console = createLogger(logLevel);
    await Promise.all(
      items.map(async (item) => {
        const outcome = await runOne(ctx, console, item);
        await completeInline(ctx, console, { workId: item.workId, attempt: item.attempt, ...outcome });
      }),
    );
  },
});

/**
 * Complete one job from the action, `onComplete` included, in its own transaction; if that fails, schedule it. A
 * repeated completion is harmless: `complete` ends each attempt once.
 */
async function completeInline(ctx: ActionCtx, console: Logger, job: CompleteJob): Promise<void> {
  try {
    await ctx.runMutation(internal.complete.complete, { jobs: [job] });
  } catch (e) {
    console.error(`[runBatch] completing ${job.workId} inline failed, falling back to scheduled onComplete: ${e}`);
    await ctx.scheduler.runAfter(0, internal.complete.complete, { jobs: [job] });
  }
}

/** Run one action or query (with its arguments from `payload` if they are there) and say how it went. */
async function runOne(
  ctx: ActionCtx,
  console: Logger,
  args: {
    fnHandle: string;
    fnArgs?: Record<string, unknown> | undefined;
    payloadId?: Id<"payload"> | undefined;
    fnType: "action" | "query";
  },
): Promise<Pick<CompleteJob, "runResult" | "runOnCompleteInline" | "nonRetryable">> {
  try {
    // Inside the `try`: a missing payload fails this job, not the batch.
    let fnArgs = args.fnArgs;
    if (fnArgs === undefined) {
      assert(args.payloadId);
      fnArgs = await ctx.runQuery(internal.worker.getWorkArgs, { payloadId: args.payloadId });
    }
    const returnValue =
      args.fnType === "action"
        ? await ctx.runAction(args.fnHandle as FunctionHandle<"action">, fnArgs)
        : await ctx.runQuery(args.fnHandle as FunctionHandle<"query">, fnArgs);
    return { runResult: { kind: "success", returnValue } satisfies RunResult, runOnCompleteInline: true };
  } catch (e) {
    console.error(e);
    return { runResult: { kind: "failed", error: formatError(e) }, nonRetryable: isNonRetryableError(e) };
  }
}

/** A job's arguments from its `payload`, for `runBatch`. */
export const getWorkArgs = internalQuery({
  args: { payloadId: v.id("payload") },
  returns: v.record(v.string(), v.any()),
  handler: async (ctx, args) => {
    const payload = await ctx.db.get("payload", args.payloadId);
    assert(payload);
    assert(payload.args);
    return payload.args;
  },
});

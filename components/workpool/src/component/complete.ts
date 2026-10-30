// Ending an attempt (STUDY-199 §1.11), as Convex's workpool 0.4.14 does: `complete` counts the attempt, decides
// whether to retry, and, when the job is over, calls its `onComplete` (inline in this transaction for an action's or
// query's success, else scheduled), writes the `completed` event and deletes the job. The loop learns of it from a
// `pendingCompletion`. An attempt number that does not match the job's is a stale or repeated call, and is dropped:
// each attempt completes once.
import { assert } from "@bunvex/helpers";
import type { FunctionHandle } from "@bunvex/server";
import { type Infer, v, valueSize } from "@bunvex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { kickMainLoop } from "./kick";
import { createLogger } from "./logging";
import { getCurrentSegment, type OnCompleteArgs, type RunResult, vResult } from "./shared";
import { recordCompleted } from "./stats";

const completeArgs = v.object({
  jobs: v.array(
    v.object({
      runResult: vResult,
      workId: v.id("work"),
      attempt: v.number(),
      nonRetryable: v.optional(v.boolean()),
      runOnCompleteInline: v.optional(v.boolean()),
    }),
  ),
});
export type CompleteJob = Infer<typeof completeArgs.fields.jobs.element>;

/** The most job, work and payload bytes handled in one `complete`; the rest go to another. */
const MAX_BATCH_SIZE = 2_000_000;

export async function completeHandler(ctx: MutationCtx, args: Infer<typeof completeArgs>): Promise<void> {
  const globals = await ctx.db.query("globals").unique();
  const console = createLogger(globals?.logLevel);
  if (args.jobs.length === 0) {
    console.warn("Trying to complete 0 jobs");
    return;
  }

  const found = await Promise.all(
    args.jobs.map(async (job) => {
      const work = await ctx.db.get("work", job.workId);
      if (!work) {
        console.warn(`[complete] ${job.workId} is done, but its work is gone`);
        return null;
      }
      if (work.attempts !== job.attempt) {
        console.warn(`[complete] ${job.workId} mismatched attempt number`);
        return null;
      }
      return { job, work };
    }),
  );
  const items = found.filter((item) => item !== null);
  if (items.length === 0) return;

  // Split by size; every batch but the first is scheduled as its own `complete`.
  const batches: (typeof items)[] = [];
  let current: typeof items = [];
  let size = 0;
  for (const item of items) {
    const itemSize = valueSize(item.job) + valueSize(item.work) + (item.work.payloadSize ?? 0);
    if (current.length > 0 && size + itemSize > MAX_BATCH_SIZE) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += itemSize;
  }
  if (current.length > 0) batches.push(current);
  for (const later of batches.slice(1)) {
    await ctx.scheduler.runAfter(0, internal.complete.complete, { jobs: later.map(({ job }) => job) });
  }
  const ours = batches[0];
  assert(ours);

  const pendingCompletions: { runResult: RunResult; workId: Id<"work">; retry: boolean }[] = [];
  await Promise.all(
    ours.map(async ({ work, job }) => {
      // Counted before the duplicate check below, as Convex's does (STUDY-199 §2.3).
      work.attempts++;
      await ctx.db.patch("work", work._id, { attempts: work.attempts });
      const existing = await ctx.db
        .query("pendingCompletion")
        .withIndex("workId", (q) => q.eq("workId", job.workId))
        .unique();
      if (existing) {
        console.warn(`[complete] ${job.workId} already in pendingCompletion`);
        return;
      }
      const maxAttempts = work.retryBehavior?.maxAttempts;
      const retry =
        job.runResult.kind === "failed" && !job.nonRetryable && !!maxAttempts && work.attempts < maxAttempts;
      if (!retry) {
        let scheduledId: Id<"_scheduled_functions"> | undefined;
        if (work.onComplete && !work.onComplete.excludeKinds?.includes(job.runResult.kind)) {
          try {
            let context = work.onComplete.context;
            if (context === undefined && work.payloadId) {
              const payload = await ctx.db.get("payload", work.payloadId);
              if (payload) context = payload.context;
            }
            const handle = work.onComplete.fnHandle as FunctionHandle<"mutation", OnCompleteArgs, void>;
            const onCompleteArgs = { workId: work._id, context, result: job.runResult };
            if (job.runOnCompleteInline) {
              try {
                await ctx.runMutation(handle, onCompleteArgs);
              } catch (e) {
                // Its writes are rolled back; scheduled, it runs again.
                console.error(
                  `[complete] caught error while running onComplete inline for ${job.workId}, scheduling instead: ${e}`,
                );
                scheduledId = await ctx.scheduler.runAfter(0, handle, onCompleteArgs);
              }
            } else {
              scheduledId = await ctx.scheduler.runAfter(0, handle, onCompleteArgs);
              console.debug(`[complete] onComplete for ${job.workId} scheduled`);
            }
          } catch (e) {
            console.error(`[complete] error running onComplete for ${job.workId}`, e);
          }
        }
        recordCompleted(console, work, job.runResult.kind, scheduledId);
        if (work.payloadId) {
          // Deleting a missing row throws; that must not fail the completion.
          try {
            await ctx.db.delete("payload", work.payloadId);
          } catch (e) {
            console.warn(`[complete] couldn't delete payload for ${job.workId}: ${e}`);
          }
        }
        // The job is over.
        await ctx.db.delete("work", job.workId);
      }
      if (job.runResult.kind !== "canceled") {
        pendingCompletions.push({ runResult: stripResult(job.runResult), workId: job.workId, retry });
      }
    }),
  );

  if (pendingCompletions.length > 0) {
    await kickMainLoop(ctx, pendingCompletions.some((c) => c.retry) ? "retry" : "complete");
    const segment = getCurrentSegment();
    await Promise.all(pendingCompletions.map((c) => ctx.db.insert("pendingCompletion", { ...c, segment })));
  }
}

/** The loop does not need a success's value. */
function stripResult(result: RunResult): RunResult {
  return result.kind === "success" ? { kind: "success", returnValue: null } : result;
}

export const complete = internalMutation({
  args: completeArgs,
  handler: completeHandler,
});

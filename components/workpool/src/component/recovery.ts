// Recovering jobs whose run died (STUDY-199 §1.12), as Convex's workpool 0.4.14 does: for a job the loop found running
// for over five minutes, read its scheduled function. Gone (never there, or cleaned up) fails it with
// "Scheduled job not found"; failed fails it with the scheduler's error; canceled (from the dashboard) fails it with
// "Canceled via scheduler". Pending, in progress or succeeded leave it alone. A job that completed meanwhile, or moved
// on to another attempt, is skipped. The failures then go through `complete`, so they may be retried.
import { type Infer, v } from "@bunvex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { type CompleteJob, completeHandler } from "./complete";
import { createLogger } from "./logging";

const recoveryArgs = v.object({
  jobs: v.array(
    v.object({
      scheduledId: v.id("_scheduled_functions"),
      workId: v.id("work"),
      attempt: v.number(),
      started: v.number(),
    }),
  ),
});

export const recover = internalMutation({
  args: recoveryArgs,
  handler: recoveryHandler,
});

export async function recoveryHandler(ctx: MutationCtx, { jobs }: Infer<typeof recoveryArgs>): Promise<void> {
  const globals = await ctx.db.query("globals").unique();
  const console = createLogger(globals?.logLevel);
  const toComplete: CompleteJob[] = [];
  for (const job of jobs) {
    const preamble = `[recovery] Scheduled job ${job.scheduledId} for work ${job.workId}`;
    const pendingCompletion = await ctx.db
      .query("pendingCompletion")
      .withIndex("workId", (q) => q.eq("workId", job.workId))
      .first();
    if (pendingCompletion) {
      console.debug(`${preamble} already in pendingCompletion, skipping`);
      continue;
    }
    const work = await ctx.db.get("work", job.workId);
    if (work === null) {
      console.warn(`${preamble} work not found, skipping`);
      continue;
    }
    if (work.attempts !== job.attempt) {
      console.warn(`${preamble} attempts mismatch, skipping`);
      continue;
    }
    const scheduled = await ctx.db.system.get("_scheduled_functions", job.scheduledId);
    if (scheduled === null) {
      console.warn(`${preamble} not found in _scheduled_functions`);
      toComplete.push({
        workId: job.workId,
        runResult: { kind: "failed", error: "Scheduled job not found" },
        attempt: job.attempt,
      });
      continue;
    }
    if (scheduled.state.kind === "failed") {
      console.debug(`${preamble} failed and detected in recovery`);
      toComplete.push({ workId: job.workId, runResult: scheduled.state, attempt: job.attempt });
    } else if (scheduled.state.kind === "canceled") {
      console.debug(`${preamble} was canceled and detected in recovery`);
      toComplete.push({
        workId: job.workId,
        runResult: { kind: "failed", error: "Canceled via scheduler" },
        attempt: job.attempt,
      });
    }
  }
  if (toComplete.length > 0) await completeHandler(ctx, { jobs: toComplete });
}

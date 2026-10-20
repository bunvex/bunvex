// Scheduled jobs that record when they were due and when they ran (the soak's scheduler lag, and its check that
// every job ran exactly once), and one job far in the future that only has to wait.
import { anyApi, internalMutationGeneric, mutationGeneric, queryGeneric } from "bunvex/server";
import { v } from "bunvex/values";

export const schedule = mutationGeneric({
  args: { seq: v.number(), delayMs: v.number() },
  handler: async (ctx, { seq, delayMs }) => {
    await ctx.db.insert("jobs", { seq, dueAt: Date.now() + delayMs, runs: 0 });
    await ctx.scheduler.runAfter(delayMs, anyApi.jobs.run, { seq });
  },
});

export const run = internalMutationGeneric({
  args: { seq: v.number() },
  handler: async (ctx, { seq }) => {
    const job = await ctx.db
      .query("jobs")
      .withIndex("by_seq", (q) => q.eq("seq", seq))
      .unique();
    if (job) await ctx.db.patch(job._id, { ranAt: job.ranAt ?? Date.now(), runs: job.runs + 1 });
  },
});

/** A page of jobs as `[seq, dueAt, ranAt | null, runs]`, by seq. */
export const page = queryGeneric({
  args: { after: v.number(), limit: v.number() },
  handler: async (ctx, { after, limit }) =>
    (
      await ctx.db
        .query("jobs")
        .withIndex("by_seq", (q) => q.gt("seq", after))
        .take(limit)
    ).map((j) => [j.seq, j.dueAt, j.ranAt ?? null, j.runs]),
});

/** A job due in `days` days: an idle scheduler must sleep until then, not poll. */
export const far = mutationGeneric({
  args: { days: v.number() },
  handler: async (ctx, { days }) =>
    void (await ctx.scheduler.runAfter(days * 86_400_000, anyApi.jobs.run, { seq: -1 })),
});

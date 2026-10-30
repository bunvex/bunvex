// Jobs on three pools with different limits:
// - `big` runs up to 20 actions at once and retries a failed one up to three times, with a backoff;
// - `small` runs 3 at once, and gives up at the first failure;
// - `serial` runs one at a time, in the order they were enqueued.
// Each job is an action that takes a little while and fails at the rate the page asked for. Its `onComplete` records
// how it ended, whether it succeeded, failed for good, or was canceled.
import { v } from "@bunvex/values";
import { Workpool } from "@bunvex/workpool";
import { components, internal } from "./_generated/api.js";
import { internalAction, internalMutation, mutation, query } from "./_generated/server.js";

const pools = {
  big: new Workpool(components.bigPool, {
    maxParallelism: 20,
    retryActionsByDefault: true,
    defaultRetryBehavior: { maxAttempts: 3, initialBackoffMs: 200, base: 2 },
  }),
  small: new Workpool(components.smallPool, { maxParallelism: 3 }),
  serial: new Workpool(components.serialPool, { maxParallelism: 1 }),
};
const LIMITS = { big: 20, small: 3, serial: 1 };
const vPool = v.union(v.literal("big"), v.literal("small"), v.literal("serial"));

/** Start `count` jobs on `pool`, each failing with probability `failRate`. */
export const start = mutation({
  args: { pool: vPool, count: v.number(), failRate: v.number() },
  handler: async (ctx, { pool, count, failRate }) => {
    for (let i = 0; i < count; i++) {
      const taskId = await ctx.db.insert("tasks", {
        pool,
        label: `${pool} #${Math.floor(Math.random() * 10_000)}`,
        failRate,
        state: "waiting",
        attempts: 0,
      });
      const workId = await pools[pool].enqueueAction(
        ctx,
        internal.tasks.work,
        { taskId, failRate },
        { onComplete: internal.tasks.finished, context: { taskId } },
      );
      await ctx.db.patch("tasks", taskId, { workId });
    }
  },
});

/** The job: half a second to a second of "work", then a failure at `failRate`. */
export const work = internalAction({
  args: { taskId: v.id("tasks"), failRate: v.number() },
  handler: async (ctx, { taskId, failRate }) => {
    await ctx.runMutation(internal.tasks.running, { taskId });
    await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 500));
    if (Math.random() < failRate) throw new Error("the work failed");
    return { doneAt: Date.now() };
  },
});

/** Each attempt marks its task running, so the page sees retries as they happen. */
export const running = internalMutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get("tasks", taskId);
    if (!task || task.state !== "waiting") {
      if (task?.state === "running") await ctx.db.patch("tasks", taskId, { attempts: task.attempts + 1 });
      return;
    }
    await ctx.db.patch("tasks", taskId, { state: "running", attempts: task.attempts + 1, startedAt: Date.now() });
  },
});

/** How a job ended: the pool calls this once, after its last attempt or its cancelation. */
export const finished = pools.big.defineOnComplete({
  context: v.object({ taskId: v.id("tasks") }),
  handler: async (ctx, { context, result }) => {
    const state = result.kind === "success" ? "succeeded" : result.kind;
    await ctx.db.patch("tasks", context.taskId, {
      state,
      finishedAt: Date.now(),
      ...(result.kind === "failed" ? { error: result.error.split("\n")[0] } : {}),
    });
  },
});

/** Cancel every job of `pool` that has not ended: one not started yet never runs. */
export const cancelAll = mutation({
  args: { pool: vPool },
  handler: async (ctx, { pool }) => {
    await pools[pool].cancelAll(ctx);
  },
});

/** The latest jobs of each pool, and how many of each are running against its limit. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const out = [];
    for (const pool of ["big", "small", "serial"] as const) {
      const tasks = await ctx.db
        .query("tasks")
        .withIndex("pool", (q) => q.eq("pool", pool))
        .order("desc")
        .take(40);
      out.push({
        pool,
        limit: LIMITS[pool],
        running: tasks.filter((t) => t.state === "running").length,
        tasks: tasks.map((t) => ({
          id: t._id,
          label: t.label,
          state: t.state,
          attempts: t.attempts,
          error: t.error ?? null,
        })),
      });
    }
    return out;
  },
});

/** Every job of `pool` with its timing, oldest first: the e2e test checks a pool's limit with it. */
export const timeline = query({
  args: { pool: vPool },
  handler: async (ctx, { pool }) =>
    (
      await ctx.db
        .query("tasks")
        .withIndex("pool", (q) => q.eq("pool", pool))
        .collect()
    ).map((t) => ({
      state: t.state,
      attempts: t.attempts,
      startedAt: t.startedAt ?? null,
      finishedAt: t.finishedAt ?? null,
    })),
});

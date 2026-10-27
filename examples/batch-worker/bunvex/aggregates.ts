// The live scoreboard (Convex's `example/convex/aggregates.ts`): each score is a cheap insert, and one loop folds
// batches of them into per-team totals. One loop at a time means the hot total rows have a single writer, so scorers
// never conflict with each other or with it. Scores are never deleted: the cursor alone moves the scan on.
import { defineBatchWorkerValidators, ping } from "@bunvex/batch-worker";
import { v } from "bunvex/values";
import { components, internal } from "./_generated/api.js";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server.js";

const WORKER = "aggregates";
const BATCH_SIZE = 20;

const worker = {
  name: WORKER,
  workQuery: internal.aggregates.getBatch,
  workerMutation: internal.aggregates.processBatch,
};

/** Record a score and ping; the totals catch up in the background. */
export const recordScore = mutation({
  args: { team: v.string(), points: v.number() },
  handler: async (ctx, { team, points }) => {
    await ctx.db.insert("scoreEvents", { team, points, insertedAt: ctx.db.vars.commitTs });
    await ping(ctx, components.batchWorker, worker);
  },
});

const { vQueryArgs, vQueryReturns, vMutationArgs } = defineBatchWorkerValidators({
  batch: { events: v.array(v.object({ team: v.string(), points: v.number() })) },
});

export const getBatch = internalQuery({
  args: vQueryArgs,
  returns: vQueryReturns,
  handler: async (ctx, { cursor }) => {
    const events = await ctx.db
      .query("scoreEvents")
      .withIndex("insertedAt", (q) => q.gt("insertedAt", cursor ?? 0n))
      .take(BATCH_SIZE);
    if (events.length === 0) return { kind: "idle" as const };
    // The cursor is exclusive (`gt`), so a batch must end on a whole commit timestamp: whatever one mutation inserted
    // and this batch left out would be skipped. Read the rest of the last timestamp's rows in.
    const lastCommitTs = events.at(-1)!.insertedAt as bigint;
    const taken = new Set(events.map((e) => e._id));
    const rest = await ctx.db
      .query("scoreEvents")
      .withIndex("insertedAt", (q) => q.eq("insertedAt", lastCommitTs))
      .collect();
    events.push(...rest.filter((e) => !taken.has(e._id)));
    return {
      kind: "work" as const,
      batch: { events: events.map((e) => ({ team: e.team, points: e.points })) },
      cursor: lastCommitTs,
    };
  },
});

/** One delta per team, so each total row is written once per batch. */
export const processBatch = internalMutation({
  args: vMutationArgs,
  handler: async (ctx, { events }) => {
    const deltas = new Map<string, number>();
    for (const { team, points } of events) deltas.set(team, (deltas.get(team) ?? 0) + points);
    for (const [team, delta] of deltas) {
      const row = await ctx.db
        .query("teamTotals")
        .withIndex("team", (q) => q.eq("team", team))
        .unique();
      if (row) await ctx.db.patch("teamTotals", row._id, { total: row.total + delta });
      else await ctx.db.insert("teamTotals", { team, total: delta });
    }
  },
});

/** The totals by team, and how many scores are still to be folded in. */
export const getTotals = query({
  args: {},
  handler: async (ctx) => {
    const totals = await ctx.db.query("teamTotals").take(100);
    const from = ((await ctx.runQuery(components.batchWorker.lib.getCursor, { name: WORKER })) ?? 0n) as bigint;
    const pending = (
      await ctx.db
        .query("scoreEvents")
        .withIndex("insertedAt", (q) => q.gt("insertedAt", from))
        .take(1000)
    ).length;
    return { totals: Object.fromEntries(totals.map((t) => [t.team, t.total])), pending };
  },
});

export const workerStatus = query({
  args: {},
  handler: async (ctx) => ctx.runQuery(components.batchWorker.lib.status, { name: WORKER }),
});

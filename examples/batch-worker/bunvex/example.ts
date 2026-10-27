// The work queue (Convex's `example/convex/example.ts`): each `addEvent` inserts a value and pings the `events`
// worker; the worker sums batches of 10 into one total and deletes what it processed. The work query resumes from
// the cursor it returned last time, a commit timestamp, so it never rescans the deleted rows.
import { defineBatchWorkerValidators, ping } from "@bunvex/batch-worker";
import { v } from "bunvex/values";
import { components, internal } from "./_generated/api.js";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server.js";

/** The worker's name: several named workers share one component. */
const WORKER = "events";
const BATCH_SIZE = 10;

/** Queue a value, then make sure the worker's loop runs. */
export const addEvent = mutation({
  args: { value: v.number() },
  handler: async (ctx, { value }) => {
    // Every row one mutation writes gets its commit timestamp, and nothing can commit later with a smaller one: a
    // safe cursor.
    await ctx.db.insert("events", { value, insertedAt: ctx.db.vars.commitTs });
    await ping(ctx, components.batchWorker, {
      name: WORKER,
      workQuery: internal.example.getBatch,
      workerMutation: internal.example.processBatch,
    });
  },
});

const vEvent = v.object({ id: v.id("events"), value: v.number() });
const { vQueryArgs, vQueryReturns, vMutationArgs, vMutationReturns } = defineBatchWorkerValidators({
  batch: { events: v.array(vEvent) },
});

/** The next batch from the cursor on, or `idle`. */
export const getBatch = internalQuery({
  args: vQueryArgs,
  returns: vQueryReturns,
  handler: async (ctx, { cursor }) => {
    // `gte`: the rows of one mutation share a timestamp, and a batch may end in the middle of them.
    const events = await ctx.db
      .query("events")
      .withIndex("insertedAt", (q) => q.gte("insertedAt", cursor ?? 0n))
      .take(BATCH_SIZE);
    if (events.length === 0) return { kind: "idle" as const };
    return {
      kind: "work" as const,
      batch: { events: events.map((e) => ({ id: e._id, value: e.value })) },
      cursor: events.at(-1)!.insertedAt,
    };
  },
});

/** Add the batch to the total, then delete its rows. Returning nothing runs the loop again at once. */
export const processBatch = internalMutation({
  args: vMutationArgs,
  returns: vMutationReturns,
  handler: async (ctx, { events }) => {
    const sum = events.reduce((total, e) => total + e.value, 0);
    const totals = await ctx.db
      .query("totals")
      .withIndex("key", (q) => q.eq("key", "all"))
      .unique();
    if (totals) {
      await ctx.db.patch("totals", totals._id, { total: totals.total + sum, count: totals.count + events.length });
    } else {
      await ctx.db.insert("totals", { key: "all", total: sum, count: events.length });
    }
    for (const { id } of events) await ctx.db.delete("events", id);
  },
});

/** The total, how many events it sums, and how many are still queued (counted from the worker's cursor). */
export const getTotals = query({
  args: {},
  handler: async (ctx) => {
    const totals = await ctx.db
      .query("totals")
      .withIndex("key", (q) => q.eq("key", "all"))
      .unique();
    const from = ((await ctx.runQuery(components.batchWorker.lib.getCursor, { name: WORKER })) ?? 0n) as bigint;
    const pending = (
      await ctx.db
        .query("events")
        .withIndex("insertedAt", (q) => q.gte("insertedAt", from))
        .take(1000)
    ).length;
    return { total: totals?.total ?? 0, count: totals?.count ?? 0, pending };
  },
});

export const workerStatus = query({
  args: {},
  handler: async (ctx) => ctx.runQuery(components.batchWorker.lib.status, { name: WORKER }),
});

// The component's public functions (STUDY-196 §1.2), with the paths, validators and results of Convex's package:
// `lib:ping` (which the client calls, making the handles), `lib:start`, `lib:stop`, `lib:kick`, `lib:status`,
// `lib:getCursor` and `lib:setCursor`.
import { v } from "@bunvex/values";
import { mutation, query } from "./functions";
import {
  getOrCreateWorkerState,
  getWorker,
  kick as kickWorker,
  ping as pingWorker,
  start as startWorker,
  stop as stopWorker,
} from "./kick";
import { vConfig, vStatus } from "./shared";

export const ping = mutation({
  args: {
    name: v.string(),
    workQuery: v.string(),
    workerMutation: v.string(),
    config: v.optional(vConfig.partial()),
  },
  returns: v.null(),
  handler: async (ctx, args) => pingWorker(ctx, args),
});

export const start = mutation({
  args: { name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => startWorker(ctx, args.name),
});

export const stop = mutation({
  args: { name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => stopWorker(ctx, args.name),
});

/** Restart a wedged worker from any state, e.g. after its scheduled functions were cancelled from the dashboard. */
export const kick = mutation({
  args: { name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => kickWorker(ctx, args.name),
});

export const status = query({
  args: { name: v.string() },
  returns: v.union(v.null(), vStatus),
  handler: async (ctx, args) => (await getWorker(ctx, args.name))?.status,
});

/** The cursor the worker last committed, or null: for the app's own queries that scan the range the worker does. */
export const getCursor = query({
  args: { name: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const worker = await getWorker(ctx, args.name);
    if (!worker) return null;
    const state = await ctx.db.get("workerState", worker.stateId);
    return state?.cursor ?? null;
  },
});

/**
 * Replace the worker's cursor, or clear it when `cursor` is omitted, so the next scan starts from the front. For
 * migrations and recovery: the loop writes the same row every iteration, so a busy worker may conflict. The worker
 * must have been pinged first.
 */
export const setCursor = mutation({
  args: { name: v.string(), cursor: v.optional(v.any()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const worker = await getWorker(ctx, args.name);
    if (!worker) throw new Error(`[setCursor] no worker named "${args.name}". Ping it first.`);
    const state = await getOrCreateWorkerState(ctx, worker);
    await ctx.db.patch("workerState", state._id, { cursor: args.cursor });
  },
});

// The app of test/batch-worker.test.ts (STUDY-196): two workers written with `defineBatchWorkerValidators` and
// pinged through the package's client, the component's functions called as an app calls them (bad arguments
// included), and what the test reads back. On bunvex the harness renames `@convex-dev/batch-worker` to
// `@bunvex/batch-worker`.
// biome-ignore-all lint/suspicious/noExplicitAny: the component and the app's api are untyped here
import { defineBatchWorkerValidators, ping } from "@convex-dev/batch-worker";
import {
  anyApi,
  componentsGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

const batchWorker = (componentsGeneric() as any).batchWorker;
const internal = anyApi as any;
const IDLE = { kind: "idle" as const, cooldownMs: 100, pollIntervalMs: 20 };

const items = defineBatchWorkerValidators({ batch: { ids: v.array(v.id("items")) } });

export const getBatch = internalQueryGeneric({
  args: items.vQueryArgs,
  returns: items.vQueryReturns,
  handler: async (ctx) => {
    const rows = await ctx.db.query("items").take(5);
    if (rows.length === 0) return IDLE;
    return { kind: "work" as const, batch: { ids: rows.map((r) => r._id) } };
  },
});

export const processBatch = internalMutationGeneric({
  args: items.vMutationArgs,
  returns: items.vMutationReturns,
  handler: async (ctx, { ids }) => {
    const values: number[] = [];
    for (const id of ids) {
      values.push(((await ctx.db.get(id)) as any).value);
      await ctx.db.delete(id);
    }
    await ctx.db.insert("batches", { values });
    return null;
  },
});

/** Insert `values` in one mutation, then ping once. */
export const enqueue = mutationGeneric({
  args: { values: v.array(v.number()) },
  handler: async (ctx, { values }) => {
    for (const value of values) await ctx.db.insert("items", { value });
    await ping(ctx, batchWorker, {
      name: "items",
      workQuery: internal.worker.getBatch,
      workerMutation: internal.worker.processBatch,
    });
  },
});

const marks = defineBatchWorkerValidators({ batch: { seqs: v.array(v.int64()) } });

export const getMarks = internalQueryGeneric({
  args: marks.vQueryArgs,
  returns: marks.vQueryReturns,
  handler: async (ctx, { cursor }) => {
    const rows = await ctx.db
      .query("marks")
      .withIndex("seq", (q) => q.gte("seq", cursor ?? 0n))
      .take(2);
    if (rows.length === 0) return IDLE;
    return { kind: "work" as const, batch: { seqs: rows.map((r) => r.seq) }, cursor: rows[rows.length - 1]!.seq + 1n };
  },
});

export const processMarks = internalMutationGeneric({
  args: marks.vMutationArgs,
  returns: marks.vMutationReturns,
  handler: async (ctx, { seqs }) => {
    await ctx.db.insert("markBatches", { seqs });
    return null;
  },
});

export const enqueueMarks = mutationGeneric({
  args: { seqs: v.array(v.number()) },
  handler: async (ctx, { seqs }) => {
    for (const seq of seqs) await ctx.db.insert("marks", { seq: BigInt(seq) });
    await ping(ctx, batchWorker, {
      name: "marks",
      workQuery: internal.worker.getMarks,
      workerMutation: internal.worker.processMarks,
    });
  },
});

/** A component function with `args` as given: its result, or its error's message. */
export const call = mutationGeneric({
  args: { fn: v.string(), args: v.any() },
  handler: async (ctx, { fn, args }) => {
    const ref = batchWorker.lib[fn];
    const isQuery = fn === "status" || fn === "getCursor";
    try {
      return { ok: isQuery ? await ctx.runQuery(ref, args) : await ctx.runMutation(ref, args) };
    } catch (e) {
      // The message without its stack: the frames name each package's own files.
      return { error: (e as Error).message.split("\n    at ")[0] };
    }
  },
});

/** What the test compares once both workers are idle. */
export const state = queryGeneric({
  args: {},
  handler: async (ctx) => ({
    items: (await ctx.db.query("items").collect()).length,
    batches: (await ctx.db.query("batches").collect()).map((b) => b.values),
    markBatches: (await ctx.db.query("markBatches").collect()).map((b) => b.seqs),
    status: {
      items: await ctx.runQuery(batchWorker.lib.status, { name: "items" }),
      marks: await ctx.runQuery(batchWorker.lib.status, { name: "marks" }),
    },
    cursor: {
      items: await ctx.runQuery(batchWorker.lib.getCursor, { name: "items" }),
      marks: await ctx.runQuery(batchWorker.lib.getCursor, { name: "marks" }),
    },
  }),
});

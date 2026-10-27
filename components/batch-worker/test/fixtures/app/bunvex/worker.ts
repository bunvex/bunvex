// The app's side of upstream's client tests (`src/client/index.test.ts`), as functions of a pushed app: three
// workers (`items`, `marks`, `letters`), each with its work query and worker mutation, and the app's mutations that
// enqueue, ping, start, stop and read or set the cursor through the component.
//
// Upstream writes the first two workers with the deprecated `vBatchQueryArgs` / `vBatchResult`, which bunvex does
// not build (DV-539); `defineBatchWorkerValidators({ batch })` gives the same validators.
import { defineBatchWorkerValidators, ping } from "@bunvex/batch-worker";
import type { ComponentApi } from "@bunvex/batch-worker/_generated/component.js";
import {
  anyApi,
  componentsGeneric,
  type DataModelFromSchemaDefinition,
  internalMutationGeneric,
  internalQueryGeneric,
  type MutationBuilder,
  mutationGeneric,
  type QueryBuilder,
  queryGeneric,
} from "@bunvex/server";
import { v } from "@bunvex/values";
import type schema from "./schema.ts";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;
const query = queryGeneric as QueryBuilder<DataModel, "public">;
const internalMutation = internalMutationGeneric as MutationBuilder<DataModel, "internal">;
const internalQuery = internalQueryGeneric as QueryBuilder<DataModel, "internal">;
// biome-ignore lint/suspicious/noExplicitAny: the app's own api, untyped without codegen
const internal = anyApi as any;
const batchWorker = (componentsGeneric() as unknown as { batchWorker: ComponentApi }).batchWorker;

const WORKER = "items";
const CURSOR_WORKER = "marks";
const LETTER_WORKER = "letters";
const BATCH = 2;
/** Cool down quickly, so draining the scheduled functions ends. */
const IDLE = { kind: "idle" as const, cooldownMs: 100, pollIntervalMs: 10 };

// ── A queue drained by deleting ────────────────────────────────────────────

const items = defineBatchWorkerValidators({ batch: { ids: v.array(v.id("items")) } });

export const getBatch = internalQuery({
  args: items.vQueryArgs,
  returns: items.vQueryReturns,
  handler: async (ctx) => {
    const rows = await ctx.db.query("items").take(5);
    if (rows.length === 0) return IDLE;
    return { kind: "work" as const, batch: { ids: rows.map((r) => r._id) } };
  },
});

export const processBatch = internalMutation({
  args: { ids: v.array(v.id("items")) },
  handler: async (ctx, { ids }) => {
    for (const id of ids) await ctx.db.delete("items", id);
  },
});

export const enqueue = mutation({
  args: { value: v.number() },
  handler: async (ctx, { value }) => {
    await ctx.db.insert("items", { value });
    await ping(ctx, batchWorker, {
      name: WORKER,
      config: { debounceMs: 0 },
      workQuery: internal.worker.getBatch,
      workerMutation: internal.worker.processBatch,
    });
  },
});

export const status = query({
  args: {},
  handler: async (ctx) => ctx.runQuery(batchWorker.lib.status, { name: WORKER }),
});
export const startWorker = mutation({
  args: {},
  handler: async (ctx) => ctx.runMutation(batchWorker.lib.start, { name: WORKER }),
});
export const stopWorker = mutation({
  args: {},
  handler: async (ctx) => ctx.runMutation(batchWorker.lib.stop, { name: WORKER }),
});
export const remaining = query({
  args: {},
  handler: async (ctx) => (await ctx.db.query("items").take(1000)).length,
});

// ── A worker driven by its cursor alone ────────────────────────────────────

const marks = defineBatchWorkerValidators({ batch: { seqs: v.array(v.int64()) } });

export const getMarks = internalQuery({
  args: marks.vQueryArgs,
  returns: marks.vQueryReturns,
  handler: async (ctx, { cursor }) => {
    const rows = await ctx.db
      .query("marks")
      .withIndex("seq", (q) => q.gte("seq", (cursor as bigint | undefined) ?? 0n))
      .take(BATCH);
    if (rows.length === 0) return IDLE;
    // Nothing is deleted: only this advancing cursor ends the drain.
    return { kind: "work" as const, batch: { seqs: rows.map((r) => r.seq) }, cursor: rows.at(-1)!.seq + 1n };
  },
});

export const processMarks = internalMutation({
  args: { seqs: v.array(v.int64()) },
  handler: async (ctx, { seqs }) => {
    await ctx.db.insert("batches", { seqs });
  },
});

/** Claims only the batch's first mark, overriding the query's cursor. */
export const processMarksPartially = internalMutation({
  args: { seqs: v.array(v.int64()) },
  handler: async (ctx, { seqs }) => {
    await ctx.db.insert("batches", { seqs });
    return { cursor: seqs[0]! + 1n };
  },
});

export const enqueueMark = mutation({
  args: { seq: v.int64(), partial: v.optional(v.boolean()) },
  handler: async (ctx, { seq, partial }) => {
    await ctx.db.insert("marks", { seq });
    await ping(ctx, batchWorker, {
      name: CURSOR_WORKER,
      config: { debounceMs: 0 },
      workQuery: internal.worker.getMarks,
      workerMutation: partial ? internal.worker.processMarksPartially : internal.worker.processMarks,
    });
  },
});

export const markCursor = query({
  args: {},
  handler: async (ctx) => ctx.runQuery(batchWorker.lib.getCursor, { name: CURSOR_WORKER }),
});
export const setMarkCursor = mutation({
  args: { cursor: v.optional(v.int64()) },
  handler: async (ctx, { cursor }) => ctx.runMutation(batchWorker.lib.setCursor, { name: CURSOR_WORKER, cursor }),
});
export const batches = query({
  args: {},
  handler: async (ctx) => (await ctx.db.query("batches").take(1000)).map((b) => b.seqs),
});

/** `ping` creates the worker; `stop` in the same mutation keeps its loop from running; then the cursor is set. */
export const seedMarks = mutation({
  args: { seqs: v.array(v.int64()), cursor: v.int64() },
  handler: async (ctx, { seqs, cursor }) => {
    for (const seq of seqs) await ctx.db.insert("marks", { seq });
    await ping(ctx, batchWorker, {
      name: CURSOR_WORKER,
      config: { debounceMs: 0 },
      workQuery: internal.worker.getMarks,
      workerMutation: internal.worker.processMarks,
    });
    await ctx.runMutation(batchWorker.lib.stop, { name: CURSOR_WORKER });
    await ctx.runMutation(batchWorker.lib.setCursor, { name: CURSOR_WORKER, cursor });
  },
});
export const startMarks = mutation({
  args: {},
  handler: async (ctx) => ctx.runMutation(batchWorker.lib.start, { name: CURSOR_WORKER }),
});

// ── A worker whose cursor is not a commit timestamp ────────────────────────

const letters = defineBatchWorkerValidators({ batch: { letters: v.array(v.string()) }, cursor: v.string() });

export const getLetters = internalQuery({
  args: letters.vQueryArgs,
  returns: letters.vQueryReturns,
  handler: async (ctx, { cursor }) => {
    const rows = await ctx.db
      .query("letters")
      .withIndex("letter", (q) => q.gt("letter", cursor ?? ""))
      .take(BATCH);
    if (rows.length === 0) return IDLE;
    return { kind: "work" as const, batch: { letters: rows.map((r) => r.letter) }, cursor: rows.at(-1)!.letter };
  },
});

export const processLetters = internalMutation({
  args: letters.vMutationArgs,
  returns: letters.vMutationReturns,
  handler: async (ctx, { letters }) => {
    await ctx.db.insert("letterBatches", { letters });
    return null;
  },
});

export const enqueueLetter = mutation({
  args: { letter: v.string() },
  handler: async (ctx, { letter }) => {
    await ctx.db.insert("letters", { letter });
    await ping(ctx, batchWorker, {
      name: LETTER_WORKER,
      config: { debounceMs: 0 },
      workQuery: internal.worker.getLetters,
      workerMutation: internal.worker.processLetters,
    });
  },
});

export const letterBatches = query({
  args: {},
  handler: async (ctx) => (await ctx.db.query("letterBatches").take(1000)).map((b) => b.letters),
});
export const letterCursor = query({
  args: {},
  handler: async (ctx) => ctx.runQuery(batchWorker.lib.getCursor, { name: LETTER_WORKER }),
});

// ── A worker mutation that throws (STUDY-196 §3.5) ─────────────────────────
// It throws while no `allowed` row exists. The loop's run fails, nothing reschedules it, and the monitor restarts it
// `monitorLagMs` later; the job is still there, so the same batch comes back.

const jobs = defineBatchWorkerValidators({ batch: { ids: v.array(v.id("jobs")) } });
const JOB_WORKER = "jobs";

export const getJobs = internalQuery({
  args: jobs.vQueryArgs,
  returns: jobs.vQueryReturns,
  handler: async (ctx) => {
    const rows = await ctx.db.query("jobs").take(5);
    if (rows.length === 0) return IDLE;
    return { kind: "work" as const, batch: { ids: rows.map((r) => r._id) } };
  },
});

export const processJobs = internalMutation({
  args: { ids: v.array(v.id("jobs")) },
  handler: async (ctx, { ids }) => {
    if ((await ctx.db.query("allowed").first()) === null) throw new Error("not allowed yet");
    for (const id of ids) {
      const job = (await ctx.db.get("jobs", id))!;
      await ctx.db.insert("done", { value: job.value });
      await ctx.db.delete("jobs", id);
    }
  },
});

export const enqueueJob = mutation({
  args: { value: v.number() },
  handler: async (ctx, { value }) => {
    await ctx.db.insert("jobs", { value });
    await ping(ctx, batchWorker, {
      name: JOB_WORKER,
      workQuery: internal.worker.getJobs,
      workerMutation: internal.worker.processJobs,
    });
  },
});

export const allow = mutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.insert("allowed", {});
  },
});

export const jobsLeft = query({
  args: {},
  handler: async (ctx) => (await ctx.db.query("jobs").collect()).length,
});
export const jobsDone = query({
  args: {},
  handler: async (ctx) => (await ctx.db.query("done").collect()).map((d) => d.value),
});
export const jobStatus = query({
  args: {},
  handler: async (ctx) => ctx.runQuery(batchWorker.lib.status, { name: JOB_WORKER }),
});
export const setJobCursor = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => ctx.runMutation(batchWorker.lib.setCursor, { name, cursor: 1n }),
});

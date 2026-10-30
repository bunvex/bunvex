// The work a pool runs and the calls that enqueue it, the same on both backends. Each job has a label; its
// `onComplete` records `{workId, context, result}` under that label, so the test reads every callback back.
import { NonRetryableError, vOnCompleteArgs, Workpool } from "@convex-dev/workpool";
import { actionGeneric, internalMutationGeneric, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";

const pool = new Workpool(components.pool, { maxParallelism: 3 });

/** The work itself. `fail` throws; `failTimes` throws until it has run that many times; `nonRetryable` refuses. */
export const act = actionGeneric({
  args: {
    label: v.string(),
    fail: v.optional(v.boolean()),
    failTimes: v.optional(v.number()),
    nonRetryable: v.optional(v.boolean()),
  },
  handler: async (ctx, { label, fail, failTimes, nonRetryable }) => {
    if (nonRetryable) throw new NonRetryableError(`no retry for ${label}`);
    if (fail) throw new Error(`action ${label} failed`);
    if (failTimes !== undefined) {
      const n: number = await ctx.runMutation(internal.work.bump, { label });
      if (n <= failTimes) throw new Error(`attempt ${n} of ${label} failed`);
    }
    return { label, from: "action" };
  },
});
export const mut = internalMutationGeneric({
  args: { label: v.string(), fail: v.optional(v.boolean()) },
  handler: async (ctx, { label, fail }) => {
    await ctx.db.insert("attempts", { label: `${label}:wrote`, n: 1 });
    if (fail) throw new Error(`mutation ${label} failed`);
    return { label, from: "mutation" };
  },
});
export const qry = queryGeneric({
  args: { label: v.string(), fail: v.optional(v.boolean()) },
  handler: async (_ctx, { label, fail }) => {
    if (fail) throw new Error(`query ${label} failed`);
    return { label, from: "query" };
  },
});
export const bump = internalMutationGeneric({
  args: { label: v.string() },
  handler: async (ctx, { label }) => {
    const row = await ctx.db
      .query("attempts")
      .withIndex("label", (q) => q.eq("label", label))
      .unique();
    if (row) {
      await ctx.db.patch(row._id, { n: row.n + 1 });
      return row.n + 1;
    }
    await ctx.db.insert("attempts", { label, n: 1 });
    return 1;
  },
});

export const done = internalMutationGeneric({
  args: vOnCompleteArgs(v.object({ label: v.string() })),
  handler: async (ctx, { workId, context, result }) => {
    await ctx.db.insert("completions", { label: context.label, workId, context, result });
  },
});

const fnOf = { action: internal.work.act, mutation: internal.work.mut, query: internal.work.qry } as never;

/** Enqueue one job of `kind`, with its `onComplete`; returns its id and its status right after. */
export const enqueue = mutationGeneric({
  args: {
    kind: v.union(v.literal("action"), v.literal("mutation"), v.literal("query")),
    label: v.string(),
    fail: v.optional(v.boolean()),
    failTimes: v.optional(v.number()),
    nonRetryable: v.optional(v.boolean()),
    retry: v.optional(v.any()),
    runAfter: v.optional(v.number()),
    excludeKinds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, a) => {
    const options = {
      onComplete: internal.work.done,
      context: { label: a.label },
      ...(a.retry !== undefined ? { retry: a.retry } : {}),
      ...(a.runAfter !== undefined ? { runAfter: a.runAfter } : {}),
      ...(a.excludeKinds !== undefined ? { onCompleteExcludeKinds: a.excludeKinds as never } : {}),
    };
    const args: Record<string, unknown> = { label: a.label };
    if (a.fail) args.fail = true;
    if (a.failTimes !== undefined) args.failTimes = a.failTimes;
    if (a.nonRetryable) args.nonRetryable = true;
    const fn = (fnOf as Record<string, never>)[a.kind];
    const id =
      a.kind === "action"
        ? await pool.enqueueAction(ctx, fn, args as never, options as never)
        : a.kind === "mutation"
          ? await pool.enqueueMutation(ctx, fn, args as never, options as never)
          : await pool.enqueueQuery(ctx, fn, args as never, options as never);
    return { id, status: await pool.status(ctx, id) };
  },
});

export const cancel = mutationGeneric({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    await pool.cancel(ctx, id as never);
    return pool.status(ctx, id as never);
  },
});

export const status = queryGeneric({
  args: { id: v.string() },
  handler: async (ctx, { id }) => pool.status(ctx, id as never),
});

/** Every callback recorded, by label, without the work ids (each backend's own). */
export const completions = queryGeneric({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("completions").collect();
    return all
      .map((c) => ({ label: c.label, context: c.context, result: c.result, idMatches: typeof c.workId === "string" }))
      .sort((a, b) => (a.label < b.label ? -1 : 1));
  },
});

/** Calls the client or the component refuses, each with its error's message. */
export const refusals = mutationGeneric({
  args: {},
  handler: async (ctx) => {
    const attempt = async (f: () => Promise<unknown>) => {
      try {
        await f();
        return "ok";
      } catch (e) {
        return String((e as Error).message);
      }
    };
    const big = "x".repeat(1_000_001);
    return {
      tooParallel: await attempt(() =>
        new Workpool(components.pool, { maxParallelism: 201 }).enqueueMutation(ctx, internal.work.mut, { label: "p" }),
      ),
      negative: await attempt(() =>
        new Workpool(components.pool, { maxParallelism: -1 }).enqueueMutation(ctx, internal.work.mut, { label: "n" }),
      ),
      bigArgs: await attempt(() => pool.enqueueMutation(ctx, internal.work.mut, { label: big })),
      badKind: await attempt(() =>
        pool.enqueueMutation(
          ctx,
          internal.work.mut,
          { label: "k" },
          {
            onComplete: internal.work.done,
            context: { label: "k" },
            onCompleteExcludeKinds: ["running"] as never,
          },
        ),
      ),
    };
  },
});

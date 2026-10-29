// STUDY-174 Q6's read bench: a seed mutation, then the three reads the driver measures: a point get by id, an
// index range read, and a paginated query over one group.
import { mutationGeneric, paginationOptsValidator, queryGeneric } from "@bunvex/server";
import { v } from "@bunvex/values";

export const GROUPS = 1000;

/** ~1 000 bytes that differ per document. */
const body = (i: number) => `${i}:`.padEnd(40, "x").repeat(25);

/** Inserts documents `start` to `start + count - 1`; returns the ids of every `sampleEvery`-th. */
export const seed = mutationGeneric({
  args: { start: v.number(), count: v.number(), sampleEvery: v.number() },
  handler: async (ctx, { start, count, sampleEvery }) => {
    const ids: string[] = [];
    for (let i = start; i < start + count; i++) {
      const id = await ctx.db.insert("items", { group: i % GROUPS, n: Math.floor(i / GROUPS), body: body(i) });
      if (i % sampleEvery === 0) ids.push(id);
    }
    return ids;
  },
});

export const get = queryGeneric({
  args: { id: v.id("items") },
  handler: async (ctx, { id }) => (await ctx.db.get(id))?.n ?? null,
});

export const range = queryGeneric({
  args: { group: v.number(), from: v.number(), limit: v.number() },
  handler: async (ctx, { group, from, limit }) =>
    (
      await ctx.db
        .query("items")
        .withIndex("by_group_n", (q) => q.eq("group", group).gte("n", from))
        .take(limit)
    ).length,
});

export const page = queryGeneric({
  args: { group: v.number(), from: v.number(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { group, from, paginationOpts }) => {
    const r = await ctx.db
      .query("items")
      .withIndex("by_group_n", (q) => q.eq("group", group).gte("n", from))
      .paginate(paginationOpts);
    return { n: r.page.length, isDone: r.isDone, continueCursor: r.continueCursor };
  },
});

/** One small commit (the bench's checkpoint step makes 600, so the table summary checkpoint catches up). */
export const touch = mutationGeneric({
  args: { id: v.id("items") },
  handler: async (ctx, { id }) => {
    const doc = await ctx.db.get(id);
    if (doc) await ctx.db.patch(id, { n: doc.n });
  },
});

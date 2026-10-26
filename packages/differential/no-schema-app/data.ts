import { mutationGeneric as mutation, queryGeneric as query } from "convex/server";
import { v } from "convex/values";

export const add = mutation({
  args: { n: v.number() },
  handler: async (ctx, { n }) => {
    await ctx.db.insert("items", { n });
  },
});

// A document with more fields than a shape's object holds (`MAX_OBJECT_FIELDS`, 64): its shape is a record, so a
// streaming export's JSON Schema is read from the active schema.
export const addWide = mutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.insert("wide", Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`f${i}`, i])));
  },
});

export const byN = query({
  args: { n: v.number() },
  handler: async (ctx, { n }) =>
    (
      await ctx.db
        .query("items")
        .withIndex("by_n" as never, (q: any) => q.eq("n", n))
        .collect()
    ).map((d) => d.n),
});

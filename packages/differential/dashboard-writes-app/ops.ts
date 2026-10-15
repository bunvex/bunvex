// The app of the Data screen's write tests (STUDY-149 PR 3): every document of a table, oldest first.
import { queryGeneric } from "convex/server";
import { v } from "convex/values";

export const dump = queryGeneric({
  args: { table: v.string() },
  handler: async (ctx, { table }) => await ctx.db.query(table).collect(),
});

// The bulk edit's large table (STUDY-149 "Bulk edit"): how many documents, and how many have `field`.
export const count = queryGeneric({
  args: { table: v.string(), field: v.string() },
  handler: async (ctx, { table, field }) => {
    const docs = await ctx.db.query(table).collect();
    return { documents: docs.length, withField: docs.filter((d) => field in d).length };
  },
});

export const firstId = queryGeneric({
  args: { table: v.string() },
  handler: async (ctx, { table }) => (await ctx.db.query(table).first())?._id ?? null,
});

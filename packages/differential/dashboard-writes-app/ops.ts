// The app of the Data screen's write tests (STUDY-149 PR 3): every document of a table, oldest first.
import { queryGeneric } from "convex/server";
import { v } from "convex/values";

export const dump = queryGeneric({
  args: { table: v.string() },
  handler: async (ctx, { table }) => await ctx.db.query(table).collect(),
});

// The app of test/data-sync-page.test.ts: rows written in bulk.
import { mutationGeneric } from "convex/server";
import { v } from "convex/values";

export const put = mutationGeneric({
  args: { n: v.number() },
  handler: async (ctx, { n }) => {
    for (let i = 0; i < n; i++) await ctx.db.insert("rows", { i });
  },
});

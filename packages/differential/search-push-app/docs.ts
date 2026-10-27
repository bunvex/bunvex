// The functions of test/search-after-deploy.test.ts: rows written in bulk, a search and a vector search.
import { actionGeneric, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const many = mutationGeneric({
  args: { from: v.number(), n: v.number() },
  handler: async (ctx, { from, n }) => {
    for (let i = from; i < from + n; i++)
      await ctx.db.insert("docs", { body: i % 3 ? `hello ${i}` : "goodbye", v: [i, 1] });
  },
});

export const search = queryGeneric({
  args: {},
  handler: async (ctx) =>
    // biome-ignore lint/suspicious/noExplicitAny: the index is not in the first schema's types
    (
      await (ctx.db.query("docs") as any)
        .withSearchIndex("search_body", (q: any) => q.search("body", "hello"))
        .take(1000)
    ).length,
});

export const nearest = actionGeneric({
  args: {},
  // biome-ignore lint/suspicious/noExplicitAny: as above
  handler: async (ctx) => (await ctx.vectorSearch("docs" as any, "by_v" as any, { vector: [1, 0], limit: 5 })).length,
});

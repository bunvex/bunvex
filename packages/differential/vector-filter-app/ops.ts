// Vector searches with `q.or` over a list of tags, the list possibly empty (STUDY-187 §2.3).
import { actionGeneric, mutationGeneric } from "convex/server";
import { v } from "convex/values";

export const seed = mutationGeneric({
  args: {},
  handler: async ({ db }) => {
    for (const [tag, e] of [
      ["a", [1, 0, 0]],
      ["b", [0, 1, 0]],
      ["c", [0, 0, 1]],
    ] as const)
      await db.insert("docs", { tag, e: [...e] });
  },
});

export const search = actionGeneric({
  args: { tags: v.union(v.array(v.string()), v.null()) },
  handler: async (ctx, { tags }) => {
    const hits = await ctx.vectorSearch("docs", "by_e", {
      vector: [1, 1, 1],
      limit: 10,
      ...(tags === null ? {} : { filter: (q) => q.or(...tags.map((t) => q.eq("tag", t))) }),
    });
    return hits.length;
  },
});

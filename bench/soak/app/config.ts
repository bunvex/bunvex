// The cache canary: a query that reads no time and a row written only every few minutes. It must stay cached
// between those writes: each of its runs past the warm-up is a miss the soak counts (STUDY-174, #751).
import { mutationGeneric, queryGeneric } from "bunvex/server";
import { v } from "bunvex/values";

export const get = queryGeneric({
  args: { key: v.string() },
  handler: async (ctx, { key }) =>
    (
      await ctx.db
        .query("config")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique()
    )?.value ?? null,
});

export const set = mutationGeneric({
  args: { key: v.string(), value: v.number() },
  handler: async (ctx, { key, value }) => {
    const row = await ctx.db
      .query("config")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (row) await ctx.db.patch(row._id, { value });
    else await ctx.db.insert("config", { key, value });
  },
});

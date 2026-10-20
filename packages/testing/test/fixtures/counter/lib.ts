import { mutation, query } from "@bunvex/server";
import { v } from "@bunvex/values";

export const add = mutation({
  args: { name: v.string(), by: v.optional(v.number()) },
  handler: async (ctx, { name, by }) => {
    const row = await ctx.db
      .query("counts")
      .withIndex("name", (q) => q.eq("name", name))
      .unique();
    if (row) await ctx.db.patch(row._id, { n: row.n + (by ?? 1) });
    else await ctx.db.insert("counts", { name, n: by ?? 1 });
  },
});

export const count = query({
  args: { name: v.string() },
  handler: async (ctx, { name }) =>
    (
      await ctx.db
        .query("counts")
        .withIndex("name", (q) => q.eq("name", name))
        .unique()
    )?.n ?? 0,
});

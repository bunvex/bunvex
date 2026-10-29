import { v } from "@bunvex/values";
import { mutation, query } from "./_generated/server";

/** Add a task for the signed-in user. */
export const create = mutation({
  args: { text: v.string() },
  handler: async (ctx, { text }) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) throw new Error("Sign in to add a task");
    await ctx.db.insert("tasks", { text, author: user.name ?? "someone" });
  },
});

/** The signed-in user's tasks. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) throw new Error("Sign in to see your tasks");
    return await ctx.db
      .query("tasks")
      .withIndex("by_author", (q) => q.eq("author", user.name))
      .collect();
  },
});

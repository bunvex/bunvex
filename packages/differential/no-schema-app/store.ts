// The app's calls into `kv`.
import { v } from "convex/values";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";

export const put = mutation({
  args: { k: v.string() },
  handler: async (ctx, { k }) => {
    await ctx.runMutation(components.kv.lib.put, { k });
  },
});

export const byK = query({
  args: { k: v.string() },
  handler: async (ctx, { k }) => await ctx.runQuery(components.kv.lib.byK, { k }),
});

// What the suite reads and writes of the component's rows directly.
import { mutation, query } from "@bunvex/server";
import { v } from "@bunvex/values";

export const passwords = query({ args: {}, handler: async (ctx) => await ctx.db.query("passwords").collect() });

export const insertHash = mutation({
  args: { userId: v.string(), passwordHashPHC: v.string() },
  handler: async (ctx, row) => {
    await ctx.db.insert("passwords", row);
    return null;
  },
});

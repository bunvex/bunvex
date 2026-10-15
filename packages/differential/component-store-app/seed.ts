// Writes into the root and into both components, and reads a component back (Convex only).
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";

export const seed = mutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.insert("messages", { text: "root" });
    await ctx.runMutation(components.counter.lib.add, { body: "in counter" });
    await ctx.runMutation(components.second.lib.add, { body: "in second" });
  },
});

export const counterMessages = query({
  args: {},
  handler: async (ctx) => await ctx.runQuery(components.counter.lib.list, {}),
});

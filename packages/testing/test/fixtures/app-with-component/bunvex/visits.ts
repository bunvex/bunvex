import { componentsGeneric, mutation, query } from "@bunvex/server";

const components = componentsGeneric();

export const visit = mutation({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(components.counter.lib.add, { name: "visits" });
  },
});

export const visits = query({
  args: {},
  handler: async (ctx) => ctx.runQuery(components.counter.lib.count, { name: "visits" }),
});

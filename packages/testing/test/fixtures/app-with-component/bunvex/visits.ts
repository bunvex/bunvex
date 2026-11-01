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

/** A token the app signs, then the one its component signs (STUDY-192). */
export const tokens = mutation({
  args: {},
  handler: async (ctx) => ({
    app: await ctx.auth.signJwt({ claims: { sub: "app" }, expiresInSeconds: 60 }),
    component: await ctx.runMutation(components.counter.lib.sign, {}),
    now: Date.now(),
  }),
});

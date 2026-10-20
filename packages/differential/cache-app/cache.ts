// Queries whose cache behaviour the cache-metadata test compares (STUDY-174 §3): one that reads no time, one
// that reads the clock; and mutations that write into the first one's read set, and outside it.
import { mutationGeneric, queryGeneric } from "convex/server";

export const plain = queryGeneric({ args: {}, handler: async (ctx) => (await ctx.db.query("items").collect()).length });
export const clock = queryGeneric({
  args: {},
  handler: async (ctx) => (await ctx.db.query("items").collect()).length + (Date.now() > 0 ? 0 : 1),
});
export const add = mutationGeneric({ args: {}, handler: async (ctx) => void (await ctx.db.insert("items", {})) });
export const other = mutationGeneric({ args: {}, handler: async (ctx) => void (await ctx.db.insert("others", {})) });

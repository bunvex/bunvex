// The functions the routes of http.ts call (owner, 2026-10-21): `ins` writes a row under a tag, `rows` counts them.
import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const ins = mutationGeneric({
  args: { tag: v.string() },
  handler: async (ctx, { tag }) => ctx.db.insert("items", { tag }),
});

export const rows = queryGeneric({
  args: { tag: v.string(), nonce: v.number() },
  handler: async (ctx, { tag }) => (await ctx.db.query("items").collect()).filter((d) => d.tag === tag).length,
});

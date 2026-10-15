// A filter that fails on the values a test names (STUDY-161 §14): `neg` of `x`, `x` as the predicate, or `op(x, y)`;
// `field` takes a field no document has (undefined) in place of `x`.
import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const seed = mutationGeneric({
  args: {},
  handler: async (ctx) => {
    await ctx.db.insert("free", { k: 1 });
  },
});

export const run = queryGeneric({
  args: { op: v.string(), x: v.optional(v.any()), y: v.optional(v.any()), field: v.optional(v.boolean()) },
  handler: async (ctx, { op, x, y, field }) =>
    await ctx.db
      .query("free")
      // biome-ignore lint/suspicious/noExplicitAny: the operator is the test's
      .filter((q: any) => {
        const a = field ? q.field("missing") : x;
        if (op === "neg") return q.eq(q.neg(a), 0);
        if (op === "bool") return a;
        return q.eq(q[op](a, y), 0);
      })
      .collect(),
});

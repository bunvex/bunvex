// The functions of the subscription bench (bench/s184-invalidation.ts, STUDY-184 §5.6): the same as the
// bench's own server registers on bunvex.
import { mutationGeneric, queryGeneric } from "convex/server";

// `i` is not read: it makes each subscription its own execution.
export const watch = queryGeneric(async (ctx, { g }: { g: number; i: number }) =>
  ctx.db
    .query("docs")
    .withIndex("by_g", (q) => q.eq("g", g))
    .order("desc")
    .first(),
);

export const bump = mutationGeneric(async (ctx, { g, t }: { g: number; t: number }) => {
  await ctx.db.insert("docs", { g, t });
  return null;
});

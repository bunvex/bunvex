// The page cache's ballast (STUDY-174 Q6, §10.3): documents written before the workload and read once at its start,
// so SQLite's 256 MiB page cache (DV-550) is full before the memory rules judge, instead of filling for ~70 minutes
// with the store's growth.
import { mutationGeneric, paginationOptsValidator, queryGeneric } from "bunvex/server";
import { v } from "bunvex/values";

export const fill = mutationGeneric({
  args: { from: v.number(), count: v.number(), size: v.number() },
  handler: async (ctx, { from, count, size }) => {
    for (let i = from; i < from + count; i++) await ctx.db.insert("ballast", { body: `${i}:`.padEnd(size, "x") });
  },
});

export const read = queryGeneric({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const r = await ctx.db.query("ballast").paginate(paginationOpts);
    return { n: r.page.length, isDone: r.isDone, continueCursor: r.continueCursor };
  },
});

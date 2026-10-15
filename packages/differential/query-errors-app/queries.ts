// A query of any table and index, by name, each way it can start (STUDY-161 §5): `collect`, `first`, a `for await`,
// `paginate`, and a search; with a range, or a bad limit before everything else.
import { queryGeneric } from "convex/server";
import { v } from "convex/values";

export const run = queryGeneric({
  args: {
    table: v.string(),
    index: v.optional(v.string()),
    how: v.union(
      v.literal("collect"),
      v.literal("first"),
      v.literal("iterate"),
      v.literal("paginate"),
      v.literal("search"),
      v.literal("range"),
      v.literal("limit"),
    ),
  },
  handler: async (ctx, { table, index, how }) => {
    const q = ctx.db.query(table as any) as any;
    if (how === "search") return await q.withSearchIndex(index, (s: any) => s.search("body", "x")).collect();
    if (how === "range") return await q.withIndex(index, (r: any) => r.eq("k", 1)).collect();
    const source = index === undefined ? q : q.withIndex(index);
    if (how === "limit") return await source.limit(-1).collect();
    if (how === "first") return await source.first();
    if (how === "paginate") return await source.paginate({ numItems: 2, cursor: null });
    if (how === "iterate") {
      const rows = [];
      for await (const d of source) rows.push(d);
      return rows;
    }
    return await source.collect();
  },
});

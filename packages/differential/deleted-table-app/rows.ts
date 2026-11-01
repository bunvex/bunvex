// The app of test/deleted-table-window.test.ts: a document in any table, and an id read back as another table's.
import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const put = mutationGeneric({
  args: { table: v.string() },
  // biome-ignore lint/suspicious/noExplicitAny: tables made at run time, no schema
  handler: async (ctx, { table }) => ctx.db.insert(table as any, { n: 1 } as any),
});

export const normalize = queryGeneric({
  args: { table: v.string(), id: v.string() },
  // biome-ignore lint/suspicious/noExplicitAny: as above
  handler: async (ctx, { table, id }) => ctx.db.normalizeId(table as any, id),
});

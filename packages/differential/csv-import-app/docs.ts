// A table's documents without their system fields, sorted, for csv-import.test.ts.
import { queryGeneric } from "convex/server";
import { v } from "convex/values";

export const all = queryGeneric({
  args: { table: v.string() },
  handler: async ({ db }, { table }) => {
    const rows = await db.query(table as never).collect();
    return rows.map(({ _id, _creationTime, ...rest }) => JSON.stringify(rest, Object.keys(rest).sort())).sort();
  },
});

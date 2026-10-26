// A document with more fields than a shape's object holds (`MAX_OBJECT_FIELDS`, 64): its shape is a record.
import { mutationGeneric } from "convex/server";
import { v } from "convex/values";

export const insert = mutationGeneric({
  args: { table: v.string() },
  handler: async ({ db }, { table }) =>
    db.insert(table as never, Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`f${i}`, i])) as never),
});

export const clear = mutationGeneric({
  args: { table: v.string() },
  handler: async ({ db }, { table }) => {
    for (const d of await db.query(table as never).collect()) await db.delete(d._id);
  },
});

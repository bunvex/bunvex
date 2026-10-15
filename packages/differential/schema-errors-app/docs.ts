// Writes a schema refuses (STUDY-161 §3): `db.insert(table, doc)`, or a patch / replace of a valid document.
import { mutationGeneric } from "convex/server";
import { v } from "convex/values";

export const insert = mutationGeneric({
  args: { table: v.string(), doc: v.any() },
  handler: async (ctx, { table, doc }) => {
    await ctx.db.insert(table as "strict", doc);
  },
});

/** A valid `strict` document, then `method` with `value`; `unset` names fields the patch removes. */
export const write = mutationGeneric({
  args: {
    method: v.union(v.literal("patch"), v.literal("replace")),
    value: v.any(),
    unset: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { method, value, unset }) => {
    const id = await ctx.db.insert("strict", { name: "x", n: 1 });
    const fields = { ...value };
    for (const k of unset ?? []) fields[k] = undefined;
    await (method === "patch" ? ctx.db.patch(id, fields) : ctx.db.replace(id, fields));
  },
});

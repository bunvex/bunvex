// A write that gives `_id` or `_creationTime` a value of its own (STUDY-161 §4): an insert of `value`, or a patch or
// replace of a new `{k: 1, gone: true}` document; `unset` names fields the patch removes.
import { mutationGeneric } from "convex/server";
import { v } from "convex/values";

export const write = mutationGeneric({
  args: {
    method: v.union(v.literal("insert"), v.literal("patch"), v.literal("replace")),
    value: v.any(),
    unset: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { method, value, unset }) => {
    if (method === "insert") {
      await ctx.db.insert("free", value);
      return;
    }
    const id = await ctx.db.insert("free", { k: 1, gone: true });
    const fields = { ...value };
    for (const k of unset ?? []) fields[k] = undefined;
    await (method === "patch" ? ctx.db.patch(id, fields) : ctx.db.replace(id, fields));
  },
});

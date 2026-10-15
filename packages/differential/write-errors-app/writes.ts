// `db.insert` / `db.patch` / `db.replace` / `db.count` called with the arguments a test names (STUDY-161 §1, §2).
import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

/** `db.insert(table, value)`; `omit` leaves the value out, `depth` nests `{a: …}` that many levels around 1. */
export const insert = mutationGeneric({
  args: { table: v.string(), value: v.optional(v.any()), omit: v.optional(v.boolean()), depth: v.optional(v.number()) },
  handler: async (ctx, { table, value, omit, depth }) => {
    let x: unknown = value;
    if (depth !== undefined) {
      x = 1;
      for (let i = 0; i < depth; i++) x = { a: x };
    }
    const db = ctx.db as unknown as { insert: (...a: unknown[]) => Promise<unknown> };
    await (omit ? db.insert(table) : db.insert(table, x));
  },
});

/** `db.table(table).insert({})`. */
export const insertScoped = mutationGeneric({
  args: { table: v.string() },
  handler: async (ctx, { table }) => {
    await (ctx.db as unknown as { table: (t: string) => { insert: (v: object) => Promise<unknown> } })
      .table(table)
      .insert({});
  },
});

/** `db.patch` or `db.replace` of a new document with `value`; `omit` leaves the value out. */
export const write = mutationGeneric({
  args: { method: v.union(v.literal("patch"), v.literal("replace")), value: v.any(), omit: v.optional(v.boolean()) },
  handler: async (ctx, { method, value, omit }) => {
    const id = await ctx.db.insert("free", { k: 1 });
    const db = ctx.db as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    await (omit ? db[method]!(id) : db[method]!(id, value));
  },
});

export const count = queryGeneric({
  args: { table: v.string() },
  handler: async (ctx, { table }) =>
    await (ctx.db.query(table as never) as unknown as { count: () => Promise<number> }).count(),
});

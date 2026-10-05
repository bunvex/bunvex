// The differential app (STUDY-129): operations as data, so one generated sequence runs unchanged on Convex
// and on bunvex. Written from scratch for this harness. Every operation's outcome is returned, in order;
// a `throw` operation makes the whole mutation fail after what it wrote (nothing of it may stay).
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

type Range = { field: string; op: "eq" | "gt" | "gte" | "lt" | "lte"; value: unknown }[];
type Read = { table: "a" | "b"; index?: string; range?: Range; order?: "asc" | "desc"; take?: number };
type Op =
  | { kind: "insert"; table: "a" | "b"; doc: Record<string, unknown> }
  | { kind: "patch"; id: string; fields: Record<string, unknown> }
  | { kind: "replace"; id: string; doc: Record<string, unknown> }
  | { kind: "delete"; id: string }
  | { kind: "get"; id: string }
  | { kind: "read"; read: Read; mutateResult?: boolean }
  | { kind: "throw"; message: string }
  // Puts `undefined` in the result: the mutation's result is then not a value, so it must fail whole.
  | { kind: "undefinedResult" };

// biome-ignore lint/suspicious/noExplicitAny: the database reader of either backend
async function runRead(db: any, r: Read) {
  let q = db.query(r.table);
  if (r.index)
    // biome-ignore lint/suspicious/noExplicitAny: an index range builder
    q = q.withIndex(r.index, (b: any) => {
      for (const c of r.range ?? []) b = b[c.op](c.field, c.value);
      return b;
    });
  if (r.order) q = q.order(r.order);
  return r.take === undefined ? await q.collect() : await q.take(r.take);
}

/** Apply `ops` in one transaction; the outcome of each, in order. */
export const apply = mutation({
  args: { ops: v.any() },
  handler: async (ctx, { ops }) => {
    const out: unknown[] = [];
    for (const op of ops as Op[]) {
      switch (op.kind) {
        case "insert":
          out.push(await ctx.db.insert(op.table, op.doc));
          break;
        case "patch":
          // biome-ignore lint/suspicious/noExplicitAny: ids of either table
          out.push((await ctx.db.patch(op.id as any, op.fields)) ?? null);
          break;
        case "replace":
          // biome-ignore lint/suspicious/noExplicitAny: ids of either table
          out.push((await ctx.db.replace(op.id as any, op.doc)) ?? null);
          break;
        case "delete":
          // biome-ignore lint/suspicious/noExplicitAny: ids of either table
          out.push((await ctx.db.delete(op.id as any)) ?? null);
          break;
        case "get":
          // biome-ignore lint/suspicious/noExplicitAny: ids of either table
          out.push(await ctx.db.get(op.id as any));
          break;
        case "read": {
          const docs = await runRead(ctx.db, op.read);
          out.push(docs);
          // The #410 shape: mutating what a query returned must change nothing that is stored.
          if (op.mutateResult)
            for (const d of docs as Record<string, unknown>[]) {
              d.mutated = true;
              if ("k" in d) d.k = "mutated";
            }
          break;
        }
        case "throw":
          throw new Error(op.message);
        case "undefinedResult":
          out.push(undefined);
          break;
      }
    }
    return out;
  },
});

/** A read at the latest snapshot. */
export const read = query({
  args: { read: v.any() },
  handler: (ctx, { read }) => runRead(ctx.db, read as Read),
});

/** Every document of every table, in `_creationTime` order. */
export const dump = query({
  args: {},
  handler: async (ctx) => ({ a: await ctx.db.query("a").collect(), b: await ctx.db.query("b").collect() }),
});

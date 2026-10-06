// The differential app (STUDY-122): operations as data, so one generated sequence runs unchanged on Convex
// and on bunvex. Written from scratch for this harness. Every operation's outcome is returned, in order;
// a `throw` operation makes the whole mutation fail after what it wrote (nothing of it may stay).
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

type Bound = { field: string; op: "eq" | "gt" | "gte" | "lt" | "lte"; value: unknown };
type Filter = { field: string; op: "eq" | "neq" | "gt" | "lt"; value: unknown };
type Read = {
  table: "a" | "b";
  index?: string;
  range?: Bound[];
  filter?: Filter;
  order?: "asc" | "desc";
  /** How the query ends: every document (default), the first `take`, the first one, or the only one. */
  mode?: "collect" | "take" | "first" | "unique";
  take?: number;
};
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

/**
 * JSON has no `undefined`: the programs write `{ $undefined: true }` where a field is `undefined` (a patch
 * that removes it, a document field left out).
 */
function revive(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(revive);
  if (x && typeof x === "object") {
    if ((x as { $undefined?: unknown }).$undefined === true && Object.keys(x).length === 1) return undefined;
    return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, revive(y)]));
  }
  return x;
}

// biome-ignore lint/suspicious/noExplicitAny: the database reader of either backend
function buildQuery(db: any, r: Read) {
  let q = db.query(r.table);
  if (r.index)
    // biome-ignore lint/suspicious/noExplicitAny: an index range builder
    q = q.withIndex(r.index, (b: any) => {
      for (const c of r.range ?? []) b = b[c.op](c.field, revive(c.value));
      return b;
    });
  if (r.order) q = q.order(r.order);
  const f = r.filter;
  // biome-ignore lint/suspicious/noExplicitAny: a filter builder
  if (f) q = q.filter((x: any) => x[f.op](x.field(f.field), revive(f.value)));
  return q;
}

// biome-ignore lint/suspicious/noExplicitAny: the database reader of either backend
async function runRead(db: any, r: Read) {
  const q = buildQuery(db, r);
  switch (r.mode ?? (r.take === undefined ? "collect" : "take")) {
    case "take":
      return await q.take(r.take ?? 1);
    case "first":
      return await q.first();
    case "unique":
      return await q.unique();
    default:
      return await q.collect();
  }
}

/** Apply `ops` in one transaction; the outcome of each, in order. */
export const apply = mutation({
  args: { ops: v.any() },
  handler: async (ctx, { ops }) => {
    const out: unknown[] = [];
    for (const raw of ops as Op[]) {
      const op = revive(raw) as Op;
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
          const got = await runRead(ctx.db, op.read);
          out.push(got);
          // The #410 shape: mutating what a query returned must change nothing that is stored.
          if (op.mutateResult)
            for (const d of (Array.isArray(got) ? got : got ? [got] : []) as Record<string, unknown>[]) {
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
  handler: (ctx, { read }) => runRead(ctx.db, revive(read) as Read),
});

/** A page of a read, from `cursor` (null: the start). */
export const page = query({
  args: { read: v.any(), numItems: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: (ctx, { read, numItems, cursor }) => buildQuery(ctx.db, revive(read) as Read).paginate({ numItems, cursor }),
});

/** Every document of every table, in `_creationTime` order. */
export const dump = query({
  args: {},
  handler: async (ctx) => ({ a: await ctx.db.query("a").collect(), b: await ctx.db.query("b").collect() }),
});

/** Delete every document, so the next program starts from empty tables. */
export const reset = mutation({
  args: {},
  handler: async (ctx) => {
    for (const t of ["a", "b"] as const) for (const d of await ctx.db.query(t).collect()) await ctx.db.delete(d._id);
    return null;
  },
});

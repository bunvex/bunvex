// The differential app (STUDY-122): operations as data, so one generated sequence runs unchanged on Convex
// and on bunvex. Written from scratch for this harness. Every operation's outcome is returned, in order;
// a `throw` operation makes the whole mutation fail after what it wrote (nothing of it may stay).
import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import { action, mutation, query } from "./_generated/server";

// References to this module's functions, for the nested calls (no generated `api` needed).
const applyRef = makeFunctionReference<"mutation">("ops:apply");
const readRef = makeFunctionReference<"query">("ops:read");
const deepRef = makeFunctionReference<"mutation">("ops:deep");

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
  /** Throws an application error carrying `data` (Convex's `ConvexError`). */
  | { kind: "throwData"; data: unknown }
  /** `ctx.runMutation` of `apply` with `ops`: a sub-transaction; `catch` turns its error into an outcome. */
  | { kind: "nested"; ops: Op[]; catch?: boolean }
  /** `ctx.runQuery` of `read`: it sees this transaction's writes. */
  | { kind: "runQuery"; read: Read }
  /** A write past one of the limits (built here: the arguments could not carry it). */
  | { kind: "limit"; which: number; catch?: boolean }
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

/** What a caught error leaves to compare: its message and its data. */
function caught(e: unknown) {
  const err = e as { message?: unknown; data?: unknown };
  return { caught: String(err.message), ...(err.data === undefined ? {} : { data: err.data }) };
}

/** A nested value `depth` levels deep. */
const nest = (depth: number): unknown => (depth === 0 ? 1 : { d: nest(depth - 1) });

/** The writes past each limit Convex enforces on documents, and the call depth. */
// biome-ignore lint/suspicious/noExplicitAny: the context of either backend
async function pastLimit(ctx: any, which: number): Promise<unknown> {
  switch (which) {
    case 0:
      return await ctx.db.insert("a", { $bad: 1 });
    case 1:
      return await ctx.db.insert("a", { _bad: 1 });
    case 2:
      return await ctx.db.insert("a", { deep: nest(17) });
    case 3:
      return await ctx.db.insert("a", { list: Array.from({ length: 8193 }, (_, i) => i) });
    case 4:
      return await ctx.db.insert("a", Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [`f${i}`, i])));
    case 5:
      return await ctx.db.insert("a", { big: "x".repeat(1_100_000) });
    case 6:
      return await ctx.db.insert("a", { ["k".repeat(1025)]: 1 });
    case 7:
      return await ctx.db.insert("nope", { k: 1 });
    case 8:
      return await ctx.db.insert("a", { k: "\ud800" });
    case 9:
      return await ctx.runMutation(deepRef, { n: 9 });
    default:
      return await ctx.runMutation(deepRef, { n: 7 });
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
        case "throwData":
          throw new ConvexError(op.data as never);
        case "nested":
          if (op.catch)
            try {
              out.push(await ctx.runMutation(applyRef, { ops: op.ops }));
            } catch (e) {
              out.push(caught(e));
            }
          else out.push(await ctx.runMutation(applyRef, { ops: op.ops }));
          break;
        case "runQuery":
          out.push(await ctx.runQuery(readRef, { read: op.read }));
          break;
        case "limit":
          if (op.catch)
            try {
              out.push(await pastLimit(ctx, op.which));
            } catch (e) {
              out.push(caught(e));
            }
          else out.push(await pastLimit(ctx, op.which));
          break;
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

/** `n` levels of nested mutations, each inserting one document: past 8 levels, the depth limit. */
export const deep = mutation({
  args: { n: v.number() },
  handler: async (ctx, { n }): Promise<number> => {
    await ctx.db.insert("b", { x: n });
    return n === 0 ? 0 : 1 + (await ctx.runMutation(deepRef, { n: n - 1 }));
  },
});

/** A mutation with validated arguments and result: `bad` returns what the validator refuses. */
export const typed = mutation({
  args: { n: v.number(), s: v.optional(v.string()), bad: v.optional(v.boolean()) },
  returns: v.number(),
  handler: async (ctx, { n, bad }) => {
    await ctx.db.insert("b", { x: n });
    return (bad ? "not a number" : n) as number;
  },
});

type Step =
  | { kind: "query"; read: Read }
  | { kind: "mutation"; ops: Op[]; catch?: boolean }
  | { kind: "throw"; message: string }
  | { kind: "throwData"; data: unknown };

/** An action: queries and mutations, each its own transaction, then maybe a failure (the writes stay). */
export const act = action({
  args: { steps: v.any() },
  handler: async (ctx, { steps }) => {
    const out: unknown[] = [];
    for (const step of steps as Step[]) {
      switch (step.kind) {
        case "query":
          out.push(await ctx.runQuery(readRef, { read: step.read }));
          break;
        case "mutation":
          if (step.catch)
            try {
              out.push(await ctx.runMutation(applyRef, { ops: step.ops }));
            } catch (e) {
              out.push(caught(e));
            }
          else out.push(await ctx.runMutation(applyRef, { ops: step.ops }));
          break;
        case "throw":
          throw new Error(step.message);
        case "throwData":
          throw new ConvexError(step.data as never);
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
  handler: async (ctx) => ({
    a: await ctx.db.query("a").collect(),
    b: await ctx.db.query("b").collect(),
    // A table no schema declares: a write there is accepted (the `limit` op's case 7).
    // biome-ignore lint/suspicious/noExplicitAny: a table the schema does not name
    nope: await ctx.db.query("nope" as any).collect(),
  }),
});

/** Delete every document, so the next program starts from empty tables. */
export const reset = mutation({
  args: {},
  handler: async (ctx) => {
    // biome-ignore lint/suspicious/noExplicitAny: `nope` is not in the schema
    for (const t of ["a", "b", "nope"] as const)
      for (const d of await ctx.db.query(t as any).collect()) await ctx.db.delete(d._id);
    return null;
  },
});

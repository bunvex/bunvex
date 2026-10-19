// The app of the read-count tests (STUDY-161 §16): a function that reads documents by id, then runs a list of
// operations described as data (`run`), as a query or a mutation; a second module for a nested call to another.
import { anyApi, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const fill = mutationGeneric({
  args: { table: v.string(), n: v.number(), from: v.optional(v.number()) },
  handler: async (ctx, { table, n, from }) => {
    for (let i = 0; i < n; i++) await ctx.db.insert(table as any, { i: (from ?? 0) + i, k: i % 7 });
  },
});

export const ids = queryGeneric({
  args: { n: v.number() },
  handler: async (ctx, { n }) => (await ctx.db.query("big").withIndex("by_i").take(n)).map((d) => d._id),
});

type Op = [string, ...any[]];
async function run(ctx: any, ids: string[], ops: Op[]) {
  const db = ctx.db;
  for (const id of ids) await db.get(id);
  const id = (x: any) => (typeof x === "string" ? x : ids[x]);
  let cursor: string | null = null;
  const made: string[] = [];
  for (const [op, a, b, c] of ops) {
    if (op === "get") await db.get(id(a));
    else if (op === "getMade") await db.get(made[a]);
    else if (op === "insert") made.push(await db.insert(a, { k: 1 }));
    else if (op === "patch") await db.patch(id(a), { p: 1 });
    else if (op === "patchMade") await db.patch(made[a], { p: 1 });
    else if (op === "replace") await db.replace(id(a), { i: -1 });
    else if (op === "delete") await db.delete(id(a));
    else if (op === "take") await db.query(a).take(b);
    else if (op === "first") await db.query(a).first();
    else if (op === "collect") await db.query(a).collect();
    else if (op === "eq")
      await db
        .query(a)
        .withIndex(b, (q: any) => q.eq(b === "by_k" ? "k" : "i", c))
        .collect();
    else if (op === "range")
      await db
        .query(a)
        .withIndex(b, (q: any) => q.gte("i", c[0]).lt("i", c[1]))
        .collect();
    else if (op === "desc") await db.query(a).order("desc").first();
    else if (op === "page") {
      const r: any = await db.query(a).withIndex(b).paginate({ numItems: c, cursor });
      cursor = r.continueCursor;
    } else if (op === "filter")
      await db
        .query(a)
        .filter((q: any) => q.eq(q.field("k"), 99))
        .collect();
    else if (op === "unique")
      await db
        .query(a)
        .withIndex("by_k", (q: any) => q.eq("k", 100))
        .unique();
    else if (op === "count") await db.query(a).count();
    else if (op === "system") await db.system.query("_scheduled_functions").first();
    else if (op === "systemGet") await db.system.get(a);
    else if (op === "normalize") db.normalizeId(a, ids[0]);
    else if (op === "search")
      await db
        .query(a)
        .withSearchIndex("s", (q: any) => q.search("t", b))
        .collect();
    else if (op === "runQ") await ctx.runQuery(anyApi.reads.q, { ids: [], ops: a });
    else if (op === "runQids") await ctx.runQuery(anyApi.reads.q, { ids: ids.slice(0, a), ops: [] });
    else if (op === "runOther") await ctx.runQuery(anyApi.other.q, {});
    else if (op === "runM") await ctx.runMutation(anyApi.reads.m, { ids: [], ops: a });
    else if (op === "schedule") await ctx.scheduler.runAfter(1000, "reads:noop" as any, {});
    else throw new Error(`unknown op ${op}`);
  }
}

export const m = mutationGeneric({
  args: { ids: v.array(v.string()), ops: v.any() },
  handler: async (ctx, { ids, ops }) => {
    await run(ctx, ids, ops);
    return null;
  },
});
export const q = queryGeneric({
  args: { ids: v.array(v.string()), ops: v.any() },
  handler: async (ctx, { ids, ops }) => {
    await run(ctx, ids, ops);
    return null;
  },
});
export const noop = mutationGeneric({ args: {}, handler: async () => null });

export const fillText = mutationGeneric({
  args: {},
  handler: async (ctx) => {
    for (let i = 0; i < 10; i++) await ctx.db.insert("small" as any, { k: 50 + i, t: `hello world ${i}` });
  },
});

/** A nested query with a budget of `budget` reads (`transactionLimits`): its error, or how many it read. */
export const budgeted = queryGeneric({
  args: { budget: v.number(), ops: v.any() },
  handler: async (ctx, { budget, ops }) => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: Convex's options argument is internal in its types
      await (ctx.runQuery as any)(anyApi.reads.q, { ids: [], ops }, { transactionLimits: { databaseQueries: budget } });
      return "ok";
    } catch (e) {
      return (e as Error).message.split("\n")[0];
    }
  },
});

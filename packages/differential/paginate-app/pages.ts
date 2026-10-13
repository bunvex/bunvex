// The app of test/paginate-args.test.ts: a page read with options given as JSON (a few tokens stand for what
// JSON cannot carry), its error caught and returned as `<name>: <message>`.
import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

const TOKENS: Record<string, unknown> = {
  $NaN: Number.NaN,
  $Infinity: Number.POSITIVE_INFINITY,
  "$-Infinity": Number.NEGATIVE_INFINITY,
  "$-0": -0,
  $bigint: 5n,
  $undefined: undefined,
};
const decode = (x: unknown) => (typeof x === "string" && x in TOKENS ? TOKENS[x] : x);

export const add = mutationGeneric({
  args: { n: v.number() },
  handler: async (ctx, { n }) => {
    for (let i = 0; i < n; i++) await ctx.db.insert("items", { i });
  },
});

export const page = queryGeneric({
  args: { opts: v.any(), raw: v.optional(v.string()) },
  handler: async (ctx, { opts, raw }) => {
    const o =
      raw === "undefined"
        ? undefined
        : raw === "null"
          ? null
          : Object.fromEntries(Object.entries(opts as Record<string, unknown>).map(([k, x]) => [k, decode(x)]));
    try {
      const p = await ctx.db.query("items").paginate(o as never);
      return { page: p.page.length, isDone: p.isDone };
    } catch (e) {
      return `${(e as Error).name}: ${(e as Error).message}`;
    }
  },
});

/** A page from a cursor given as it is. */
export const tamperedCursor = queryGeneric({
  args: { cursor: v.string() },
  handler: async (ctx, { cursor }) => {
    try {
      await ctx.db.query("items").paginate({ numItems: 1, cursor });
      return "ok";
    } catch (e) {
      return `${(e as Error).name}: ${(e as Error).message}`;
    }
  },
});

/** A query with `limit(n)`, collected or paged: the query's own argument check. */
export const limited = queryGeneric({
  args: { n: v.any(), page: v.boolean() },
  handler: async (ctx, { n, page }) => {
    try {
      const q = ctx.db.query("items").limit(decode(n) as number);
      if (page) await q.paginate({ numItems: 1, cursor: null });
      else await q.collect();
      return "ok";
    } catch (e) {
      return `${(e as Error).name}: ${(e as Error).message}`;
    }
  },
});

// A query or mutation whose returned promise can never resolve (STUDY-188 §X16), as Convex's own tests
// (`udf-tests/convex/asyncTests.ts`, `neverResolves`), and handlers that wait on real work and must not be taken for
// one: reads chained one after the other, a nested call, `crypto.subtle`. `seed` writes the rows they read.
import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

const forever = () => new Promise<never>(() => {});

export const neverQuery = queryGeneric({ args: {}, handler: async () => forever() });

export const neverMutation = mutationGeneric({
  args: {},
  handler: async ({ db }) => {
    await db.insert("rows", { n: -1 });
    return forever();
  },
});

/** Never resolves after a read: the read is answered, and nothing is left that could resolve it. */
export const neverAfterRead = queryGeneric({
  args: {},
  handler: async ({ db }) => {
    await db.query("rows").first();
    return forever();
  },
});

/** A nested query that never resolves: it fails, in its caller. */
export const neverNested = queryGeneric({
  args: {},
  handler: async (ctx) => ctx.runQuery("ops:neverQuery" as never),
});

export const neverNestedCaught = queryGeneric({
  args: {},
  handler: async (ctx) => {
    try {
      await ctx.runQuery("ops:neverQuery" as never);
      return "not caught";
    } catch (e) {
      return {
        name: (e as Error).name,
        message: (e as Error).message,
        rows: (await ctx.db.query("rows").collect()).length,
      };
    }
  },
});

export const seed = mutationGeneric({
  args: { n: v.number() },
  handler: async ({ db }, { n }) => {
    for (let i = 0; i < n; i++) await db.insert("rows", { n: i });
  },
});

/** Reads one after the other, each started by the previous one's answer: never idle in between. */
export const chained = queryGeneric({
  args: {},
  handler: async ({ db }) => {
    const out: number[] = [];
    let last = -1;
    for (let i = 0; i < 5; i++) {
      const d = await db
        .query("rows")
        .filter((q) => q.gt(q.field("n"), last))
        .first();
      if (!d) break;
      last = d.n as number;
      out.push(last);
    }
    const all = await Promise.all([db.query("rows").collect(), db.query("rows").order("desc").first()]);
    return { out, rows: all[0].length };
  },
});

export const chainedMutation = mutationGeneric({
  args: {},
  handler: async (ctx) => {
    const first = await ctx.db.query("rows").first();
    const id = await ctx.db.insert("rows", { n: 100 });
    const back = await ctx.db.get(id);
    const nested = await ctx.runQuery("ops:chained" as never);
    const stale = await ctx.runQuery("ops:chained" as never, {}, { useStaleSnapshot: true } as never);
    await ctx.db.delete(id);
    return { first: first?.n ?? null, back: back?.n ?? null, nested, stale };
  },
});

export const digest = queryGeneric({
  args: {},
  handler: async () => {
    // Large enough that Bun answers it from its thread pool, turns of the event loop later.
    const d = await crypto.subtle.digest("SHA-256", new Uint8Array(8 * 1024 * 1024));
    return [...new Uint8Array(d)].slice(0, 4);
  },
});

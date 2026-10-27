// The component's pages: its own table paginated, once, twice, then failing; and its writes.
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const shape = (p: { page: { n: number }[]; isDone: boolean }) => ({ ns: p.page.map((d) => d.n), isDone: p.isDone });

export const page = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const p = shape(await ctx.db.query("items").withIndex("by_n").paginate(paginationOpts));
    console.log("pager page", p.ns.length);
    return p;
  },
});

/** The page with its cursors, for a caller to go on with. */
export const rawPage = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => await ctx.db.query("items").withIndex("by_n").paginate(paginationOpts),
});

/** Two pages in one query: the second refused, caught here. */
export const pageTwice = query({
  args: {},
  handler: async (ctx) => {
    const first = shape(await ctx.db.query("items").withIndex("by_n").paginate({ numItems: 1, cursor: null }));
    try {
      await ctx.db.query("items").withIndex("by_n").paginate({ numItems: 1, cursor: null });
      return { first, second: "ran" };
    } catch (e) {
      return { first, caught: (e as Error).message };
    }
  },
});

/** A page, its error caught here: what the component sees of its own `paginate()`. */
export const pageCaught = query({
  args: {},
  handler: async (ctx) => {
    try {
      return { ok: shape(await ctx.db.query("items").withIndex("by_n").paginate({ numItems: 1, cursor: null })) };
    } catch (e) {
      return { caught: (e as Error).message };
    }
  },
});

/** A page, then a failure: the page does not count for the caller. */
export const pageThenThrow = query({
  args: {},
  handler: async (ctx) => {
    await ctx.db.query("items").withIndex("by_n").paginate({ numItems: 1, cursor: null });
    throw new Error("after the page");
  },
});

/** No page at all: a plain read. */
export const count = query({ args: {}, handler: async (ctx) => (await ctx.db.query("items").collect()).length });

export const insert = mutation({
  args: { n: v.number() },
  handler: async (ctx, { n }) => {
    await ctx.db.insert("items", { n });
  },
});

/** A mutation pages as often as it likes. */
export const pageInMutation = mutation({
  args: {},
  handler: async (ctx) => {
    const a = shape(await ctx.db.query("items").withIndex("by_n").paginate({ numItems: 1, cursor: null }));
    const b = shape(await ctx.db.query("items").withIndex("by_n").paginate({ numItems: 2, cursor: null }));
    return { a, b };
  },
});

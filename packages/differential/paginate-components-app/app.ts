// The app's pages: its own and `pager`'s, from queries and mutations, in each order (Convex d7402d6, 8449d41).
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { mutation, type QueryCtx, query } from "./_generated/server";

const own = (ctx: QueryCtx) => ctx.db.query("rows").withIndex("by_n").paginate({ numItems: 1, cursor: null });
const err = (e: unknown) => (e as Error).message;

export const seed = mutation({
  args: { ns: v.array(v.number()) },
  handler: async (ctx, { ns }) => {
    for (const n of ns) {
      await ctx.db.insert("rows", { n });
      await ctx.runMutation(components.pager.lib.insert, { n });
    }
  },
});

export const insertItem = mutation({
  args: { n: v.number() },
  handler: async (ctx, { n }) => {
    await ctx.runMutation(components.pager.lib.insert, { n });
  },
});

/** The component's page, as the app's query: reactive, as a page of the app's own. */
export const viaComponent = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => await ctx.runQuery(components.pager.lib.page, { paginationOpts }),
});

/** The component's page, its cursors passed on: the next pages from them. */
export const rawViaComponent = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => await ctx.runQuery(components.pager.lib.rawPage, { paginationOpts }),
});

/** A plain read in the component first, then its page. */
export const countThenPage = query({
  args: {},
  handler: async (ctx) => {
    const count = await ctx.runQuery(components.pager.lib.count, {});
    const page = await ctx.runQuery(components.pager.lib.page, { paginationOpts: { numItems: 2, cursor: null } });
    const after = await ctx.runQuery(components.pager.lib.count, {});
    return { count, page, after };
  },
});

export const appThenComponent = query({
  args: {},
  handler: async (ctx) => {
    await own(ctx);
    try {
      return {
        second: await ctx.runQuery(components.pager.lib.page, { paginationOpts: { numItems: 1, cursor: null } }),
      };
    } catch (e) {
      return { caught: err(e) };
    }
  },
});

/** The app's page, then the component's, which catches its own error if it sees one. */
export const appThenComponentCaught = query({
  args: {},
  handler: async (ctx) => {
    await own(ctx);
    try {
      return { second: await ctx.runQuery(components.pager.lib.pageCaught, {}) };
    } catch (e) {
      return { caught: err(e) };
    }
  },
});

export const appThenComponentUncaught = query({
  args: {},
  handler: async (ctx) => {
    await own(ctx);
    return await ctx.runQuery(components.pager.lib.page, { paginationOpts: { numItems: 1, cursor: null } });
  },
});

export const componentThenApp = query({
  args: {},
  handler: async (ctx) => {
    const first = await ctx.runQuery(components.pager.lib.page, { paginationOpts: { numItems: 1, cursor: null } });
    try {
      await own(ctx);
      return { first, second: "ran" };
    } catch (e) {
      return { first, caught: err(e) };
    }
  },
});

export const componentThenAppUncaught = query({
  args: {},
  handler: async (ctx) => {
    await ctx.runQuery(components.pager.lib.page, { paginationOpts: { numItems: 1, cursor: null } });
    return await own(ctx);
  },
});

export const componentTwice = query({
  args: {},
  handler: async (ctx) => {
    const first = await ctx.runQuery(components.pager.lib.page, { paginationOpts: { numItems: 1, cursor: null } });
    try {
      return {
        first,
        second: await ctx.runQuery(components.pager.lib.page, { paginationOpts: { numItems: 1, cursor: null } }),
      };
    } catch (e) {
      return { first, caught: err(e) };
    }
  },
});

export const twiceInComponent = query({
  args: {},
  handler: async (ctx) => await ctx.runQuery(components.pager.lib.pageTwice, {}),
});

/** The component pages, then fails: the caller catches it and pages itself. */
export const failedThenApp = query({
  args: {},
  handler: async (ctx) => {
    let caught: string | null = null;
    try {
      await ctx.runQuery(components.pager.lib.pageThenThrow, {});
    } catch (e) {
      caught = err(e);
    }
    try {
      const p = await own(ctx);
      return { caught, own: p.page.map((d) => d.n) };
    } catch (e) {
      return { caught, ownCaught: err(e) };
    }
  },
});

/** A mutation: the component's queries page once each, the app pages too, and the component's mutation pages twice. */
export const fromMutation = mutation({
  args: {},
  handler: async (ctx) => {
    const a = await ctx.runQuery(components.pager.lib.page, { paginationOpts: { numItems: 1, cursor: null } });
    const b = await ctx.runQuery(components.pager.lib.page, { paginationOpts: { numItems: 2, cursor: null } });
    const mine = (await own(ctx)).page.map((d) => d.n);
    const m = await ctx.runMutation(components.pager.lib.pageInMutation, {});
    let twice: unknown;
    try {
      twice = await ctx.runQuery(components.pager.lib.pageTwice, {});
    } catch (e) {
      twice = { caught: err(e) };
    }
    return { a, b, mine, m, twice };
  },
});

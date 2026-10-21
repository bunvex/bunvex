// The pagination half of test/helpers-stream.test.ts (STUDY-181 PR 4): convex-helpers' `getPage` and `paginator`
// (`convex-helpers/server/pagination` 0.1.128 on Convex's backend; the harness points bunvex's copy at
// `@bunvex/helpers/server/pagination`) over the documents `streams:seed` writes. Each answer gives the documents by
// their `n`, and every raw index key as text, with each backend's ids and creation times replaced by labels.
// biome-ignore-all lint/suspicious/noExplicitAny: requests are built from the test's arguments, typed loosely
import { queryGeneric } from "convex/server";
import { v } from "convex/values";
import { getPage, paginator } from "convex-helpers/server/pagination";
import schema from "./schema";

/** A raw index key as text: what JSON cannot say (`undefined`, int64, -0, NaN, ±Infinity, bytes) tagged. */
function keyText(key: unknown[]): string {
  const tag = (x: unknown): unknown => {
    if (x === undefined) return { $undefined: true };
    if (typeof x === "bigint") return { $int64: String(x) };
    if (typeof x === "number" && (!Number.isFinite(x) || Object.is(x, -0)))
      return { $float: Object.is(x, -0) ? "-0" : String(x) };
    // By its tag, not `instanceof`: on bunvex a document's bytes are an ArrayBuffer of another realm (reported apart).
    if (Object.prototype.toString.call(x) === "[object ArrayBuffer]")
      return { $bytes: [...new Uint8Array(x as ArrayBuffer)] };
    return x;
  };
  return JSON.stringify(key.map(tag));
}

/** Ids and creation times replaced by labels (`<id n>`, `<ct n>`), as `streams.ts` does for cursors. */
async function labeller(ctx: any) {
  const docs = [...(await ctx.db.query("groups").collect()), ...(await ctx.db.query("items").collect())];
  return (text: string) => {
    for (const d of docs) {
      text = text.split(JSON.stringify(d._id)).join(`"<id ${d.n}>"`);
      const ct = String(d._creationTime).replaceAll(".", "\\.");
      text = text.replace(new RegExp(`(?<=[\\[,])${ct}(?=[,\\]])`, "g"), `"<ct ${d.n}>"`);
    }
    return text;
  };
}

const failure = (e: unknown) => {
  const err = e as Error;
  return { error: `${err.name}: ${err.message}` };
};

/** A request's index: `creation` (no index, no schema), `k_g` or `g_k` (with the schema), `noSchema` (refused). */
function target(index: string) {
  if (index === "creation") return { table: "items" };
  if (index === "noSchema") return { table: "items", index: "k_g", indexFields: ["k", "g"] };
  return { table: "items", index, schema };
}

const ORDER = v.union(v.literal("asc"), v.literal("desc"));

/**
 * `getPage` walked to the end of an index, each page starting after the last one's last key; each page read again
 * up to that key (`endIndexKey`), as an app stitching pages together does.
 */
export const walk = queryGeneric({
  args: { index: v.string(), order: ORDER, targetMaxRows: v.number(), absoluteMaxRows: v.optional(v.number()) },
  handler: async (ctx, { index, order, targetMaxRows, absoluteMaxRows }) => {
    const name = await labeller(ctx);
    const pages: unknown[] = [];
    try {
      let startIndexKey: unknown[] | undefined;
      for (let i = 0; i < 200; i++) {
        const request: any = { ...target(index), order, targetMaxRows, absoluteMaxRows, startIndexKey };
        const r = await getPage(ctx, request);
        const last = r.indexKeys.at(-1);
        const again = last ? await getPage(ctx, { ...request, endIndexKey: last }) : null;
        pages.push({
          page: r.page.map((d: any) => d.n),
          hasMore: r.hasMore,
          indexKeys: r.indexKeys.map((k) => name(keyText(k))),
          again: again && { page: again.page.map((d: any) => d.n), hasMore: again.hasMore },
        });
        if (!r.hasMore || !last) break;
        startIndexKey = last;
      }
    } catch (e) {
      pages.push(failure(e));
    }
    return pages;
  },
});

/** One `getPage` between two given keys (`null`: not given), with the given inclusivity. */
export const page = queryGeneric({
  args: {
    index: v.string(),
    order: ORDER,
    start: v.optional(v.any()),
    end: v.optional(v.any()),
    startInclusive: v.optional(v.boolean()),
    endInclusive: v.optional(v.boolean()),
    targetMaxRows: v.optional(v.number()),
  },
  handler: async (ctx, { index, order, start, end, startInclusive, endInclusive, targetMaxRows }) => {
    const name = await labeller(ctx);
    // Keys arrive as JSON; `"$undefined"` stands for a missing field.
    const key = (k: unknown) => (Array.isArray(k) ? k.map((x) => (x === "$undefined" ? undefined : x)) : undefined);
    try {
      const r = await getPage(ctx, {
        ...(target(index) as any),
        order,
        startIndexKey: key(start),
        endIndexKey: key(end),
        startInclusive,
        endInclusive,
        targetMaxRows,
      });
      return {
        page: r.page.map((d: any) => d.n),
        hasMore: r.hasMore,
        indexKeys: r.indexKeys.map((k) => name(keyText(k))),
      };
    } catch (e) {
      return failure(e);
    }
  },
});

/** `paginator`'s pages over a range of `k_g`, to its end, each read again up to its own `continueCursor`. */
export const paginate = queryGeneric({
  args: { order: ORDER, numItems: v.number() },
  handler: async (ctx, { order, numItems }) => {
    const name = await labeller(ctx);
    const query = () =>
      paginator(ctx.db, schema)
        .query("items")
        .withIndex("k_g", (q: any) => q.gte("k", false).lt("k", "x_undefined"))
        .order(order);
    const pages: unknown[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 200; i++) {
      const r = await query().paginate({ cursor, numItems });
      const again = await query().paginate({ cursor, endCursor: r.continueCursor, numItems });
      pages.push({
        page: r.page.map((d: any) => d.n),
        isDone: r.isDone,
        continueCursor: name(r.continueCursor),
        again: again.page.map((d: any) => d.n),
        againCursor: name(again.continueCursor),
      });
      if (r.isDone) break;
      cursor = r.continueCursor;
    }
    return pages;
  },
});

// The app of test/helpers-stream.test.ts (STUDY-181 PR 3): convex-helpers' streams (`convex-helpers/server/stream`
// 0.1.128 on Convex's backend; the harness points bunvex's copy at `@bunvex/helpers/server/stream`) over the same
// documents. `walk` pages through a stream to its end; `page` reads one page from a given cursor. Each answer gives
// the documents by their `n` and every cursor as it came, but for each backend's own ids and creation times, which
// are replaced in the text by `<id n>` / `<ct n>`: every other byte of a cursor is compared.
// biome-ignore-all lint/suspicious/noExplicitAny: the app's streams are built by name, typed loosely
import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { mergedStream, stream, streamIndexRange } from "convex-helpers/server/stream";
import schema from "./schema";

const KEYS: unknown[] = [
  undefined,
  null,
  false,
  true,
  -2n,
  2n,
  Number.NEGATIVE_INFINITY,
  -1,
  -0,
  0,
  1,
  1.5,
  Number.POSITIVE_INFINITY,
  Number.NaN,
  "",
  "a",
  "undefined",
  "_undefined",
  "x_undefined",
  new Uint8Array([0, 255]).buffer,
  [0, 1],
  { tag: 1 },
];

export const seed = mutationGeneric({
  args: {},
  handler: async (ctx) => {
    let n = 0;
    for (let g = 0; g < 3; g++) await ctx.db.insert("groups", { n: n++, g });
    for (const [i, k] of KEYS.entries())
      for (let g = 0; g < 3; g++) {
        // Gaps, so some groups lack some keys.
        if ((i + g) % 4 === 3) continue;
        await ctx.db.insert("items", { n: n++, g, k } as any);
      }
  },
});

type Order = "asc" | "desc";
const ITEM_FIELDS = ["g", "k", "_creationTime", "_id"];

function build(ctx: any, scenario: string, order: Order): any {
  const db = stream(ctx.db, schema);
  const items = () => db.query("items");
  const inGroup = (g: number) =>
    items()
      .withIndex("g_k", (q) => q.eq("g", g))
      .order(order);
  switch (scenario) {
    case "plain":
      return items().withIndex("k_g").order(order);
    case "group":
      return inGroup(1);
    case "range":
      return items()
        .withIndex("k_g", (q) => q.gt("k", -1).lte("k", "undefined"))
        .order(order);
    case "creation":
      return items().order(order);
    case "filter":
      return items()
        .withIndex("k_g")
        .order(order)
        .filterWith(async (d) => d.g !== 1);
    case "map":
      return inGroup(1).map(async (d) => (typeof d.k === "string" ? null : { n: d.n }));
    case "merged":
      return mergedStream([inGroup(0), inGroup(2)], ["k"]);
    case "distinct":
      return items().withIndex("k_g").order(order).distinct(["k"]);
    case "flatMap":
      return db
        .query("groups")
        .withIndex("g")
        .order(order)
        .flatMap(async (group) => inGroup(group.g), [...ITEM_FIELDS]);
    case "looseScan":
      return items()
        .withIndex("g_k")
        .order(order)
        .distinct(["g"])
        .flatMap(
          async (d) =>
            items()
              .withIndex("g_k", (q) => q.eq("g", d.g).gt("k", null))
              .order(order),
          [...ITEM_FIELDS],
        );
    case "indexRange":
      return streamIndexRange(
        ctx.db,
        schema,
        "items",
        "k_g",
        { lowerBound: [false], lowerBoundInclusive: false, upperBound: ["a", 1], upperBoundInclusive: true },
        order,
      );
    case "badRange":
      return items().withIndex("k_g", (q: any) => q.eq("g", 1));
    default:
      throw new Error(`no scenario ${scenario}`);
  }
}

/** A cursor with each backend's ids and creation times replaced by labels; every other byte as it came. */
async function labeller(ctx: any) {
  const docs = [...(await ctx.db.query("groups").collect()), ...(await ctx.db.query("items").collect())];
  return (cursor: unknown) => {
    if (typeof cursor !== "string") return cursor;
    let text = cursor;
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

const label = (item: any) => (item && typeof item === "object" && "n" in item ? item.n : item);

export const walk = queryGeneric({
  args: {
    scenario: v.string(),
    order: v.union(v.literal("asc"), v.literal("desc")),
    numItems: v.number(),
    maximumRowsRead: v.optional(v.number()),
    maximumBytesRead: v.optional(v.number()),
  },
  handler: async (ctx, { scenario, order, numItems, maximumRowsRead, maximumBytesRead }) => {
    const name = await labeller(ctx);
    const pages: unknown[] = [];
    try {
      const query = build(ctx, scenario, order);
      let cursor: string | null = null;
      for (let i = 0; i < 200; i++) {
        const page = await query.paginate({ cursor, numItems, maximumRowsRead, maximumBytesRead });
        // The same page again, up to its own end: what a reactive query's later runs read.
        const again = await query.paginate({ cursor, endCursor: page.continueCursor, numItems });
        pages.push({
          page: page.page.map(label),
          isDone: page.isDone,
          continueCursor: name(page.continueCursor),
          pageStatus: page.pageStatus ?? null,
          splitCursor: name(page.splitCursor) ?? null,
          again: again.page.map(label),
          againDone: again.isDone,
          againCursor: name(again.continueCursor),
        });
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
    } catch (e) {
      pages.push(failure(e));
    }
    return pages;
  },
});

export const page = queryGeneric({
  args: {
    scenario: v.string(),
    order: v.union(v.literal("asc"), v.literal("desc")),
    cursor: v.union(v.string(), v.null()),
    endCursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.number(),
  },
  handler: async (ctx, { scenario, order, cursor, endCursor, numItems }) => {
    const name = await labeller(ctx);
    try {
      const result = await build(ctx, scenario, order).paginate({ cursor, endCursor, numItems });
      return {
        page: result.page.map(label),
        isDone: result.isDone,
        continueCursor: name(result.continueCursor),
        pageStatus: result.pageStatus ?? null,
        splitCursor: name(result.splitCursor) ?? null,
      };
    } catch (e) {
      return failure(e);
    }
  },
});

/** Every item's index key in the `k_g` index, as a cursor: each backend's own, for the test to feed back. */
export const keys = queryGeneric({
  args: { order: v.union(v.literal("asc"), v.literal("desc")) },
  handler: async (ctx, { order }) => {
    const name = await labeller(ctx);
    const query = build(ctx, "plain", order);
    const cursors: { raw: string; named: unknown }[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await query.paginate({ cursor, numItems: 1 });
      if (page.isDone) break;
      cursors.push({ raw: page.continueCursor, named: name(page.continueCursor) });
      cursor = page.continueCursor;
    }
    return cursors;
  },
});

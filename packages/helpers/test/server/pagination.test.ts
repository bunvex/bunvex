// convex-helpers' `server/pagination.test.ts` (e48f9df) ported to bunvex (STUDY-181 PR 4): `getPage` by creation
// time and by an index, both orders, empty and inclusive/exclusive ends, pages kept adjacent by `endIndexKey` across
// writes, skipping forward and scrolling back; and `paginator`'s scans, ranges, invalid ranges and `endCursor`.
// Upstream runs on convex-test; here every test is a deployment of the app of fixtures/stream (`bunvexTest`), whose
// `foo` table is upstream's, the functions inline in `t.run`.
//
// Beyond upstream: the defaults of `targetMaxRows` (100) and of `endInclusive` (true), `absoluteMaxRows` without an
// end key, the raw index keys, `indexFields` being ignored (H-7), and the two messages of a request it refuses.
// biome-ignore-all lint/suspicious/noExplicitAny: inline functions get `ctx` untyped, as upstream's tests use it
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { GenericDocument } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import { getPage, type IndexKey, paginator } from "../../src/server/pagination.ts";
import schema from "../fixtures/stream/bunvex/schema.ts";

const APP = join(import.meta.dir, "..", "fixtures", "stream");
const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
const setup = () => {
  const t = bunvexTest({ cwd: APP });
  open.push(t);
  return t;
};

function stripSystemFields(doc: GenericDocument) {
  const { _id, _creationTime, ...rest } = doc;
  return rest;
}
function dropSystemFields(indexKey: IndexKey) {
  return indexKey.slice(0, -2);
}

const MANY_DOCS: { a: number; b: number; c: number }[] = [];
for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) for (let c = 0; c < 3; c++) MANY_DOCS.push({ a, b, c });

const insertMany = async (ctx: any) => {
  for (const doc of MANY_DOCS) await ctx.db.insert("foo", doc);
};

describe("manual pagination", () => {
  test("single doc by creation time", async () => {
    await setup().run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 2, c: 3 });
      const { page, indexKeys, hasMore } = await getPage(ctx, { table: "foo" });
      expect(page.map(stripSystemFields)).toEqual([{ a: 1, b: 2, c: 3 }]);
      expect(hasMore).toBe(false);
      expect(indexKeys.map(dropSystemFields)).toEqual([[]]);
      // The raw key: the creation time and the id, not a cursor.
      expect(indexKeys).toEqual([[page[0]!._creationTime, page[0]!._id]]);
    });
  });

  test("single doc by abc", async () => {
    await setup().run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 2, c: 3 });
      const { page, indexKeys, hasMore } = await getPage(ctx, { table: "foo", index: "abc", schema });
      expect(page.map(stripSystemFields)).toEqual([{ a: 1, b: 2, c: 3 }]);
      expect(hasMore).toBe(false);
      expect(indexKeys.map(dropSystemFields)).toEqual([[1, 2, 3]]);
      expect(indexKeys).toEqual([[1, 2, 3, page[0]!._creationTime, page[0]!._id]]);
    });
  });

  test.each(["asc", "desc"] as const)("empty endpoints remain unbounded when marked exclusive (%s)", async (order) => {
    // `[]` is no cutoff at that end; inclusivity applies to non-empty keys only.
    await setup().run(async (ctx: any) => {
      await insertMany(ctx);
      for (const { startIndexKey, endIndexKey, expected } of [
        { startIndexKey: [], endIndexKey: [], expected: MANY_DOCS.slice() },
        {
          startIndexKey: [],
          endIndexKey: [1],
          expected: MANY_DOCS.filter(({ a }) => (order === "asc" ? a < 1 : a > 1)),
        },
        {
          startIndexKey: [1],
          endIndexKey: [],
          expected: MANY_DOCS.filter(({ a }) => (order === "asc" ? a > 1 : a < 1)),
        },
      ]) {
        if (order === "desc") expected.reverse();
        const { page, hasMore } = await getPage(ctx, {
          table: "foo",
          index: "abc",
          schema,
          order,
          startIndexKey,
          endIndexKey,
          startInclusive: false,
          endInclusive: false,
        });
        expect(page.map(stripSystemFields)).toEqual(expected);
        expect(hasMore).toBe(false);
      }
    });
  });

  test("middle page with exclusive/inclusive bounds", async () => {
    await setup().run(async (ctx: any) => {
      await insertMany(ctx);
      const inclusiveDocs = [
        { a: 1, b: 1, c: 0 },
        { a: 1, b: 1, c: 1 },
        { a: 1, b: 1, c: 2 },
        { a: 1, b: 2, c: 0 },
        { a: 1, b: 2, c: 1 },
        { a: 1, b: 2, c: 2 },
      ];
      const request = { table: "foo", index: "abc", schema, startIndexKey: [1, 1, 0], endIndexKey: [1, 2, 2] };
      const { page, hasMore } = await getPage(ctx, { ...request, startInclusive: true, endInclusive: true });
      expect(hasMore).toBe(false);
      expect(page.map(stripSystemFields)).toEqual(inclusiveDocs);

      const { page: page2 } = await getPage(ctx, { ...request, startInclusive: true, endInclusive: false });
      expect(page2.map(stripSystemFields)).toEqual(inclusiveDocs.slice(0, -1));

      const { page: page3 } = await getPage(ctx, { ...request, startInclusive: false, endInclusive: true });
      expect(page3.map(stripSystemFields)).toEqual(inclusiveDocs.slice(1));

      const { page: page4 } = await getPage(ctx, { ...request, startInclusive: false, endInclusive: false });
      expect(page4.map(stripSystemFields)).toEqual(inclusiveDocs.slice(1, -1));

      // The defaults: the start exclusive, the end inclusive.
      const { page: page5 } = await getPage(ctx, request);
      expect(page5.map(stripSystemFields)).toEqual(inclusiveDocs.slice(1));
    });
  });

  test("middle page descending", async () => {
    await setup().run(async (ctx: any) => {
      await insertMany(ctx);
      // Descending, the page starts at the higher key.
      const { page, hasMore } = await getPage(ctx, {
        table: "foo",
        index: "abc",
        schema,
        order: "desc",
        startIndexKey: [1, 2, 2],
        endIndexKey: [1, 1, 0],
      });
      expect(hasMore).toBe(false);
      expect(page.map(stripSystemFields)).toEqual([
        { a: 1, b: 2, c: 1 },
        { a: 1, b: 2, c: 0 },
        { a: 1, b: 1, c: 2 },
        { a: 1, b: 1, c: 1 },
        { a: 1, b: 1, c: 0 },
      ]);
    });
  });

  test("three pages with refreshes", async () => {
    await setup().run(async (ctx: any) => {
      await insertMany(ctx);
      const base = { table: "foo", index: "abc", schema, targetMaxRows: 3 };
      const { page: page0, indexKeys: indexKeys0, hasMore: hasMore0 } = await getPage(ctx, base);
      expect(page0.length).toBe(3);
      expect(hasMore0).toBe(true);
      const { page: page1, indexKeys: indexKeys1 } = await getPage(ctx, { ...base, startIndexKey: indexKeys0[2] });
      expect(page1.length).toBe(3);
      const { page: page2 } = await getPage(ctx, { ...base, startIndexKey: indexKeys1[2] });
      expect(page2.length).toBe(3);
      expect([...page0, ...page1, ...page2].map(stripSystemFields)).toEqual(MANY_DOCS.slice(0, 9));

      // Delete the first doc and refresh the first page: two documents, the third is already in the second page.
      await ctx.db.delete("foo", page0[0]!._id);
      const { page: page0Refreshed } = await getPage(ctx, { ...base, endIndexKey: indexKeys0[2] });
      expect(page0Refreshed).toEqual(page0.slice(1));

      // Insert a doc in the middle and refresh the second page: four documents, to stay next to the third page.
      await ctx.db.insert("foo", { a: 0, b: 1, c: 1.5 });
      const { page: page1Refreshed } = await getPage(ctx, {
        ...base,
        startIndexKey: indexKeys0[2],
        endIndexKey: indexKeys1[2],
      });
      expect(page1Refreshed.map(stripSystemFields)).toEqual([
        { a: 0, b: 1, c: 0 },
        { a: 0, b: 1, c: 1 },
        { a: 0, b: 1, c: 1.5 },
        { a: 0, b: 1, c: 2 },
      ]);
      // With an absoluteMaxRows of 3 the pages stop being adjacent, but only three rows come back.
      const { page: page1AbsoluteMax, hasMore } = await getPage(ctx, {
        ...base,
        startIndexKey: indexKeys0[2],
        endIndexKey: indexKeys1[2],
        absoluteMaxRows: 3,
      });
      expect(page1AbsoluteMax.map(stripSystemFields)).toEqual([
        { a: 0, b: 1, c: 0 },
        { a: 0, b: 1, c: 1 },
        { a: 0, b: 1, c: 1.5 },
      ]);
      expect(hasMore).toBe(true);
    });
  });

  test("skip forward and scroll back", async () => {
    await setup().run(async (ctx: any) => {
      await insertMany(ctx);
      const base = { table: "foo", index: "abc", schema, targetMaxRows: 3 };
      const { page: pageAt } = await getPage(ctx, { ...base, startIndexKey: [1], startInclusive: true });
      expect(pageAt.map(stripSystemFields)).toEqual([
        { a: 1, b: 0, c: 0 },
        { a: 1, b: 0, c: 1 },
        { a: 1, b: 0, c: 2 },
      ]);
      const { page: pagePrev, indexKeys: indexKeysPrev } = await getPage(ctx, {
        ...base,
        startIndexKey: [1],
        startInclusive: false,
        order: "desc",
      });
      expect(pagePrev.map(stripSystemFields)).toEqual([
        { a: 0, b: 2, c: 2 },
        { a: 0, b: 2, c: 1 },
        { a: 0, b: 2, c: 0 },
      ]);
      // Refresh the previous page, in the right order.
      const { page: pagePrevRefreshed } = await getPage(ctx, {
        ...base,
        startIndexKey: indexKeysPrev[2],
        endIndexKey: [1],
        startInclusive: true,
        endInclusive: false,
      });
      pagePrev.reverse();
      expect(pagePrevRefreshed).toEqual(pagePrev);
    });
  });

  test("the row limits and their extra row", async () => {
    await setup().run(async (ctx: any) => {
      for (let i = 0; i < 101; i++) await ctx.db.insert("foo", { a: i, b: 0, c: 0 });
      // targetMaxRows defaults to 100; the 101st row only says there is more.
      const first = await getPage(ctx, { table: "foo" });
      expect(first.page.length).toBe(100);
      expect(first.indexKeys.length).toBe(100);
      expect(first.hasMore).toBe(true);
      // Exactly the limit: no more.
      const exact = await getPage(ctx, { table: "foo", targetMaxRows: 101 });
      expect(exact.page.length).toBe(101);
      expect(exact.hasMore).toBe(false);
      // An end key, even `[]`, lifts targetMaxRows; absoluteMaxRows still holds.
      const toEnd = await getPage(ctx, { table: "foo", targetMaxRows: 2, endIndexKey: [] });
      expect(toEnd.page.length).toBe(101);
      expect(toEnd.hasMore).toBe(false);
      const capped = await getPage(ctx, { table: "foo", targetMaxRows: 50, absoluteMaxRows: 10 });
      expect(capped.page.length).toBe(10);
      expect(capped.hasMore).toBe(true);
      const cappedToEnd = await getPage(ctx, { table: "foo", endIndexKey: [], absoluteMaxRows: 10 });
      expect(cappedToEnd.page.length).toBe(10);
      expect(cappedToEnd.hasMore).toBe(true);
    });
  });

  test("indexFields is accepted and ignored", async () => {
    await setup().run(async (ctx: any) => {
      await insertMany(ctx);
      const { page } = await getPage(ctx, {
        table: "foo",
        index: "abc",
        schema,
        indexFields: ["nonsense"],
        startIndexKey: [2, 2],
        startInclusive: true,
      });
      expect(page.map(stripSystemFields)).toEqual(MANY_DOCS.slice(-3));
      // Without a schema, a named index has no fields, whatever indexFields says.
      await expect(getPage(ctx, { table: "foo", index: "abc", indexFields: ["a", "b", "c"] })).rejects.toThrow(
        "schema is required to infer index fields",
      );
    });
  });

  test("an index key longer than the index", async () => {
    await setup().run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 2, c: 3 });
      await expect(getPage(ctx, { table: "foo", startIndexKey: [1, "x", 3] })).rejects.toThrow(
        "Index key length exceeds index fields length",
      );
      await expect(
        getPage(ctx, { table: "foo", index: "abc", schema, endIndexKey: [1, 2, 3, 4, "x", 6] }),
      ).rejects.toThrow("Index key length exceeds index fields length");
    });
  });
});

describe("paginator", () => {
  test("full table scan", async () => {
    await setup().run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 2, c: 3 });
      await ctx.db.insert("foo", { a: 1, b: 2, c: 4 });
      await ctx.db.insert("foo", { a: 1, b: 2, c: 5 });
      const result1 = await paginator(ctx.db, schema).query("foo").paginate({ numItems: 100, cursor: null });
      expect(result1.page.map(stripSystemFields)).toEqual([
        { a: 1, b: 2, c: 3 },
        { a: 1, b: 2, c: 4 },
        { a: 1, b: 2, c: 5 },
      ]);
      expect(result1.isDone).toBe(true);
      expect(result1.continueCursor).toBe("[]");
    });
  });

  test("paginated table scan", async () => {
    await setup().run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 2, c: 3 });
      await ctx.db.insert("foo", { a: 1, b: 2, c: 4 });
      await ctx.db.insert("foo", { a: 1, b: 2, c: 5 });
      const result1 = await paginator(ctx.db, schema).query("foo").paginate({ numItems: 2, cursor: null });
      expect(result1.page.map(stripSystemFields)).toEqual([
        { a: 1, b: 2, c: 3 },
        { a: 1, b: 2, c: 4 },
      ]);
      expect(result1.isDone).toBe(false);

      const result2 = await paginator(ctx.db, schema)
        .query("foo")
        .paginate({ numItems: 2, cursor: result1.continueCursor });
      expect(result2.page.map(stripSystemFields)).toEqual([{ a: 1, b: 2, c: 5 }]);
      expect(result2.isDone).toBe(true);
    });
  });

  test("index range", async () => {
    await setup().run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 5, c: 1 });
      await ctx.db.insert("foo", { a: 1, b: 6, c: 1 });
      await ctx.db.insert("foo", { a: 1, b: 3, c: 1 });
      await ctx.db.insert("foo", { a: 1, b: 4, c: 1 });
      await ctx.db.insert("foo", { a: 1, b: 4, c: 2 });
      const result1 = await paginator(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1).gt("b", 3).lte("b", 5))
        .paginate({ cursor: null, numItems: 100 });
      expect(result1.page.map(stripSystemFields)).toEqual([
        { a: 1, b: 4, c: 1 },
        { a: 1, b: 4, c: 2 },
        { a: 1, b: 5, c: 1 },
      ]);
      expect(result1.isDone).toBe(true);

      const result2 = await paginator(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1).gt("b", 3).lte("b", 5))
        .order("desc")
        .paginate({ cursor: null, numItems: 100 });
      expect(result2.page.map(stripSystemFields)).toEqual([
        { a: 1, b: 5, c: 1 },
        { a: 1, b: 4, c: 2 },
        { a: 1, b: 4, c: 1 },
      ]);
      expect(result2.isDone).toBe(true);
    });
  });

  test("paginated index range desc", async () => {
    await setup().run(async (ctx: any) => {
      for (const [b, c] of [
        [5, 1],
        [5, 2],
        [5, 3],
        [6, 1],
        [3, 1],
        [3, 2],
        [4, 1],
        [4, 2],
      ]) {
        await ctx.db.insert("foo", { a: 1, b, c });
      }
      const query = () =>
        paginator(ctx.db, schema)
          .query("foo")
          .withIndex("abc", (q) => q.eq("a", 1).gt("b", 3).lte("b", 5))
          .order("desc");
      const result1 = await query().paginate({ cursor: null, numItems: 2 });
      expect(result1.page.map(stripSystemFields)).toEqual([
        { a: 1, b: 5, c: 3 },
        { a: 1, b: 5, c: 2 },
      ]);
      expect(result1.isDone).toBe(false);

      const result2 = await query().paginate({ cursor: result1.continueCursor, numItems: 3 });
      expect(result2.page.map(stripSystemFields)).toEqual([
        { a: 1, b: 5, c: 1 },
        { a: 1, b: 4, c: 2 },
        { a: 1, b: 4, c: 1 },
      ]);
      expect(result2.isDone).toBe(false);

      const result3 = await query().paginate({ cursor: result2.continueCursor, numItems: 2 });
      expect(result3.page.map(stripSystemFields)).toEqual([]);
      expect(result3.isDone).toBe(true);
    });
  });

  test("invalid index range", async () => {
    await setup().run(async (ctx: any) => {
      expect(() =>
        paginator(ctx.db, schema)
          .query("foo")
          .withIndex("abc", (q) => q.gt("c" as any, 3)),
      ).toThrow("Cannot use gt on field 'c'");
      expect(() =>
        paginator(ctx.db, schema)
          .query("foo")
          .withIndex("abc", (q) => q.eq("a", 1).eq("c" as any, 3)),
      ).toThrow("Cannot use eq on field 'c'");
      expect(() =>
        paginator(ctx.db, schema)
          .query("foo")
          .withIndex("abc", (q) => (q.gt("a", 1) as any).gt("b", 3)),
      ).toThrow("Cannot use gt on field 'b'");
      expect(() =>
        paginator(ctx.db, schema)
          .query("foo")
          .withIndex("abc", (q) => (q.gt("a", 1).lt("a", 3) as any).eq("b", 3)),
      ).toThrow("Cannot use eq on field 'b'");
    });
  });

  test("endCursor", async () => {
    await setup().run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 5, c: 1 });
      await ctx.db.insert("foo", { a: 1, b: 6, c: 1 });
      await ctx.db.insert("foo", { a: 1, b: 3, c: 1 });
      await ctx.db.insert("foo", { a: 1, b: 4, c: 1 });
      await ctx.db.insert("foo", { a: 1, b: 4, c: 3 });
      const query = () =>
        paginator(ctx.db, schema)
          .query("foo")
          .withIndex("abc", (q) => q.eq("a", 1).gt("b", 3).lte("b", 5));
      // The first page has two items.
      const result1 = await query().paginate({ cursor: null, numItems: 2 });
      expect(result1.page.map(stripSystemFields)).toEqual([
        { a: 1, b: 4, c: 1 },
        { a: 1, b: 4, c: 3 },
      ]);
      expect(result1.isDone).toBe(false);
      // Add an item to the first page and refetch it with endCursor.
      await ctx.db.insert("foo", { a: 1, b: 4, c: 2 });
      const result2 = await query().paginate({ cursor: null, endCursor: result1.continueCursor, numItems: 2 });
      expect(result2.page.map(stripSystemFields)).toEqual([
        { a: 1, b: 4, c: 1 },
        { a: 1, b: 4, c: 2 },
        { a: 1, b: 4, c: 3 },
      ]);
      expect(result2.isDone).toBe(false);
      expect(result1.continueCursor).toStrictEqual(result2.continueCursor);

      // The second page has one item.
      const result3 = await query().paginate({ cursor: result2.continueCursor, numItems: 2 });
      expect(result3.page.map(stripSystemFields)).toEqual([{ a: 1, b: 5, c: 1 }]);
      expect(result3.isDone).toBe(true);
      // Add two items to the second page and refetch it with endCursor.
      await ctx.db.insert("foo", { a: 1, b: 5, c: 2 });
      await ctx.db.insert("foo", { a: 1, b: 5, c: 3 });
      const result4 = await query().paginate({
        cursor: result2.continueCursor,
        endCursor: result3.continueCursor,
        numItems: 2,
      });
      expect(result4.page.map(stripSystemFields)).toEqual([
        { a: 1, b: 5, c: 1 },
        { a: 1, b: 5, c: 2 },
        { a: 1, b: 5, c: 3 },
      ]);
      expect(result4.isDone).toBe(true);
    });
  });
});

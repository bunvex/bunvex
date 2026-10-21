// convex-helpers' `server/stream.test.ts` (e48f9df) ported to bunvex (STUDY-181 PR 3): reflection, index ranges,
// merges, filters, maps, flatMaps and their resumption, distinct, `streamIndexRange`'s splits, `endCursor`, the
// split statuses, `undefined` in cursors, and the bytes read. Upstream runs on convex-test; here every test is a
// deployment of the app of fixtures/stream (`bunvexTest`), the stream functions inline in `t.run`, as upstream's.
//
// Where it differs from upstream:
// - The schemas upstream defines inside tests are tables of the fixture's one schema: the tenant test's
//   `companies` / `contacts`, the nested flatMap's `a` / `b` / `c`, and the two `undefined` tests' `foo`s as
//   `undefinedNumbers` and `undefinedStrings`.
// - The 16,000-document scan inserts in four mutations: a deployment refuses more than 16,000 writes in one, which
//   convex-test does not check.
// biome-ignore-all lint/suspicious/noExplicitAny: inline functions get `ctx` untyped, as upstream's tests use it
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { GenericDocument } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import { getDocumentSize, toJsonValue } from "@bunvex/values";
import { type IndexKey, mergedStream, stream, streamIndexRange } from "../../src/server/stream.ts";
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

function stripSystemFields(doc: GenericDocument | null): Record<string, unknown> | null {
  if (doc === null) return doc;
  const { _id, _creationTime, ...rest } = doc;
  return rest;
}
function dropSystemFields(indexKey: IndexKey) {
  return indexKey.slice(0, -2);
}
function dropAndStripSystemFields(item: IteratorResult<[GenericDocument | null, IndexKey, number], undefined>) {
  return {
    done: item.done,
    value: item.value ? [stripSystemFields(item.value[0]), dropSystemFields(item.value[1])] : undefined,
  };
}

const MANY_DOCS: { a: number; b: number; c: number }[] = [];
for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) for (let c = 0; c < 3; c++) MANY_DOCS.push({ a, b, c });

describe("pagination cursor isolation", () => {
  async function setupTenants() {
    const t = setup();
    const companies = await t.run(async (ctx: any) => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const companyId = await ctx.db.insert("companies", {});
        ids.push(companyId);
        for (let createdAt = 0; createdAt < 3; createdAt++) await ctx.db.insert("contacts", { companyId, createdAt });
      }
      return ids.sort();
    });
    return { t, companies };
  }

  test.each(["asc", "desc"] as const)("foreign cursors stay within the declared tenant range (%s)", async (order) => {
    const { t, companies } = await setupTenants();
    await t.run(async (ctx: any) => {
      const db = stream(ctx.db, schema);
      const query = db
        .query("contacts")
        .withIndex("by_company_createdAt", (q) => q.eq("companyId", companies[1]! as any))
        .order(order);
      const expected = await query.collect();
      expect(expected).toHaveLength(3);
      const foreignCompanies = order === "asc" ? [companies[2]!, companies[0]!] : [companies[0]!, companies[2]!];
      for (const foreignCompany of foreignCompanies) {
        const foreignPage = await db
          .query("contacts")
          .withIndex("by_company_createdAt", (q) => q.eq("companyId", foreignCompany as any))
          .order(order)
          .paginate({ cursor: null, numItems: 2 });
        // Whole document cursors and shorter prefixes both intersect the static bounds; none widens them.
        const key = JSON.parse(foreignPage.continueCursor);
        for (const cursor of [
          foreignPage.continueCursor,
          JSON.stringify(key.slice(0, 1)),
          JSON.stringify(key.slice(0, 2)),
        ]) {
          const pastTenant = order === "asc" ? foreignCompany > companies[1]! : foreignCompany < companies[1]!;
          const page = await query.paginate({ cursor, numItems: 10 });
          expect(page.page).toEqual(pastTenant ? [] : expected);
          expect(page.isDone).toBe(true);
          const endingPage = await query.paginate({ cursor: null, endCursor: cursor, numItems: 10 });
          expect(endingPage.page).toEqual(pastTenant ? expected : []);
        }
      }
    });
  });

  test.each(["asc", "desc"] as const)(
    "the terminal empty cursor cannot escape the tenant range (%s)",
    async (order) => {
      const { t, companies } = await setupTenants();
      await t.run(async (ctx: any) => {
        const query = stream(ctx.db, schema)
          .query("contacts")
          .withIndex("by_company_createdAt", (q) => q.eq("companyId", companies[1]! as any))
          .order(order);
        const complete = await query.paginate({ cursor: null, numItems: 10 });
        expect(complete.page).toHaveLength(3);
        expect(complete.page.every((doc) => doc.companyId === companies[1])).toBe(true);
        expect(complete.isDone).toBe(true);
        expect(complete.continueCursor).toBe("[]");
        const resumed = await query.paginate({ cursor: complete.continueCursor, numItems: 1 });
        expect(resumed.page).toEqual([]);
        expect(resumed.isDone).toBe(true);
        expect(resumed.continueCursor).toBe("[]");
        const endingPage = await query.paginate({ cursor: null, endCursor: "[]", numItems: 1 });
        expect(endingPage.page).toEqual(complete.page);
        expect(endingPage.isDone).toBe(true);
      });
    },
  );
});

describe("reflect", () => {
  test("reflection", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      const query = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1).gt("b", 2))
        .order("desc");
      const { table, index, bounds, indexFields, order } = query.reflect();
      expect(table).toBe("foo");
      expect(index).toBe("abc");
      expect(bounds.lowerBound).toEqual([1, 2]);
      expect(bounds.lowerBoundInclusive).toBe(false);
      expect(bounds.upperBound).toEqual([1]);
      expect(bounds.upperBoundInclusive).toBe(true);
      expect(indexFields).toEqual(["a", "b", "c", "_creationTime", "_id"]);
      expect(order).toBe("desc");
    });
  });

  test("reflection as query", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 2, c: 3 });
      await ctx.db.insert("foo", { a: 1, b: 3, c: 3 });
      await ctx.db.insert("foo", { a: 1, b: 4, c: 3 });
      const query = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1).gt("b", 2))
        .order("desc");
      expect((await query.collect()).map(stripSystemFields)).toEqual([
        { a: 1, b: 4, c: 3 },
        { a: 1, b: 3, c: 3 },
      ]);
    });
  });
});

describe("stream", () => {
  test("reflection as stream", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 2, c: 3 });
      await ctx.db.insert("foo", { a: 1, b: 3, c: 3 });
      await ctx.db.insert("foo", { a: 1, b: 4, c: 3 });
      const query = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1).gt("b", 2))
        .order("desc");
      expect(query.getOrder()).toBe("desc");
      const iter = query.iterWithKeys()[Symbol.asyncIterator]();
      expect(dropAndStripSystemFields(await iter.next())).toEqual({
        done: false,
        value: [{ a: 1, b: 4, c: 3 }, [1, 4, 3]],
      });
      expect(dropAndStripSystemFields(await iter.next())).toEqual({
        done: false,
        value: [{ a: 1, b: 3, c: 3 }, [1, 3, 3]],
      });
      expect(dropAndStripSystemFields(await iter.next())).toEqual({ done: true, value: undefined });
    });
  });

  test("query round trip", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 2, c: 3 });
      await ctx.db.insert("foo", { a: 1, b: 2, c: 4 });
      await ctx.db.insert("foo", { a: 1, b: 3, c: 3 });
      await ctx.db.insert("foo", { a: 1, b: 3, c: 4 });
      await ctx.db.insert("foo", { a: 1, b: 4, c: 3 });
      const query = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1).gt("b", 2))
        .order("desc");
      expect((await query.collect()).map(stripSystemFields)).toEqual([
        { a: 1, b: 4, c: 3 },
        { a: 1, b: 3, c: 4 },
        { a: 1, b: 3, c: 3 },
      ]);
    });
  });

  test("query round trip with pagination", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      // The first one out of order.
      await ctx.db.insert("foo", { a: 1, b: 4, c: 3 });
      await ctx.db.insert("foo", { a: 1, b: 2, c: 3 });
      await ctx.db.insert("foo", { a: 1, b: 3, c: 3 });
      await ctx.db.insert("foo", { a: 1, b: 3, c: 4 });
      await ctx.db.insert("foo", { a: 1, b: 4, c: 4 });
      const query = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1).gt("b", 2));
      const page1 = await query.paginate({ numItems: 2, cursor: null });
      expect(page1.page.map(stripSystemFields)).toEqual([
        { a: 1, b: 3, c: 3 },
        { a: 1, b: 3, c: 4 },
      ]);
      expect(page1.isDone).toBe(false);
      const page2 = await query.paginate({ numItems: 2, cursor: page1.continueCursor });
      expect(page2.page.map(stripSystemFields)).toEqual([
        { a: 1, b: 4, c: 3 },
        { a: 1, b: 4, c: 4 },
      ]);
      expect(page2.isDone).toBe(false);
      const page3 = await query.paginate({ numItems: 2, cursor: page2.continueCursor });
      expect(page3.page.map(stripSystemFields)).toEqual([]);
      expect(page3.isDone).toBe(true);
    });
  });

  test("continueCursor respects the order of the stream", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 1, c: 1 });
      await ctx.db.insert("foo", { a: 1, b: 2, c: 1 });
      await ctx.db.insert("foo", { a: 1, b: 2, c: 2 });
      await ctx.db.insert("foo", { a: 1, b: 3, c: 2 });
      await ctx.db.insert("foo", { a: 1, b: 2, c: 3 });
      const query = stream(ctx.db, schema).query("foo").withIndex("abc").order("desc");
      const result = await query.paginate({ numItems: 1, cursor: null });
      expect(result.page.map(stripSystemFields)).toEqual([{ a: 1, b: 3, c: 2 }]);
      expect(result.isDone).toBe(false);
      expect(result.continueCursor).toStartWith("[1,3,2");
      const result2 = await query.paginate({ numItems: 1, cursor: result.continueCursor });
      expect(result2.page.map(stripSystemFields)).toEqual([{ a: 1, b: 2, c: 3 }]);
      expect(result2.isDone).toBe(false);
      expect(result2.continueCursor).toStartWith("[1,2,3");
      const result3 = await query.paginate({ numItems: 1, cursor: result2.continueCursor });
      expect(result3.continueCursor).toStartWith("[1,2,2");
      expect(result3.page.map(stripSystemFields)).toEqual([{ a: 1, b: 2, c: 2 }]);
      expect(result3.isDone).toBe(false);
    });
  });

  test("query round trip with pagination one item at a time", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 3, c: 1 });
      await ctx.db.insert("foo", { a: 1, b: 2, c: 1 });
      await ctx.db.insert("foo", { a: 1, b: 2, c: 2 });
      await ctx.db.insert("foo", { a: 1, b: 3, c: 2 });
      await ctx.db.insert("foo", { a: 1, b: 2, c: 3 });
      const query = stream(ctx.db, schema).query("foo").withIndex("abc");
      const result = await query.paginate({ numItems: 1, cursor: null });
      expect(result.page.map(stripSystemFields)).toEqual([{ a: 1, b: 2, c: 1 }]);
      expect(result.isDone).toBe(false);
      const result2 = await query.paginate({ numItems: 2, cursor: result.continueCursor });
      expect(result2.page.map(stripSystemFields)).toEqual([
        { a: 1, b: 2, c: 2 },
        { a: 1, b: 2, c: 3 },
      ]);
      expect(result2.isDone).toBe(false);
      const result3 = await query.paginate({ numItems: 1, cursor: result2.continueCursor });
      expect(result3.page.map(stripSystemFields)).toEqual([{ a: 1, b: 3, c: 1 }]);
      expect(result3.isDone).toBe(false);
    });
  });

  test("merge streams", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 2, c: 3 });
      await ctx.db.insert("foo", { a: 1, b: 3, c: 3 }); // excluded
      await ctx.db.insert("foo", { a: 1, b: 4, c: 3 });
      await ctx.db.insert("foo", { a: 1, b: 5, c: 4 });
      await ctx.db.insert("foo", { a: 1, b: 6, c: 5 });
      const query1 = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1).gt("b", 4));
      const query2 = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1).lt("b", 3));
      const query3 = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1).eq("b", 4).eq("c", 3));
      const fullQuery = mergedStream([query1, query2, query3], ["a", "b", "c"]);
      expect((await fullQuery.collect()).map(stripSystemFields)).toEqual([
        { a: 1, b: 2, c: 3 },
        { a: 1, b: 4, c: 3 },
        { a: 1, b: 5, c: 4 },
        { a: 1, b: 6, c: 5 },
      ]);
      const page1 = await fullQuery.paginate({ numItems: 2, cursor: null });
      expect(page1.page.map(stripSystemFields)).toEqual([
        { a: 1, b: 2, c: 3 },
        { a: 1, b: 4, c: 3 },
      ]);
      expect(page1.isDone).toBe(false);
      const page2 = await fullQuery.paginate({ numItems: 3, cursor: page1.continueCursor });
      expect(page2.page.map(stripSystemFields)).toEqual([
        { a: 1, b: 5, c: 4 },
        { a: 1, b: 6, c: 5 },
      ]);
      expect(page2.isDone).toBe(true);
    });
  });

  test("merge streams desc", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 2, c: 3 });
      await ctx.db.insert("foo", { a: 1, b: 3, c: 3 });
      await ctx.db.insert("foo", { a: 2, b: 1, c: 3 });
      await ctx.db.insert("foo", { a: 2, b: 4, c: 4 });
      const query1 = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1))
        .order("desc");
      const query2 = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 2))
        .order("desc");
      const merged = mergedStream([query1, query2], ["a", "b", "c"]);
      expect((await merged.collect()).map(stripSystemFields)).toEqual([
        { a: 2, b: 4, c: 4 },
        { a: 2, b: 1, c: 3 },
        { a: 1, b: 3, c: 3 },
        { a: 1, b: 2, c: 3 },
      ]);
    });
  });

  test("filter stream", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 2, c: 3 }); // excluded by index
      await ctx.db.insert("foo", { a: 1, b: 3, c: 3 }); // excluded by filter
      await ctx.db.insert("foo", { a: 1, b: 4, c: 4 });
      await ctx.db.insert("foo", { a: 1, b: 4, c: 5 }); // excluded by filter
      await ctx.db.insert("foo", { a: 1, b: 5, c: 4 });
      await ctx.db.insert("foo", { a: 1, b: 6, c: 4 });
      const query = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1).gt("b", 2));
      const filteredQuery = query.filterWith(async (doc) => doc.c === 4);
      expect((await filteredQuery.collect()).map(stripSystemFields)).toEqual([
        { a: 1, b: 4, c: 4 },
        { a: 1, b: 5, c: 4 },
        { a: 1, b: 6, c: 4 },
      ]);
      const page1 = await filteredQuery.paginate({ numItems: 2, cursor: null });
      expect(page1.page.map(stripSystemFields)).toEqual([
        { a: 1, b: 4, c: 4 },
        { a: 1, b: 5, c: 4 },
      ]);
      expect(page1.isDone).toBe(false);

      const limitedPage1 = await filteredQuery.paginate({ numItems: 2, cursor: null, maximumRowsRead: 2 });
      expect(limitedPage1.page.map(stripSystemFields)).toEqual([{ a: 1, b: 4, c: 4 }]);
      expect(limitedPage1.pageStatus).toBe("SplitRequired");
      expect(dropSystemFields(JSON.parse(limitedPage1.splitCursor!))).toEqual([1, 3, 3]);
      expect(dropSystemFields(JSON.parse(limitedPage1.continueCursor))).toEqual([1, 4, 4]);
    });
  });

  test("no SplitRecommended without endCursor", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      for (let i = 1; i <= 20; i++) await ctx.db.insert("foo", { a: 1, b: i, c: i % 2 === 0 ? 1 : 0 });
      const query = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1))
        .filterWith(async (doc) => doc.c === 1);
      const page1 = await query.paginate({ numItems: 3, cursor: null });
      expect(page1.page).toHaveLength(3);
      expect(page1.pageStatus).toBeUndefined();
    });
  });

  test("SplitRecommended when endCursor set and page exceeds numItems + 1", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      for (let i = 1; i <= 10; i++) await ctx.db.insert("foo", { a: 1, b: i, c: i % 2 === 0 ? 1 : 0 });
      const query = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1))
        .filterWith(async (doc) => doc.c === 1);
      const endCursor = JSON.stringify(toJsonValue([1, 100, 0]));
      const page = await query.paginate({ numItems: 3, cursor: null, endCursor });
      // 5 of the 10 match: more than numItems + 1 (4).
      expect(page.page).toHaveLength(5);
      expect(page.pageStatus).toBe("SplitRecommended");
      expect(page.splitCursor).toBeDefined();
    });
  });

  test("SplitRecommended when scan approaches scan limit regardless of endCursor", async () => {
    const t = setup();
    // 16,000 keys scanned (half the scan limit) while few match the filter.
    // A second of the test's clock between batches, as a deployment's write limit (4 MiB a second) needs.
    for (let batch = 0; batch < 4; batch++) {
      if (batch > 0) await t.advanceTime(1000);
      await t.run(async (ctx: any) => {
        for (let i = batch * 4000 + 1; i <= (batch + 1) * 4000; i++)
          await ctx.db.insert("foo", { a: 4, b: i, c: i % 3000 === 0 ? 1 : 0 });
      });
    }
    await t.run(async (ctx: any) => {
      const query = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 4))
        .filterWith(async (doc) => doc.c === 1);
      const page = await query.paginate({ numItems: 10, cursor: null, endCursor: null });
      expect(page.page).toHaveLength(5);
      expect(page.pageStatus).toBe("SplitRecommended");
      expect(page.splitCursor).toBeDefined();
    });
  }, 60_000);

  test("SplitRequired fires with filterWith when maximumRowsRead is hit", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      for (let i = 1; i <= 20; i++) await ctx.db.insert("foo", { a: 3, b: i, c: i % 5 === 0 ? 1 : 0 });
      const filteredQuery = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 3))
        .filterWith(async (doc) => doc.c === 1);
      const page1 = await filteredQuery.paginate({ numItems: 3, cursor: null, maximumRowsRead: 8 });
      // The row limit is hit before 3 matches: one (b = 5) in the first 8 rows.
      expect(page1.page).toHaveLength(1);
      expect(page1.pageStatus).toBe("SplitRequired");
      expect(page1.splitCursor).toBeDefined();
    });
  });

  test("merge orderBy streams", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 2, c: 3 });
      await ctx.db.insert("foo", { a: 1, b: 3, c: 3 });
      await ctx.db.insert("foo", { a: 2, b: 1, c: 3 });
      await ctx.db.insert("foo", { a: 2, b: 4, c: 4 });
      await ctx.db.insert("foo", { a: 3, b: 6, c: 5 });
      const query1 = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1));
      const query2 = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 2));
      const merged = mergedStream([query1, query2], ["b", "c"]);
      expect((await merged.collect()).map(stripSystemFields)).toEqual([
        { a: 2, b: 1, c: 3 },
        { a: 1, b: 2, c: 3 },
        { a: 1, b: 3, c: 3 },
        { a: 2, b: 4, c: 4 },
      ]);
      const mergedDesc = mergedStream([query1.order("desc"), query2.order("desc")], ["b", "c"]);
      expect((await mergedDesc.collect()).map(stripSystemFields)).toEqual([
        { a: 2, b: 4, c: 4 },
        { a: 1, b: 3, c: 3 },
        { a: 1, b: 2, c: 3 },
        { a: 2, b: 1, c: 3 },
      ]);
      const mergedPage1 = await mergedDesc.paginate({ numItems: 2, cursor: null });
      expect(mergedPage1.page.map(stripSystemFields)).toEqual([
        { a: 2, b: 4, c: 4 },
        { a: 1, b: 3, c: 3 },
      ]);
      expect(mergedPage1.isDone).toBe(false);
      const mergedPage2 = await mergedDesc.paginate({ numItems: 3, cursor: mergedPage1.continueCursor });
      expect(mergedPage2.page.map(stripSystemFields)).toEqual([
        { a: 1, b: 2, c: 3 },
        { a: 2, b: 1, c: 3 },
      ]);
      expect(mergedPage2.isDone).toBe(true);
      // A field the streams are still ordered by cannot be left out of a merge.
      expect(() => mergedStream([query1, query2], ["c"])).toThrow(
        'indexFields must be some sequence of fields the stream is ordered by: ["c","_creationTime","_id"], ["a","b","c","_creationTime","_id"] (1 equality fields)',
      );
    });
  });

  test("merge streams between indexes", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 2, c: 3 });
      await ctx.db.insert("foo", { a: 1, b: 3, c: 4 });
      await ctx.db.insert("foo", { a: 2, b: 2, c: 5 });
      await ctx.db.insert("foo", { a: 3, b: 1, c: 6 });
      const query1 = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 2).eq("b", 2));
      const query2 = stream(ctx.db, schema)
        .query("foo")
        .withIndex("ac", (q) => q.eq("a", 1));
      const merged = mergedStream([query1, query2], ["c"]);
      expect((await merged.collect()).map(stripSystemFields)).toEqual([
        { a: 1, b: 2, c: 3 },
        { a: 1, b: 3, c: 4 },
        { a: 2, b: 2, c: 5 },
      ]);
    });
  });

  test.each(["asc", "desc"] as const)(
    "merged pagination preserves fixed fields when a range becomes empty (%s)",
    async (order) => {
      const t = setup();
      await t.run(async (ctx: any) => {
        for (const doc of MANY_DOCS) await ctx.db.insert("foo", doc);
        const db = stream(ctx.db, schema);
        const query = mergedStream(
          [
            db
              .query("foo")
              .withIndex("abc", (q) => q.eq("a", 1).lte("b", 0))
              .order(order),
            db
              .query("foo")
              .withIndex("abc", (q) => q.eq("a", 2).gte("b", 2))
              .order(order),
          ],
          ["b", "c"],
        );
        const expected = MANY_DOCS.filter(({ a, b }) => (a === 1 && b === 0) || (a === 2 && b === 2));
        if (order === "desc") expected.reverse();
        let cursor: string | null = null;
        for (const [i, doc] of expected.entries()) {
          const remaining = await query.paginate({ cursor, numItems: 100 });
          expect(remaining.page.map(stripSystemFields)).toEqual(expected.slice(i));
          const page = await query.paginate({ cursor, numItems: 1 });
          expect(page.page.map(stripSystemFields)).toEqual([doc]);
          cursor = page.continueCursor;
        }
        const last = await query.paginate({ cursor, numItems: 1 });
        expect(last.page).toEqual([]);
        expect(last.isDone).toBe(true);
      });
    },
  );

  test("map stream", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 2, c: 3 });
      await ctx.db.insert("foo", { a: 1, b: 3, c: 4 });
      await ctx.db.insert("foo", { a: 2, b: 2, c: 5 });
      const query = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1));
      const mapped = query.map(async (doc) => `doc with c: ${doc.c}`);
      expect(await mapped.collect()).toEqual(["doc with c: 3", "doc with c: 4"]);
      const page1 = await mapped.paginate({ numItems: 1, cursor: null });
      expect(page1.page).toEqual(["doc with c: 3"]);
      const page2 = await mapped.paginate({ numItems: 2, cursor: page1.continueCursor });
      expect(page2.page).toEqual(["doc with c: 4"]);
      expect(page2.isDone).toBe(true);
    });
  });

  test("flatMap stream", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 2, c: 3 });
      await ctx.db.insert("foo", { a: 1, b: 3, c: 4 });
      await ctx.db.insert("foo", { a: 2, b: 2, c: 5 }); // excluded by index
      // The table joined.
      await ctx.db.insert("bar", { c: 3, d: 4, e: 5 });
      await ctx.db.insert("bar", { c: 3, d: 1, e: 2 });
      await ctx.db.insert("bar", { c: 4, d: 2, e: 3 });
      await ctx.db.insert("bar", { c: 5, d: 3, e: 4 }); // joined document excluded by index
      const query = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1));
      const flatMapped = query.flatMap(
        async (doc) =>
          stream(ctx.db, schema)
            .query("bar")
            .withIndex("cde", (q) => q.eq("c", doc.c))
            .map(async (joinDoc) => ({ ...joinDoc, ...doc })),
        ["c", "d", "e"],
      );
      expect((await flatMapped.collect()).map(stripSystemFields)).toEqual([
        { a: 1, b: 2, c: 3, d: 1, e: 2 },
        { a: 1, b: 2, c: 3, d: 4, e: 5 },
        { a: 1, b: 3, c: 4, d: 2, e: 3 },
      ]);
    });
  });

  test.each(["asc", "desc"] as const)("flatMap pagination preserves later outer items (%s)", async (order) => {
    const t = setup();
    await t.run(async (ctx: any) => {
      // The join keys run against the outer stream's order.
      for (const a of [1, 2, 3]) {
        const c = 4 - a;
        await ctx.db.insert("foo", { a, b: 0, c });
        for (const d of [1, 2, 3]) await ctx.db.insert("bar", { c, d, e: 0 });
      }
      const query = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc")
        .order(order)
        // A mapped item need not keep its index fields.
        .map(async (doc) => ({ joinKey: doc.c }))
        .flatMap(
          async (doc) =>
            stream(ctx.db, schema)
              .query("bar")
              .withIndex("cde", (q) => q.eq("c", doc.joinKey))
              .order(order),
          ["c", "d", "e"],
        );
      const all = await query.collect();
      expect(all).toHaveLength(9);

      const first = await query.paginate({ cursor: null, numItems: 1 });
      const rest = await query.paginate({ cursor: first.continueCursor, numItems: 10 });
      expect([...first.page, ...rest.page]).toEqual(all);
      expect(rest.isDone).toBe(true);

      for (const numItems of [1, 2, 4]) {
        let cursor: string | null = null;
        const paged = [];
        for (let i = 0; i <= all.length; i++) {
          const page = await query.paginate({ cursor, numItems });
          const reread = await query.paginate({ cursor, endCursor: page.continueCursor, numItems });
          expect(reread.page).toEqual(page.page);
          paged.push(...page.page);
          if (page.isDone) break;
          expect(page.continueCursor).not.toBe(cursor as any);
          cursor = page.continueCursor;
        }
        expect(paged).toEqual(all);
      }

      // Both bounds within one outer item, across adjacent ones, and with a whole outer item between them.
      const cursors: (string | null)[] = [null];
      for (let i = 0; i < all.length; i++) {
        const page = await query.paginate({ cursor: cursors[i]!, numItems: 1 });
        cursors.push(page.continueCursor);
      }
      for (const [start, end] of [
        [1, 2],
        [2, 5],
        [1, 8],
      ] as const) {
        const page = await query.paginate({ cursor: cursors[start]!, endCursor: cursors[end]!, numItems: 1 });
        expect(page.page).toEqual(all.slice(start, end));
        if (page.splitCursor) {
          const left = await query.paginate({ cursor: cursors[start]!, endCursor: page.splitCursor, numItems: 1 });
          const right = await query.paginate({ cursor: page.splitCursor, endCursor: cursors[end]!, numItems: 1 });
          expect([...left.page, ...right.page]).toEqual(page.page);
        }
      }
    });
  });

  test.each(["asc", "desc"] as const)(
    "nested flatMap keeps each cursor prefix until that level advances (%s)",
    async (order) => {
      const t = setup();
      await t.run(async (ctx: any) => {
        for (const value of [0, 1, 2]) {
          await ctx.db.insert("a", { a: value });
          await ctx.db.insert("b", { b: value });
          await ctx.db.insert("c", { c: value });
        }
        const db = stream(ctx.db, schema);
        const a = db.query("a").withIndex("a").order(order);
        const b = db.query("b").withIndex("b").order(order);
        const c = db.query("c").withIndex("c").order(order);
        const ab = a.flatMap(async (aDoc) => b.map(async (bDoc) => ({ a: aDoc.a, b: bDoc.b })), b.getIndexFields());
        const bc = b.flatMap(async (bDoc) => c.map(async (cDoc) => ({ b: bDoc.b, c: cDoc.c })), c.getIndexFields());
        // Both (a.flatMap(b)).flatMap(c) and a.flatMap(b.flatMap(c)).
        const queries = [
          ab.flatMap(async (abDoc) => c.map(async (cDoc) => ({ ...abDoc, c: cDoc.c })), c.getIndexFields()),
          a.flatMap(async (aDoc) => bc.map(async (bcDoc) => ({ a: aDoc.a, ...bcDoc })), bc.getIndexFields()),
        ];
        const expected = MANY_DOCS.slice();
        if (order === "desc") expected.reverse();
        for (const query of queries) {
          expect(await query.collect()).toEqual(expected);
          const cursors: (string | null)[] = [null];
          for (const [i, doc] of expected.entries()) {
            const cursor = cursors[i]!;
            const remaining = await query.paginate({ cursor, numItems: 100 });
            expect(remaining.page).toEqual(expected.slice(i));
            expect(remaining.isDone).toBe(true);
            const page = await query.paginate({ cursor, numItems: 1 });
            expect(page.page).toEqual([doc]);
            cursors.push(page.continueCursor);
          }
          // Finish c, then b, before a moves on; and clip at the upper edge.
          for (const [start, end] of [
            [13, 14],
            [13, 17],
            [13, 22],
          ] as const) {
            const page = await query.paginate({ cursor: cursors[start]!, endCursor: cursors[end]!, numItems: 1 });
            expect(page.page).toEqual(expected.slice(start, end));
          }
          const last = await query.paginate({ cursor: cursors.at(-1)!, numItems: 1 });
          expect(last.page).toEqual([]);
          expect(last.isDone).toBe(true);
        }
      });
    },
  );

  test.each(["asc", "desc"] as const)(
    "flatMap resumes merged inner streams after a skipped outer item (%s)",
    async (order) => {
      const t = setup();
      await t.run(async (ctx: any) => {
        for (const a of [1, 2, 3]) {
          await ctx.db.insert("foo", { a, b: 0, c: a });
          for (const d of [1, 2]) await ctx.db.insert("bar", { c: a, d, e: 0 });
        }
        const query = stream(ctx.db, schema)
          .query("foo")
          .withIndex("abc")
          .order(order)
          .filterWith(async (doc) => doc.a === 2)
          .flatMap(
            async (doc) =>
              mergedStream(
                [1, 2].map((d) =>
                  stream(ctx.db, schema)
                    .query("bar")
                    .withIndex("cde", (q) => q.eq("c", doc.c).eq("d", d))
                    .order(order),
                ),
                ["e"],
              ),
            ["e"],
          );
        const all = await query.collect();
        expect(all).toHaveLength(2);
        const first = await query.paginate({ cursor: null, numItems: 10, maximumRowsRead: 1 });
        expect(first.page).toEqual([]);
        expect(first.isDone).toBe(false);
        const rest = await query.paginate({ cursor: first.continueCursor, numItems: 10 });
        expect(rest.page).toEqual(all);
        expect(rest.isDone).toBe(true);
      });
    },
  );

  test("streamIndexRange returns correct subset", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 4, c: 0 });
      await ctx.db.insert("foo", { a: 1, b: 5, c: 0 });
      await ctx.db.insert("foo", { a: 1, b: 6, c: 0 });
      const bounds = { lowerBound: [1, 5], lowerBoundInclusive: true, upperBound: [1, 6], upperBoundInclusive: false };
      const result = await streamIndexRange(ctx.db, schema, "foo", "abc", bounds, "asc").collect();
      expect(result.map(stripSystemFields)).toEqual([{ a: 1, b: 5, c: 0 }]);
    });
  });

  test.each(["asc", "desc"] as const)(
    "streamIndexRange resumes within and beyond a bounded prefix (%s)",
    async (order) => {
      const t = setup();
      await t.run(async (ctx: any) => {
        for (const doc of MANY_DOCS) await ctx.db.insert("foo", doc);
        const query = streamIndexRange(
          ctx.db,
          schema,
          "foo",
          "abc",
          { lowerBound: [1, 1], lowerBoundInclusive: true, upperBound: [], upperBoundInclusive: true },
          order,
        );
        const expected = MANY_DOCS.filter(({ a, b }) => a > 1 || (a === 1 && b >= 1));
        if (order === "desc") expected.reverse();
        expect((await query.collect()).map(stripSystemFields)).toEqual(expected);
        let cursor: string | null = null;
        for (const [i, doc] of expected.entries()) {
          const remaining = await query.paginate({ cursor, numItems: 100 });
          expect(remaining.page.map(stripSystemFields)).toEqual(expected.slice(i));
          expect(remaining.isDone).toBe(true);
          const page = await query.paginate({ cursor, numItems: 1 });
          expect(page.page.map(stripSystemFields)).toEqual([doc]);
          cursor = page.continueCursor;
        }
        const last = await query.paginate({ cursor, numItems: 1 });
        expect(last.page).toEqual([]);
        expect(last.isDone).toBe(true);
      });
    },
  );

  test.each(["asc", "desc"] as const)(
    "streamIndexRange handles empty intervals and inclusive prefixes (%s)",
    async (order) => {
      const t = setup();
      await t.run(async (ctx: any) => {
        for (const doc of MANY_DOCS) await ctx.db.insert("foo", doc);
        for (const lowerBoundInclusive of [true, false]) {
          for (const upperBoundInclusive of [true, false]) {
            for (const [lowerBound, upperBound] of [
              [[2, 0, 1], [1]],
              [[2], [1, 2, 1]],
              [
                [1, 1],
                [1, 1],
              ],
              [
                [1, 1],
                [1, 1, 1],
              ],
              [
                [1, 1, 1],
                [1, 1],
              ],
            ] as const) {
              const query = streamIndexRange(
                ctx.db,
                schema,
                "foo",
                "abc",
                { lowerBound: [...lowerBound], lowerBoundInclusive, upperBound: [...upperBound], upperBoundInclusive },
                order,
              );
              const expected = MANY_DOCS.filter(({ a, b, c }) => {
                if (a !== 1 || b !== 1 || lowerBound[0] === 2) return false;
                const aboveLower =
                  lowerBound.length === 3 ? (lowerBoundInclusive ? c >= 1 : c > 1) : lowerBoundInclusive;
                const belowUpper =
                  upperBound.length === 3 ? (upperBoundInclusive ? c <= 1 : c < 1) : upperBoundInclusive;
                return aboveLower && belowUpper;
              });
              if (order === "desc") expected.reverse();
              expect({
                bounds: [lowerBound, lowerBoundInclusive, upperBound, upperBoundInclusive],
                docs: (await query.collect()).map(stripSystemFields),
              }).toEqual({
                bounds: [lowerBound, lowerBoundInclusive, upperBound, upperBoundInclusive],
                docs: expected,
              });
            }
          }
        }
      });
    },
  );

  test.each(["asc", "desc"] as const)("exclusive empty prefixes produce empty index ranges (%s)", async (order) => {
    const t = setup();
    await t.run(async (ctx: any) => {
      for (const doc of MANY_DOCS) await ctx.db.insert("foo", doc);
      for (const [lowerBound, upperBound] of [
        [[], []],
        [[], [1]],
        [[1], []],
      ]) {
        for (const lowerBoundInclusive of [true, false]) {
          for (const upperBoundInclusive of [true, false]) {
            if ((lowerBound!.length !== 0 || lowerBoundInclusive) && (upperBound!.length !== 0 || upperBoundInclusive))
              continue;
            const query = streamIndexRange(
              ctx.db,
              schema,
              "foo",
              "abc",
              { lowerBound: lowerBound!, lowerBoundInclusive, upperBound: upperBound!, upperBoundInclusive },
              order,
            );
            expect(await query.collect()).toEqual([]);
          }
        }
      }
      const unbounded = stream(ctx.db, schema).query("foo").withIndex("abc").order(order);
      const page = await unbounded.paginate({ cursor: "[]", numItems: 1 });
      expect(page.page).toEqual([]);
      expect(page.isDone).toBe(true);
    });
  });

  test("paginate with 0 numItems", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      const query = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1));
      const page = await query.paginate({ numItems: 0, cursor: "" });
      expect(page.page).toEqual([]);
      expect(page.isDone).toBe(false);
      expect(page.continueCursor).toBe("");
      await expect(query.paginate({ numItems: 0, cursor: null })).rejects.toThrow(
        ".paginate called with cursor of null and 0 for numItems. This is not supported, as null is not a valid continueCursor. Advice: avoid calling paginate entirely in these cases.",
      );
    });
  });

  test("paginate respects endCursor", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 1, c: 0 });
      await ctx.db.insert("foo", { a: 1, b: 2, c: 0 });
      await ctx.db.insert("foo", { a: 1, b: 3, c: 0 });
      const query = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1))
        .order("asc");
      const endCursor = JSON.stringify(toJsonValue([1, 2, 0]));
      const page = await query.paginate({ numItems: 10, cursor: null, endCursor });
      expect(page.page.map(stripSystemFields)).toEqual([
        { a: 1, b: 1, c: 0 },
        { a: 1, b: 2, c: 0 },
      ]);
      // Short of the range's end, a page up to an endCursor is not done: pagination runs to the range's end.
      expect(page.isDone).toBe(false);
    });
  });

  test("paginate cant reconnect cursors with endCursor", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 1, c: 0 });
      await ctx.db.insert("foo", { a: 1, b: 2, c: 0 });
      await ctx.db.insert("foo", { a: 1, b: 3, c: 0 });
      const withoutEndCursor = await stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1))
        .order("asc")
        .paginate({ numItems: 2, cursor: null });
      expect(withoutEndCursor.page.map(stripSystemFields)).toEqual([
        { a: 1, b: 1, c: 0 },
        { a: 1, b: 2, c: 0 },
      ]);
      expect(withoutEndCursor.isDone).toBe(false);
      const query = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1))
        .order("asc");
      const page = await query.paginate({ numItems: 10, cursor: null, endCursor: withoutEndCursor.continueCursor });
      expect(page.page.map(stripSystemFields)).toEqual([
        { a: 1, b: 1, c: 0 },
        { a: 1, b: 2, c: 0 },
      ]);
      expect(page.isDone).toBe(false);
    });
  });

  test("flatMap ignores null outer items", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 2, c: 3 });
      const result = await stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1))
        .filterWith(async () => false)
        .flatMap(async () => null as any, ["a", "b", "c"])
        .collect();
      expect(result).toEqual([]);
    });
  });

  test("distinct stream", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 2, c: 3 });
      await ctx.db.insert("foo", { a: 1, b: 2, c: 5 });
      await ctx.db.insert("foo", { a: 1, b: 3, c: 4 });
      await ctx.db.insert("foo", { a: 1, b: 4, c: 1 });
      await ctx.db.insert("foo", { a: 1, b: 4, c: 3 });
      await ctx.db.insert("foo", { a: 2, b: 5, c: 6 });
      const query = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1));
      expect((await query.distinct(["b"]).collect()).map(stripSystemFields)).toEqual([
        { a: 1, b: 2, c: 3 },
        { a: 1, b: 3, c: 4 },
        { a: 1, b: 4, c: 1 },
      ]);
    });
  });

  test.each([{ order: "asc" }, { order: "desc" }] as const)("distinct pagination works ($order)", async ({ order }) => {
    const t = setup();
    await t.run(async (ctx: any) => {
      const values = [
        { a: 1, b: 2, c: 3 },
        { a: 1, b: 2, c: 5 },
        { a: 1, b: 2, c: 6 },
        { a: 1, b: 3, c: 7 },
        { a: 1, b: 3, c: 8 },
        { a: 1, b: 4, c: 9 },
        { a: 1, b: 4, c: 10 },
        { a: 1, b: 5, c: 0 },
        { a: 1, b: 6, c: 0 },
      ];
      const expected =
        order === "asc"
          ? [
              { a: 1, b: 2, c: 3 },
              { a: 1, b: 3, c: 7 },
              { a: 1, b: 4, c: 9 },
              { a: 1, b: 5, c: 0 },
              { a: 1, b: 6, c: 0 },
            ]
          : [
              { a: 1, b: 6, c: 0 },
              { a: 1, b: 5, c: 0 },
              { a: 1, b: 4, c: 10 },
              { a: 1, b: 3, c: 8 },
              { a: 1, b: 2, c: 6 },
            ];
      for (const value of values) await ctx.db.insert("foo", value);
      const doPaginate = (cursor: string | null) =>
        stream(ctx.db, schema)
          .query("foo")
          .withIndex("abc", (q) => q.eq("a", 1))
          .order(order)
          .distinct(["b"])
          .paginate({ numItems: 2, cursor });
      const page1 = await doPaginate(null);
      expect(page1.page.map(stripSystemFields)).toEqual(expected.slice(0, 2));
      expect(page1.isDone).toBe(false);
      const page2 = await doPaginate(page1.continueCursor);
      expect(page2.page.map(stripSystemFields)).toEqual(expected.slice(2, 4));
      expect(page2.isDone).toBe(false);
      const page3 = await doPaginate(page2.continueCursor);
      expect(page3.page.map(stripSystemFields)).toEqual(expected.slice(4, 6));
      expect(page3.isDone).toBe(true);
    });
  });

  // SELECT * FROM foo WHERE a = 1 AND b > 1 AND b < 5 AND c > 3
  test("loose index scan", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 1, c: 4 }); // excluded by outer
      await ctx.db.insert("foo", { a: 1, b: 2, c: 1 }); // excluded by inner
      await ctx.db.insert("foo", { a: 1, b: 3, c: 1 }); // excluded by inner
      await ctx.db.insert("foo", { a: 1, b: 3, c: 5 });
      await ctx.db.insert("foo", { a: 1, b: 3, c: 6 });
      await ctx.db.insert("foo", { a: 1, b: 4, c: 4 });
      await ctx.db.insert("foo", { a: 1, b: 5, c: 4 }); // excluded by outer
      await ctx.db.insert("foo", { a: 2, b: 5, c: 6 }); // excluded by outer
      const query = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1).gt("b", 1).lt("b", 5))
        .distinct(["b"])
        .flatMap(
          async (doc) =>
            stream(ctx.db, schema)
              .query("foo")
              .withIndex("abc", (q) => q.eq("a", 1).eq("b", doc.b).gt("c", 3)),
          ["a", "b", "c"],
        );
      expect((await query.collect()).map(stripSystemFields)).toEqual([
        { a: 1, b: 3, c: 5 },
        { a: 1, b: 3, c: 6 },
        { a: 1, b: 4, c: 4 },
      ]);
      const page1 = await query.paginate({ numItems: 2, cursor: null, maximumRowsRead: 2 });
      // b = 2's inner stream is empty, so b = 2 counts as one row read, as a filtered-out item would.
      expect(page1.page.map(stripSystemFields)).toEqual([{ a: 1, b: 3, c: 5 }]);
    });
  });

  test("undefined cursor serialization roundtrips", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("undefinedNumbers", { a: 1, b: 2 });
      await ctx.db.insert("undefinedNumbers", { a: undefined, b: 3 });
      await ctx.db.insert("undefinedNumbers", { a: 2, b: 4 });
      await ctx.db.insert("undefinedNumbers", { a: undefined, b: 5 });
      const query = stream(ctx.db, schema).query("undefinedNumbers").withIndex("ab");
      const result = await query.paginate({ numItems: 1, cursor: null });
      expect(result.continueCursor).toStartWith('["undefined",');
      expect(result.page.map(stripSystemFields)).toEqual([{ a: undefined, b: 3 }]);
      expect(result.isDone).toBe(false);
      const page1 = await query.paginate({ numItems: 2, cursor: result.continueCursor });
      expect(page1.page.map(stripSystemFields)).toEqual([{ b: 5 }, { a: 1, b: 2 }]);
      expect(page1.isDone).toBe(false);
      const page2 = await query.paginate({ numItems: 2, cursor: page1.continueCursor });
      expect(page2.page.map(stripSystemFields)).toEqual([{ a: 2, b: 4 }]);
      expect(page2.isDone).toBe(true);
    });
  });

  test("literal undefined string works", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("undefinedStrings", { a: undefined, b: 1 });
      await ctx.db.insert("undefinedStrings", { a: "undefined", b: 2 });
      const query = stream(ctx.db, schema).query("undefinedStrings").withIndex("ab");
      const result = await query.paginate({ numItems: 1, cursor: null });
      expect(result.continueCursor).toStartWith('["undefined",');
      expect(result.page.map(stripSystemFields)).toEqual([{ a: undefined, b: 1 }]);
      expect(result.isDone).toBe(false);
      const page1 = await query.paginate({ numItems: 1, cursor: result.continueCursor });
      expect(page1.continueCursor).toStartWith('["_undefined",');
      expect(page1.page.map(stripSystemFields)).toEqual([{ a: "undefined", b: 2 }]);
    });
  });
});

describe("bandwidth tracking", () => {
  /** The items of an `iterWithKeys(…)` and the bytes each charged, up to `maxItems`. */
  async function collectBandwidth<T extends NonNullable<unknown>>(
    iterable: AsyncIterable<[T | null, IndexKey, number]>,
    maxItems?: number,
  ) {
    const items: (T | null)[] = [];
    const bandwidths: number[] = [];
    let totalBandwidth = 0;
    for await (const [doc, _, bandwidth] of iterable) {
      items.push(doc);
      bandwidths.push(bandwidth);
      totalBandwidth += bandwidth;
      if (maxItems !== undefined && items.length >= maxItems) break;
    }
    return { items, totalBandwidth, bandwidths };
  }

  test("iterWithKeys tracks bandwidth when enabled", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 2, c: 3 });
      await ctx.db.insert("foo", { a: 1, b: 3, c: 4 });
      const query = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1));
      const expectedSizes = (await ctx.db.query("foo").collect()).map((doc: any) => getDocumentSize(doc));
      const expectedTotal = expectedSizes.reduce((a: number, b: number) => a + b, 0);
      const withTracking = await collectBandwidth(query.iterWithKeys(true));
      expect(withTracking.items.length).toBe(2);
      expect(withTracking.totalBandwidth).toBe(expectedTotal);
      expect(withTracking.bandwidths).toEqual(expectedSizes);
      const withoutTracking = await collectBandwidth(query.iterWithKeys(false));
      expect(withoutTracking.items.length).toBe(2);
      expect(withoutTracking.totalBandwidth).toBe(0);
      expect(withoutTracking.bandwidths).toEqual([0, 0]);
    });
  });

  test("basic stream paginate respects maximumBytesRead", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 1, c: 0 });
      await ctx.db.insert("foo", { a: 1, b: 2, c: 0 });
      await ctx.db.insert("foo", { a: 1, b: 3, c: 0 });
      const query = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1));
      const oneDocSize = getDocumentSize((await query.first())!);
      const page1 = await query.paginate({ numItems: 10, cursor: null, maximumBytesRead: oneDocSize });
      expect(page1.page.length).toBe(1);
      expect(page1.isDone).toBe(false);
      expect(page1.pageStatus).toBe("SplitRequired");
      const page2 = await query.paginate({ numItems: 10, cursor: null, maximumBytesRead: oneDocSize * 2 });
      expect(page2.page.length).toBe(2);
      expect(page2.isDone).toBe(false);
      const pageAll = await query.paginate({ numItems: 10, cursor: null, maximumBytesRead: oneDocSize * 100 });
      expect(pageAll.page.length).toBe(3);
      expect(pageAll.isDone).toBe(true);
    });
  });

  test("filterWith tracks bandwidth for filtered-out docs", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 1, c: 0 }); // filtered out
      await ctx.db.insert("foo", { a: 1, b: 2, c: 0 }); // filtered out
      await ctx.db.insert("foo", { a: 1, b: 3, c: 1 });
      await ctx.db.insert("foo", { a: 1, b: 4, c: 1 });
      const filtered = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1))
        .filterWith(async (doc) => doc.c === 1);
      const expectedSizes = (await ctx.db.query("foo").collect()).map((doc: any) => getDocumentSize(doc));
      const bw = await collectBandwidth(filtered.iterWithKeys(true));
      // Two left out and two kept: every one charged its own size.
      expect(bw.items.length).toBe(4);
      expect(bw.bandwidths).toEqual(expectedSizes);
      const page = await filtered.paginate({ numItems: 10, cursor: null, maximumBytesRead: expectedSizes[0]! * 2 });
      // The two left out count towards the bytes: the page stops after them, empty.
      expect(page.page.length).toEqual(0);
      expect(page.isDone).toBe(false);
      expect(page.pageStatus).toBe("SplitRequired");
    });
  });

  test("mergedStream tracks bandwidth for pre-fetched docs", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 1, c: 0 });
      await ctx.db.insert("foo", { a: 2, b: 2, c: 0 });
      await ctx.db.insert("foo", { a: 3, b: 3, c: 0 });
      const queries = [1, 2, 3].map((a) =>
        stream(ctx.db, schema)
          .query("foo")
          .withIndex("abc", (q) => q.eq("a", a)),
      );
      const merged = mergedStream(queries, ["a", "b", "c"]);
      const docSizes = (await ctx.db.query("foo").collect()).map((doc: any) => getDocumentSize(doc));
      const expectedTotal = docSizes.reduce((a: number, b: number) => a + b, 0);
      // The first item reads ahead in all three streams, and is charged all three.
      const bw = await collectBandwidth(merged.iterWithKeys(true), 1);
      expect(bw.items.length).toBe(1);
      expect(bw.bandwidths[0]).toBe(expectedTotal);
      const bwAll = await collectBandwidth(merged.iterWithKeys(true));
      expect(bwAll.items.length).toBe(3);
      expect(bwAll.totalBandwidth).toBe(expectedTotal);
      expect(bwAll.bandwidths[0]).toBe(expectedTotal);
      // With a one-document byte limit the first item, which read three, stops the page.
      const page = await merged.paginate({ numItems: 10, cursor: null, maximumBytesRead: docSizes[0]! });
      expect(page.page.length).toBe(1);
      expect(page.isDone).toBe(false);
      expect(page.pageStatus).toBe("SplitRequired");
    });
  });

  test("map stream tracks bandwidth of original docs", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 1, c: 0 });
      await ctx.db.insert("foo", { a: 1, b: 2, c: 0 });
      await ctx.db.insert("foo", { a: 1, b: 3, c: 0 });
      const mapped = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1))
        .map(async (doc) => `val: ${doc.b}`);
      const expectedSizes = (await ctx.db.query("foo").collect()).map((doc: any) => getDocumentSize(doc));
      const expectedTotal = expectedSizes.reduce((a: number, b: number) => a + b, 0);
      const bw = await collectBandwidth(mapped.iterWithKeys(true));
      expect(bw.items).toEqual(["val: 1", "val: 2", "val: 3"]);
      // The documents read, not the mapped values.
      expect(bw.totalBandwidth).toBe(expectedTotal);
      expect(bw.bandwidths).toEqual(expectedSizes);
      const page = await mapped.paginate({ numItems: 10, cursor: null, maximumBytesRead: expectedSizes[0]! });
      expect(page.page.length).toBe(1);
      expect(page.isDone).toBe(false);
    });
  });

  test("flatMap tracks bandwidth for outer and inner docs", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 2, c: 3 });
      await ctx.db.insert("foo", { a: 1, b: 3, c: 4 });
      await ctx.db.insert("bar", { c: 3, d: 1, e: 1 });
      await ctx.db.insert("bar", { c: 3, d: 2, e: 2 });
      await ctx.db.insert("bar", { c: 4, d: 1, e: 1 });
      const flatMapped = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1))
        .flatMap(
          async (doc) =>
            stream(ctx.db, schema)
              .query("bar")
              .withIndex("cde", (q) => q.eq("c", doc.c)),
          ["c", "d", "e"],
        );
      const fooSizes = (await ctx.db.query("foo").collect()).map((doc: any) => getDocumentSize(doc));
      const barSizes = (await ctx.db.query("bar").collect()).map((doc: any) => getDocumentSize(doc));
      const bw = await collectBandwidth(flatMapped.iterWithKeys(true));
      expect(bw.items.length).toBe(3);
      // The outer document is charged with its first inner one.
      expect(bw.bandwidths).toEqual([fooSizes[0] + barSizes[0], barSizes[1], fooSizes[1] + barSizes[2]]);
      expect(bw.totalBandwidth).toBe(fooSizes[0] + fooSizes[1] + barSizes[0] + barSizes[1] + barSizes[2]);
      const page = await flatMapped.paginate({ numItems: 10, cursor: null, maximumBytesRead: fooSizes[0] });
      expect(page.page.length).toBeLessThanOrEqual(2);
      expect(page.isDone).toBe(false);
    });
  });

  test("distinct stream tracks bandwidth", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 2, c: 3 });
      await ctx.db.insert("foo", { a: 1, b: 2, c: 5 }); // skipped by distinct
      await ctx.db.insert("foo", { a: 1, b: 3, c: 4 });
      await ctx.db.insert("foo", { a: 1, b: 4, c: 1 });
      const distinct = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1))
        .distinct(["b"]);
      const docSizes = (await ctx.db.query("foo").collect()).map((doc: any) => getDocumentSize(doc));
      const bw = await collectBandwidth(distinct.iterWithKeys(true));
      // One document read per group.
      expect(bw.items.length).toBe(3);
      expect(bw.bandwidths).toEqual([docSizes[0], docSizes[2], docSizes[3]]);
      const page = await distinct.paginate({ numItems: 10, cursor: null, maximumBytesRead: docSizes[0] });
      expect(page.page.length).toBe(1);
      expect(page.isDone).toBe(false);
      expect(page.pageStatus).toBe("SplitRequired");
    });
  });

  test("streamIndexRange tracks bandwidth", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("foo", { a: 1, b: 4, c: 0 });
      await ctx.db.insert("foo", { a: 1, b: 5, c: 0 });
      await ctx.db.insert("foo", { a: 1, b: 6, c: 0 });
      const rangeStream = streamIndexRange(
        ctx.db,
        schema,
        "foo",
        "abc",
        { lowerBound: [1, 4], lowerBoundInclusive: true, upperBound: [1, 6], upperBoundInclusive: true },
        "asc",
      );
      const expectedTotal = (await ctx.db.query("foo").collect()).reduce(
        (sum: number, doc: any) => sum + getDocumentSize(doc),
        0,
      );
      const bw = await collectBandwidth(rangeStream.iterWithKeys(true));
      expect(bw.items.length).toBe(3);
      expect(bw.totalBandwidth).toBe(expectedTotal);
    });
  });

  test("pagination continues correctly after maximumBytesRead", async () => {
    const t = setup();
    await t.run(async (ctx: any) => {
      for (const b of [1, 2, 3, 4]) await ctx.db.insert("foo", { a: 1, b, c: 0 });
      const query = stream(ctx.db, schema)
        .query("foo")
        .withIndex("abc", (q) => q.eq("a", 1));
      const oneDocSize = getDocumentSize((await query.first())!);
      const page1 = await query.paginate({ numItems: 10, cursor: null, maximumBytesRead: oneDocSize });
      expect(page1.page.map(stripSystemFields)).toEqual([{ a: 1, b: 1, c: 0 }]);
      expect(page1.isDone).toBe(false);
      const page2 = await query.paginate({
        numItems: 10,
        cursor: page1.continueCursor,
        maximumBytesRead: oneDocSize,
      });
      expect(page2.page.map(stripSystemFields)).toEqual([{ a: 1, b: 2, c: 0 }]);
      expect(page2.isDone).toBe(false);
      const page3 = await query.paginate({
        numItems: 10,
        cursor: page2.continueCursor,
        maximumBytesRead: oneDocSize * 100,
      });
      expect(page3.page.map(stripSystemFields)).toEqual([
        { a: 1, b: 3, c: 0 },
        { a: 1, b: 4, c: 0 },
      ]);
      expect(page3.isDone).toBe(true);
    });
  });
});

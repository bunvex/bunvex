// `.paginate()` at a transaction limit (STUDY-108), as Convex's `read_page_from_query`: a limit hit while
// reading ends the page with `SplitRequired` at the last document read instead of failing the function; before
// any document, a first page fails with a system error. The error an app sees elsewhere is unchanged: a plain
// Error with Convex's message, no code. Also Convex's page limits (`IndexRange`): none on a pinned page, checked
// before reading the next document, the split cursor from every document read, the soft limits.
import { describe, expect, test } from "bun:test";
import { v, valueSize } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { type Doc, defineSchema, defineTable } from "../src/schema.ts";
import { type PaginationResult, QueryCursorError, type Tx } from "../src/tx.ts";

async function engine(n = 0, fields: Record<string, unknown> = {}) {
  const schema = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]), other: defineTable(v.any()) });
  const e = await new Engine(schema, await MemoryPersistence.open(null, { durable: false }), {
    instanceSecret: "s1",
  }).init();
  for (let done = 0; done < n; done += 1000)
    await e.mutation(async (db) => {
      for (let i = done; i < Math.min(n, done + 1000); i++) await db.insert("items", { n: i, ...fields });
    });
  return e;
}
const ns = (docs: Doc[]) => docs.map((d) => d.n);
type Opts = { cursor?: string | null; endCursor?: string | null; maximumRowsRead?: number };
const paginate = (db: Tx, numItems: number, o: Opts = {}) =>
  db
    .query("items")
    .withIndex("by_n")
    .paginate({ numItems, cursor: o.cursor ?? null, ...o });

describe(".paginate() at a transaction limit (STUDY-108)", () => {
  test("the documents-read limit ends the page with SplitRequired; the cursor continues at the next document", async () => {
    const e = await engine(20);
    const r = await e.query(async (db) => {
      db.limits.documentsRead = 7;
      const p = await paginate(db, 15);
      // The function goes on; the next read is over the limit, with the same plain message.
      let after: unknown = null;
      try {
        await db.query("other").first();
        await db.query("items").first();
      } catch (x) {
        after = x;
      }
      return { p, after, docsRead: db.usage.documentsRead };
    });
    expect(ns(r.p.page)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect([r.p.pageStatus, r.p.isDone]).toEqual(["SplitRequired", false]);
    expect(r.docsRead).toBe(9); // the 8th document read was charged (as Convex's), and the read after it
    const msg =
      "Too many documents read in a single function execution (limit: 7). Consider using smaller limits in your queries, paginating your queries, or using indexed queries with a selective index range expressions.";
    expect(r.after).toBeInstanceOf(Error);
    expect((r.after as Error).constructor).toBe(Error); // no class or code an app could see
    expect((r.after as Error).message).toBe(msg);
    expect(Object.keys(r.after as Error)).toEqual([]);
    const next = await e.query((db) => paginate(db, 15, { cursor: r.p.continueCursor }));
    expect(ns(next.page)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    // The split cursor halves what was read: the two halves are the page.
    const half = await e.query((db) => paginate(db, 15, { endCursor: r.p.splitCursor }));
    const rest = await e.query((db) => paginate(db, 15, { cursor: r.p.splitCursor, endCursor: r.p.continueCursor }));
    expect([...ns(half.page), ...ns(rest.page)]).toEqual(ns(r.p.page));
  });

  test("the bytes-read limit too", async () => {
    const e = await engine(10, { pad: "x".repeat(100) });
    const size = valueSize((await e.query((db) => db.query("items").first())) as never);
    const p = await e.query(async (db) => {
      db.limits.bytesRead = Math.floor(4.5 * size); // the 5th document goes over
      return paginate(db, 10);
    });
    expect([p.page.length, p.pageStatus, p.isDone]).toEqual([4, "SplitRequired", false]);
  });

  test("the read-interval limit: the page ends past its first document, empty", async () => {
    const e = await engine(5);
    const p = await e.query(async (db) => {
      const q = db.query("items").withIndex("by_n");
      db.limits.databaseQueries = db.usage.databaseQueries; // spent: the page's read goes over
      return q.paginate({ numItems: 3, cursor: null });
    });
    expect([ns(p.page), p.pageStatus, p.isDone]).toEqual([[], "SplitRequired", false]);
    // Convex's cursor moved past the first document before its read failed: the next page starts after it.
    const next = await e.query((db) => paginate(db, 3, { cursor: p.continueCursor }));
    expect(ns(next.page)).toEqual([1, 2, 3]);
    // Past the end, the cursor is already "end": done, split required.
    const end = await e.query((db) => paginate(db, 10));
    const past = await e.query(async (db) => {
      const q = db.query("items").withIndex("by_n");
      db.limits.databaseQueries = db.usage.databaseQueries;
      return q.paginate({ numItems: 3, cursor: end.continueCursor });
    });
    expect([past.page, past.pageStatus, past.isDone]).toEqual([[], "SplitRequired", true]);
  });

  test("before any document: a first page fails with a system error; a later page continues from its start", async () => {
    const e = await engine(5);
    const caught = e.query(async (db) => {
      db.limits.documentsRead = 0;
      try {
        return await paginate(db, 3);
      } catch (x) {
        return x;
      }
    });
    // In `Engine.query` there is no execution to fail (server/test covers the uncatchable side): it is thrown.
    const err = (await caught) as Error;
    expect(err).toBeInstanceOf(QueryCursorError);
    expect(err.message).toStartWith("This should be impossible. Hit pagination limit before setting query cursor");
    const first = await e.query((db) => paginate(db, 2));
    const p = await e.query(async (db) => {
      db.limits.documentsRead = 0;
      return paginate(db, 2, { cursor: first.continueCursor });
    });
    expect([p.page, p.pageStatus, p.isDone]).toEqual([[], "SplitRequired", false]);
    const again = await e.query((db) => paginate(db, 2, { cursor: p.continueCursor }));
    expect(ns(again.page)).toEqual([2, 3]);
    // Descending too: the page continues from its start, not from the range's.
    const desc = (db: Tx, cursor: string | null) =>
      db.query("items").withIndex("by_n").order("desc").paginate({ numItems: 2, cursor });
    const top = await e.query((db) => desc(db, null));
    const stuck = await e.query(async (db) => {
      db.limits.documentsRead = 0;
      return desc(db, top.continueCursor);
    });
    expect(ns((await e.query((db) => desc(db, stuck.continueCursor))).page)).toEqual([2, 1]);
  });

  test("a pinned page stopped by a limit still continues at its end", async () => {
    const e = await engine(20);
    const whole = await e.query((db) => paginate(db, 20));
    const p = await e.query(async (db) => {
      db.limits.documentsRead = 8;
      return paginate(db, 20, { endCursor: whole.continueCursor });
    });
    expect([p.page.length, p.pageStatus]).toEqual([8, "SplitRequired"]);
    expect(p.continueCursor).toBe(whole.continueCursor); // Convex: end_cursor.or_else(query.cursor())
  });

  test("other errors still fail the page", async () => {
    const e = await engine(5);
    await expect(
      e.query((db) =>
        db
          .query("items")
          .withIndex("by_n")
          .filter((q) => q.eq(q.field("n"), 1))
          .paginate({ numItems: 2, cursor: "not a cursor" }),
      ),
    ).rejects.toThrow("InvalidCursor");
  });
});

describe("Convex's page limits (IndexRange)", () => {
  test("maximumRowsRead stops before reading the next document, which is not charged", async () => {
    const e = await engine(20);
    const r = await e.query(async (db) => {
      const p = await paginate(db, 15, { maximumRowsRead: 5 });
      return { p, docsRead: db.usage.documentsRead };
    });
    expect([r.p.page.length, r.p.pageStatus, r.docsRead]).toEqual([5, "SplitRequired", 5]);
  });

  test("the split cursor: the middle document read (filtered out or not), on any page of three or more", async () => {
    const e = await engine(20);
    const r: PaginationResult = await e.query((db) =>
      db
        .query("items")
        .withIndex("by_n")
        .filter((q) => q.gte(q.field("n"), 10))
        .paginate({ numItems: 3, cursor: null }),
    );
    // 13 documents read (0..12), 3 in the page: no status, but a split cursor after document 6 (the page's
    // middle would be 11).
    expect([ns(r.page), r.pageStatus]).toEqual([[10, 11, 12], null]);
    const filtered = (o: Opts) =>
      e.query((db) =>
        db
          .query("items")
          .withIndex("by_n")
          .filter((q) => q.gte(q.field("n"), 10))
          .paginate({ numItems: 3, cursor: o.cursor ?? null, endCursor: o.endCursor }),
      );
    expect(ns((await filtered({ endCursor: r.splitCursor })).page)).toEqual([]);
    expect(ns((await filtered({ cursor: r.splitCursor, endCursor: r.continueCursor })).page)).toEqual([10, 11, 12]);
    const two = await e.query((db) => paginate(db, 2));
    expect(two.splitCursor).toBeNull();
  });

  test("past 3/4 of the transaction's read limit, with no page limit: SplitRecommended", async () => {
    const e = await engine(24_002);
    const r = await e.query((db) =>
      db
        .query("items")
        .withIndex("by_n")
        .filter((q) => q.gte(q.field("n"), 23_999))
        .paginate({ numItems: 1, cursor: null }),
    );
    expect([ns(r.page), r.pageStatus]).toEqual([[23_999], null]); // 24 000 read: not past 3/4 of 32 000
    const more = await e.query((db) =>
      db
        .query("items")
        .withIndex("by_n")
        .filter((q) => q.gte(q.field("n"), 24_000))
        .paginate({ numItems: 1, cursor: null }),
    );
    expect(more.pageStatus).toBe("SplitRecommended");
  }, 60_000);

  test("with the real limit: a page over 32 000 documents read is split, and paging goes on", async () => {
    const e = await engine(32_010);
    const r = await e.query(async (db) => {
      await db.query("items").withIndex("by_n").first(); // one document read before
      return paginate(db, 32_000);
    });
    expect([r.page.length, r.pageStatus, r.isDone]).toEqual([31_999, "SplitRequired", false]);
    const next = await e.query((db) => paginate(db, 100, { cursor: r.continueCursor }));
    expect(ns(next.page)[0]).toBe(31_999);
    expect(next.page).toHaveLength(11);
  }, 120_000);
});

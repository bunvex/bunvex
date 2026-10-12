// Edges of tx.ts's pagination, query runs, table stats and write limits (TEST-01 §7, the mutation triage):
// `.paginate()`'s option checks, cursors bound to their query (index, search text and filters), search
// pages, end cursors at the end, the page's read interval, its byte limits and soft limits, the system
// error a function cannot catch, `collect()`'s row cap, a virtual table's async mapping, the rows read
// per table, and the write limits at their boundaries.
import { describe, expect, test } from "bun:test";
import { rawValueSize, type Value, v, valueNesting } from "@bunvex/values";
import { newUserTimer, withUserTimer } from "../src/determinism.ts";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { type Doc, defineSchema, defineTable } from "../src/schema.ts";
import { QueryCursorError, type Tx } from "../src/tx.ts";

const schema = defineSchema({
  items: defineTable(v.any()).index("by_n", ["n"]).index("by_m", ["m"]),
  other: defineTable(v.any()),
  messages: defineTable(v.any()).searchIndex("search_body", { searchField: "body", filterFields: ["n"] }),
});

async function engine(n = 0, fields: Record<string, unknown> = {}) {
  const e = await new Engine(schema, await MemoryPersistence.open(null, { durable: false }), {
    instanceSecret: "s1",
  }).init();
  for (let done = 0; done < n; done += 1000)
    await e.mutation(async (db) => {
      for (let i = done; i < Math.min(n, done + 1000); i++) await db.insert("items", { n: i, m: i, ...fields });
    });
  await e.searchReady();
  return e;
}
const ns = (docs: Doc[]) => docs.map((d) => d.n);
const byN = (db: Tx) => db.query("items").withIndex("by_n");
const search = (db: Tx, text: string, n?: unknown) =>
  db
    .query("messages")
    .withSearchIndex("search_body", (q) =>
      n === undefined ? q.search("body", text) : q.search("body", text).eq("n", n),
    );
const addMessages = (e: Engine, docs: Record<string, unknown>[]) =>
  e.mutation(async (db) => {
    for (const d of docs) await db.insert("messages", d);
  });
const DIFFERENT_QUERY = "this cursor is from a different query";

describe("paginate's options", () => {
  test("no options, a non-number, a size below 1, a zero byte limit: Convex's messages", async () => {
    const e = await engine(3);
    await expect(e.query((db) => byN(db).paginate(undefined as never))).rejects.toThrow(
      "`options.numItems` must be a positive number. Received `undefined`.",
    );
    await expect(e.query((db) => byN(db).paginate({ numItems: "5" as never, cursor: null }))).rejects.toThrow(
      "`options.numItems` must be a positive number. Received `5`.",
    );
    await expect(e.query((db) => byN(db).paginate({ numItems: 0.5, cursor: null }))).rejects.toThrow(
      "Must request at least 1 document while paginating",
    );
    await expect(e.query((db) => byN(db).paginate({ numItems: 2, cursor: null, maximumBytesRead: 0 }))).rejects.toThrow(
      "maximumRowsRead and maximumBytesRead must be greater than 0",
    );
  });

  test("a table that does not exist: one empty page, done", async () => {
    const e = await engine();
    const p = await e.query((db) => db.query("nonesuch").paginate({ numItems: 2, cursor: null }));
    expect([p.page, p.isDone, p.pageStatus]).toEqual([[], true, null]);
    const s = await e.query((db) => search(db, "word").paginate({ numItems: 2, cursor: null }));
    expect([s.page, s.isDone, s.pageStatus]).toEqual([[], true, null]);
  });
});

describe("a cursor belongs to its query", () => {
  test("another index of the same table refuses it", async () => {
    const e = await engine(5);
    const p = await e.query((db) => byN(db).paginate({ numItems: 2, cursor: null }));
    await expect(
      e.query((db) => db.query("items").withIndex("by_m").paginate({ numItems: 2, cursor: p.continueCursor })),
    ).rejects.toThrow(DIFFERENT_QUERY);
  });

  test("a search's: its text and its filters, bigints included", async () => {
    const e = await engine();
    await addMessages(
      e,
      Array.from({ length: 6 }, (_, i) => ({ body: `word other ${i}`, n: 5n })),
    );
    const p = await e.query((db) => search(db, "word", 5n).paginate({ numItems: 2, cursor: null }));
    expect(p.page).toHaveLength(2);
    const next = await e.query((db) => search(db, "word", 5n).paginate({ numItems: 2, cursor: p.continueCursor }));
    expect(next.page).toHaveLength(2);
    await expect(
      e.query((db) => search(db, "word", 6n).paginate({ numItems: 2, cursor: p.continueCursor })),
    ).rejects.toThrow(DIFFERENT_QUERY);
    await expect(
      e.query((db) => search(db, "other", 5n).paginate({ numItems: 2, cursor: p.continueCursor })),
    ).rejects.toThrow(DIFFERENT_QUERY);
  });
});

describe("search pages", () => {
  test("the last page is done; past it, empty and done; an end cursor pins the page; filters apply", async () => {
    const e = await engine();
    await addMessages(
      e,
      Array.from({ length: 5 }, (_, i) => ({ body: `word ${i}`, n: i })),
    );
    const all = await e.query((db) => search(db, "word").paginate({ numItems: 10, cursor: null }));
    expect([all.page.length, all.isDone]).toEqual([5, true]);
    const past = await e.query((db) => search(db, "word").paginate({ numItems: 10, cursor: all.continueCursor }));
    expect([past.page, past.isDone]).toEqual([[], true]);
    const first = await e.query((db) => search(db, "word").paginate({ numItems: 2, cursor: null }));
    expect([first.page.length, first.isDone]).toEqual([2, false]);
    // Pinned to the first page's end: the same two documents, whatever the page size.
    const pinned = await e.query((db) =>
      search(db, "word").paginate({ numItems: 10, cursor: null, endCursor: first.continueCursor }),
    );
    expect(pinned.page.map((d) => d._id)).toEqual(first.page.map((d) => d._id));
    expect(pinned.continueCursor).toBe(first.continueCursor);
    // Pinned to the end: everything.
    const toEnd = await e.query((db) =>
      search(db, "word").paginate({ numItems: 1, cursor: null, endCursor: all.continueCursor }),
    );
    expect([toEnd.page.length, toEnd.isDone]).toEqual([5, true]);
    const odd = await e.query((db) =>
      search(db, "word")
        .filter((q) => q.eq(q.mod(q.field("n"), 2), 1))
        .paginate({ numItems: 10, cursor: null }),
    );
    expect(ns(odd.page).sort()).toEqual([1, 3]);
  });

  test("more than 768 documents in a page: SplitRecommended (3/4 of the 1024 candidates)", async () => {
    const e = await engine();
    await addMessages(
      e,
      Array.from({ length: 800 }, (_, i) => ({ body: `word ${i}` })),
    );
    const at = await e.query((db) => search(db, "word").paginate({ numItems: 768, cursor: null }));
    expect([at.page.length, at.pageStatus]).toEqual([768, null]);
    const over = await e.query((db) => search(db, "word").paginate({ numItems: 769, cursor: null }));
    expect([over.page.length, over.pageStatus]).toEqual([769, "SplitRecommended"]);
  });
});

describe("index pages", () => {
  test("an end cursor at the end reads to the end, ascending and descending", async () => {
    const e = await engine(5);
    const done = await e.query((db) => byN(db).paginate({ numItems: 10, cursor: null }));
    expect(done.isDone).toBe(true);
    const asc = await e.query((db) => byN(db).paginate({ numItems: 1, cursor: null, endCursor: done.continueCursor }));
    expect([ns(asc.page), asc.isDone]).toEqual([[0, 1, 2, 3, 4], true]);
    const descDone = await e.query((db) => byN(db).order("desc").paginate({ numItems: 10, cursor: null }));
    const desc = await e.query((db) =>
      byN(db).order("desc").paginate({ numItems: 1, cursor: null, endCursor: descDone.continueCursor }),
    );
    expect([ns(desc.page), desc.isDone]).toEqual([[4, 3, 2, 1, 0], true]);
    const descFirst = await e.query((db) => byN(db).order("desc").paginate({ numItems: 2, cursor: null }));
    const descPinned = await e.query((db) =>
      byN(db).order("desc").paginate({ numItems: 10, cursor: null, endCursor: descFirst.continueCursor }),
    );
    expect(ns(descPinned.page)).toEqual([4, 3]);
  });

  test("a page records one read interval; past the end, an empty one at the range's start", async () => {
    const e = await engine(5);
    const done = await e.query((db) => byN(db).paginate({ numItems: 10, cursor: null }));
    const one = await e.query(async (db) => {
      const q = byN(db);
      const before = db.usage.databaseQueries;
      await q.paginate({ numItems: 2, cursor: null });
      return db.usage.databaseQueries - before;
    });
    expect(one).toBe(1);
    const r = await e.query(async (db) => {
      const ix = e.catalog.table("items")!.indexes.get("by_n")!.id;
      await byN(db).paginate({ numItems: 2, cursor: done.continueCursor });
      return { ix, last: db.reads.at(-1)! };
    });
    expect(r.last.index).toBe(r.ix);
    expect(r.last.lo).toEqual(r.last.hi);
  });

  test("the interval a read-limited page records ends at its first document, as a one-document page's", async () => {
    const e = await engine(5);
    const one = await e.query(async (db) => {
      await byN(db).paginate({ numItems: 1, cursor: null });
      return db.reads.at(-1)!;
    });
    const limited = await e.query(async (db) => {
      const q = byN(db);
      db.limits.databaseQueries = db.usage.databaseQueries;
      const p = await q.paginate({ numItems: 3, cursor: null });
      return { p, last: db.reads.at(-1)! };
    });
    expect(limited.p.pageStatus).toBe("SplitRequired");
    expect(limited.last).toEqual(one);
  });

  test("reads kept out of the limits do not fill them", async () => {
    const e = await engine(3);
    const p = await e.query(async (db) => {
      const items = e.catalog.table("items")!.indexes.get("by_m")!.id;
      db.recordUncounted(items);
      db.recordUncounted(items);
      const q = byN(db);
      db.limits.databaseQueries = db.usage.databaseQueries + 1;
      return q.paginate({ numItems: 5, cursor: null });
    });
    expect([ns(p.page), p.pageStatus, p.isDone]).toEqual([[0, 1, 2], null, true]);
  });

  test("a document-limited page records its interval; one limited before its first document records none", async () => {
    const e = await engine(10);
    const mid = await e.query(async (db) => {
      db.limits.documentsRead = 3;
      const q = byN(db);
      const before = db.usage.databaseQueries;
      const p = await q.paginate({ numItems: 8, cursor: null });
      return { p, reads: db.usage.databaseQueries - before };
    });
    expect([ns(mid.p.page), mid.p.pageStatus, mid.reads]).toEqual([[0, 1, 2], "SplitRequired", 1]);
    const first = await e.query((db) => byN(db).paginate({ numItems: 2, cursor: null }));
    const none = await e.query(async (db) => {
      db.limits.documentsRead = 0;
      const q = byN(db);
      const before = db.usage.databaseQueries;
      const p = await q.paginate({ numItems: 2, cursor: first.continueCursor });
      return { p, reads: db.usage.databaseQueries - before };
    });
    expect([none.p.page, none.p.pageStatus, none.reads]).toEqual([[], "SplitRequired", 0]);
  });

  test("an error that is not a limit fails the page", async () => {
    const e = await engine(3);
    const run = e.query(async (db) => {
      (db as unknown as { stream: () => AsyncGenerator<Doc> }).stream = async function* () {
        yield* [];
        throw new Error("boom");
      };
      return byN(db).paginate({ numItems: 2, cursor: null });
    });
    const err = await run.catch((x: Error) => x);
    expect([(err as Error).constructor, (err as Error).message]).toEqual([Error, "boom"]);
  });

  test("the page's byte limit: reached, the page ends SplitRequired; within it, soft at 3/4", async () => {
    // Documents whose size is a multiple of 3, so that 3/4 of 16/3 of four of them is exactly four.
    let pad = 10;
    let size = 0;
    for (;;) {
      const e = await engine(1, { pad: "x".repeat(pad) });
      size = rawValueSize((await e.query((db) => db.query("items").first())) as unknown as Value);
      if (size % 3 === 0) break;
      pad++;
    }
    const e = await engine(4, { pad: "x".repeat(pad) });
    const page = (maximumBytesRead: number) =>
      e.query((db) => byN(db).paginate({ numItems: 10, cursor: null, maximumBytesRead }));
    const cut = await page(Math.floor(2.5 * size));
    expect([ns(cut.page), cut.pageStatus, cut.isDone]).toEqual([[0, 1, 2], "SplitRequired", false]);
    // Reaching the limit exactly ends the page too, before the next document.
    const reached = await page(3 * size);
    expect([ns(reached.page), reached.pageStatus, reached.isDone]).toEqual([[0, 1, 2], "SplitRequired", false]);
    const soft = await page(5 * size);
    expect([cut.page.length, soft.page.length, soft.pageStatus, soft.isDone]).toEqual([3, 4, "SplitRecommended", true]);
    const exact = await page((16 * size) / 3);
    expect([exact.page.length, exact.pageStatus, exact.isDone]).toEqual([4, null, true]);
  });

  test("more than 6144 documents in a page: SplitRecommended", async () => {
    const e = await engine(6145);
    const at = await e.query((db) => byN(db).paginate({ numItems: 6144, cursor: null }));
    expect([at.page.length, at.pageStatus]).toEqual([6144, null]);
    const over = await e.query((db) => byN(db).paginate({ numItems: 6145, cursor: null }));
    expect([over.page.length, over.pageStatus]).toEqual([6145, "SplitRecommended"]);
  }, 60_000);
});

describe("a system error the function cannot catch", () => {
  const caught = (e: Engine, body: (db: Tx) => Promise<unknown>) =>
    e.query((db) =>
      withUserTimer(newUserTimer(1e9, 1e9), async () => {
        try {
          await body(db);
        } catch {
          return "caught";
        }
        return "returned";
      }),
    );

  test("a page over limit(0) (no cursor)", async () => {
    const e = await engine(3);
    await expect(caught(e, (db) => byN(db).limit(0).paginate({ numItems: 2, cursor: null }))).rejects.toBeInstanceOf(
      QueryCursorError,
    );
  });

  test("a first page limited before its first document", async () => {
    const e = await engine(3);
    const run = caught(e, async (db) => {
      db.limits.documentsRead = 0;
      return byN(db).paginate({ numItems: 2, cursor: null });
    });
    await expect(run).rejects.toThrow("This should be impossible. Hit pagination limit before setting query cursor");
  });
});

describe("query runs", () => {
  test("collect() stops its scan at the read limit: the rows read are the cap's", async () => {
    const e = await engine(10);
    const rows = await e.query(async (db) => {
      const any = await db.query("items").first();
      db.limits.documentsRead = 3;
      await db
        .query("items")
        .collect()
        .catch((x) => x);
      return { first: any?.n, rows: db.tableStats.get("items")?.rowsRead };
    });
    // `first()` read one; collect() fetched the 3 its cap allows (the third over the limit, refused).
    expect(rows).toEqual({ first: 0, rows: 4 });
  });

  test("a virtual table's mapping may return a promise for some documents", async () => {
    const e = await engine(4);
    const docs = await e.query((db) =>
      db
        .queryVirtual("mapped", "items", (d) => {
          const out = { ...d, odd: (d.n as number) % 2 === 1 };
          return out.odd ? Promise.resolve(out) : out;
        })
        .take(4),
    );
    expect(docs.map((d) => [d.n, d.odd])).toEqual([
      [0, false],
      [1, true],
      [2, false],
      [3, true],
    ]);
  });

  test("the read-set of a full page ends at its last document, even if the app changes it", async () => {
    const e = await engine(5);
    const reads = (change: boolean) =>
      e.query(async (db) => {
        const docs = await byN(db).take(2);
        if (change) (docs[1] as Record<string, unknown>).n = 999;
        return db.reads.at(-1);
      });
    expect(await reads(true)).toEqual(await reads(false));
  });

  test("a filtered query hands its own commit timestamps back as the placeholder", async () => {
    const e = await engine();
    const r = await e.mutation(async (db) => {
      await db.insert("other", { k: 1, at: db.vars!.commitTs });
      const [doc] = await db
        .query("other")
        .filter((q) => q.eq(q.field("k"), 1))
        .collect();
      return doc!.at === db.vars!.commitTs;
    });
    expect(r).toBe(true);
  });
});

describe("rows read per table", () => {
  test("each read adds to the table's count; a read of nothing adds no entry", async () => {
    const e = await engine(3);
    const stats = await e.query(async (db) => {
      await db.query("items").take(2);
      await db.query("items").collect();
      await byN(db)
        .filter((q) => q.eq(q.field("n"), -1))
        .collect();
      await db.query("other").collect();
      await db
        .query("items")
        .withIndex("by_n", (q) => q.eq("n", 99))
        .collect();
      db.countRowsReadOf("cached", 4);
      db.countRowsReadOf("none", 0);
      return Object.fromEntries(db.tableStats);
    });
    expect(stats).toEqual({ items: { rowsRead: 8, rowsWritten: 0 }, cached: { rowsRead: 4, rowsWritten: 0 } });
  });
});

describe("write limits at their boundaries", () => {
  const nest = (depth: number): Record<string, unknown> => (depth <= 1 ? {} : { x: nest(depth - 1) });

  // An app's write is refused for its nesting before (`validateWritten`); an import's copy has no nesting limit.
  test("nesting of an imported document: 16 levels are allowed, 17 are not", async () => {
    const e = await engine();
    const hidden = await e.createHiddenTable("other");
    const imported = (doc: Record<string, unknown>) =>
      e.mutation((db) => db.asSystem(() => db.importInsert(hidden, doc)));
    expect(valueNesting(nest(16) as Value)).toBe(16);
    await imported(nest(16));
    const err = await imported(nest(17)).catch((x: Error) => x);
    expect((err as Error).message).toBe("Document is too nested (nested 17 levels deep > maximum nesting 16)");
  });

  test("size: exactly 1 MiB is allowed, one byte more is not", async () => {
    const e = await engine();
    const probe = await e.mutation(async (db) => {
      const id = await db.insert("other", { pad: "" });
      return rawValueSize((await db.get(id)) as unknown as Value);
    });
    const pad = "x".repeat((1 << 20) - probe);
    await e.mutation((db) => db.insert("other", { pad }));
    await expect(e.mutation((db) => db.insert("other", { pad: `${pad}x` }))).rejects.toThrow("Value is too large");
  });

  test("documents and bytes written: the limit itself is allowed", async () => {
    const e = await engine();
    await e.mutation(async (db) => {
      db.limits.documentsWritten = 2;
      await db.insert("other", {});
      await db.insert("other", {});
      await expect(db.insert("other", {})).rejects.toThrow("Too many writes in a single function execution (limit: 2)");
    });
    await e.mutation(async (db) => {
      const id = await db.insert("other", { k: 1 });
      const size = rawValueSize((await db.get(id)) as unknown as Value);
      db.limits.bytesWritten = 2 * size;
      await db.insert("other", { k: 2 });
      await expect(db.insert("other", { k: 3 })).rejects.toThrow(
        "Too many bytes written in a single function execution",
      );
    });
  });
});

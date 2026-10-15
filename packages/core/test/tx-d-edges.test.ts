// Edges of a transaction's writes, savepoints, counts, searches, scans and query builders (TEST-01 §7, the
// mutation triage of tx.ts): each test pins a behaviour a surviving mutant changed.
import { describe, expect, test } from "bun:test";
import { encodeId, v } from "@bunvex/values";
import { newUserTimer, withUserTimer } from "../src/determinism.ts";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import { TableSummariesUnavailableError } from "../src/table-summaries.ts";
import { isQueryObject, QueryCursorError, readEndAfter, SearchFilterBuilder, type Tx } from "../src/tx.ts";

const schema = defineSchema({
  items: defineTable(v.any()).index("by_n", ["n"]).index("by_o", ["o"]),
  other: defineTable(v.any()),
  messages: defineTable(v.any()).searchIndex("search_body", { searchField: "body", filterFields: ["channel"] }),
  notes_: defineTable(v.any()).searchIndex("search_body", { searchField: "body" }),
});

async function engine() {
  const e = await new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
  await e.searchReady();
  return e;
}

async function message(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("did not fail");
}

/** An id of a table number no table has. */
const strayId = () => encodeId(123_456, new Uint8Array(16));

describe("stage", () => {
  test("a staged version is the engine's own: frozen in the test runs, the replaced one too", async () => {
    const e = await engine();
    const id = await e.mutation((db) => db.insert("items", { n: 1 }));
    await e.mutation(async (db) => {
      await db.patch(id, { n: 2 });
      const [w] = db.writtenDocs();
      expect(Object.isFrozen(w!.next)).toBe(true);
      expect(Object.isFrozen(w!.old)).toBe(true);
    });
  });

  test("only an `_index` row marks its table's indexes as changed, not a user row with a `table_id`", async () => {
    const e = await engine();
    await e.mutation(async (db) => {
      const tablet = (db as unknown as { catalog: { table(n: string): { id: unknown } } }).catalog.table("items").id;
      await db.insert("other", { table_id: tablet });
      expect(db.catalogTouches()).toEqual([]);
    });
  });

  test("each write counts one row written for its table", async () => {
    const e = await engine();
    await e.mutation(async (db) => {
      const id = await db.insert("items", { n: 1 });
      await db.patch(id, { n: 2 });
      expect(db.tableStats.get("items")!.rowsWritten).toBe(2);
    });
  });

  test("a query cannot write: insert, and a patch past its read", async () => {
    const e = await engine();
    const id = await e.mutation((db) => db.insert("items", { n: 1 }));
    expect(await message(e.query((db) => db.insert("items", { n: 2 })))).toBe("queries cannot write");
    expect(await message(e.query((db) => db.insert("brandnew", { n: 2 })))).toBe("queries cannot write");
    expect(await message(e.query((db) => db.patch(id, { n: 2 })))).toBe("queries cannot write");
  });

  test("pending validators: the first violation is kept; a delete or a valid document is none", async () => {
    const e = await engine();
    const otherId = await e.mutation((db) => db.insert("other", {}));
    const ids = await e.mutation(async (db) => [
      await db.insert("items", { n: 1 }),
      await db.insert("items", { n: 2 }),
    ]);
    await e.mutation(async (db) => {
      const doc = { _id: v.id("items"), _creationTime: v.number(), n: v.number(), ref: v.optional(v.id("other")) };
      db.pendingValidators = new Map([["items", v.object(doc)]]);
      await db.patch(ids[0]!, { ref: otherId }); // valid, an id of the right table
      await db.delete(ids[1]!); // no document to check
      expect(db.pendingViolation).toBeNull();
      await db.patch(ids[0]!, { n: "a" });
      await db.patch(ids[0]!, { n: 1, extra: true });
      expect(db.pendingViolation!.error).toContain('Path: .n\nValue: "a"');
    });
  });

  test("staged checks: per schema and table, the first violation kept, a table without a validator skipped", async () => {
    const e = await engine();
    await e.mutation(async (db) => {
      db.stagedChecks = [
        { schemaId: "s1", validators: new Map([["items", v.object({ n: v.number() })]]) },
        { schemaId: "s2", validators: new Map([["other", v.object({ k: v.string() })]]) },
      ];
      await db.insert("items", { n: "a" });
      await db.insert("items", { n: "b" });
      await db.insert("other", { k: 1 });
      expect([...db.stagedViolations.values()].map((s) => [s.schemaId, s.table, s.error.includes('"a"')])).toEqual([
        ["s1", "items", true],
        ["s2", "other", false],
      ]);
    });
  });

  test("staged checks skip system tables only, not a table whose name ends with an underscore", async () => {
    const e = await engine();
    await e.mutation(async (db) => {
      db.stagedChecks = [{ schemaId: "s", validators: new Map([["notes_", v.object({ body: v.string() })]]) }];
      await db.insert("notes_", { body: 1 });
      expect([...db.stagedViolations.keys()]).toEqual(["s\u0000notes_"]);
    });
  });
});

describe("writes by id", () => {
  test("no commit timestamp to resolve after a plain insert", async () => {
    const e = await engine();
    await e.mutation(async (db) => {
      await db.insert("items", { n: 1 });
      expect(db.hasCommitTs).toBe(false);
    });
  });

  test("a replace or a delete drops the document's commit timestamp placeholders", async () => {
    const e = await engine();
    await e.mutation(async (db) => {
      const a = await db.insert("items", { at: db.vars!.commitTs });
      await db.replace(a, { n: 1 });
      expect(db.hasCommitTs).toBe(false);
      const b = await db.insert("items", { at: db.vars!.commitTs });
      await db.delete(b);
      expect(db.hasCommitTs).toBe(false);
    });
  });

  test("an id of no table: each method's own message", async () => {
    const e = await engine();
    const id = strayId();
    await e.mutation(async (db) => {
      expect(await message(db.patch(id, { n: 1 }))).toBe(`Update on nonexistent document ID ${id}`);
      expect(await message(db.replace(id, { n: 1 }))).toBe(`Replace on nonexistent document ID ${id}`);
      expect(await message(db.delete(id))).toBe(`Delete on nonexistent document ID ${id}`);
    });
  });

  test("a malformed id: the message names the method", async () => {
    const e = await engine();
    await e.mutation(async (db) => {
      const msgs = [
        await message(db.patch("items", "nope", { n: 1 })),
        await message(db.replace("items", "nope", { n: 1 })),
        await message(db.delete("items", "nope")),
      ];
      expect(msgs[0]).toContain("db.patch");
      expect(msgs[1]).toContain("db.replace");
      expect(msgs[2]).toContain("db.delete");
      const byId = [
        await message(db.patch("nope", { n: 1 })),
        await message(db.replace("nope", { n: 1 })),
        await message(db.delete("nope")),
      ];
      expect(byId[0]).toContain("db.patch");
      expect(byId[1]).toContain("db.replace");
      expect(byId[2]).toContain("db.delete");
    });
  });

  test("a value that is not an object, and copy errors with and without the argument prefix", async () => {
    const e = await engine();
    await e.mutation(async (db) => {
      expect(await message(db.insert("items", 5 as never))).toBe(
        "Invalid argument `value` for `db.insert`: Value must be an Object",
      );
      expect(await message(db.insert("items", { a: new Array(8193).fill(0) }))).toStartWith(
        "Invalid argument `value` for `db.insert`: Array length is too long",
      );
      expect(await message(db.insert("items", { a: Symbol("s") as never }))).not.toContain("Invalid argument");
    });
  });

  test("`_id` or `_creationTime` set to undefined is no system field", async () => {
    const e = await engine();
    await e.mutation(async (db) => {
      const id = await db.insert("items", { _id: undefined, _creationTime: undefined, n: 1 } as never);
      expect((await db.get(id))!.n).toBe(1);
    });
  });
});

describe("savepoints", () => {
  test("a rollback restores the index entries and the tables created before it, and drops those after", async () => {
    const e = await engine();
    await e.mutation(async (db) => {
      await db.insert("t1", { n: 1 });
      const sp = db.begin();
      await db.insert("t1", { n: 2 });
      await db.insert("t2", { n: 3 });
      db.rollback(sp);
      expect((await db.query("t1").collect()).map((d) => d.n)).toEqual([1]);
      expect([...db.createdTables.keys()]).toEqual(["t1"]);
    });
    expect(await e.query((db) => db.query("t2").collect())).toEqual([]);
    expect((await e.query((db) => db.query("t1").collect())).map((d) => d.n)).toEqual([1]);
  });
});

describe("counts and system table names", () => {
  test("system table names: system access only, sorted, no user table", async () => {
    const e = await engine();
    await e.mutation(async (db) => {
      expect(await message(() => db.systemTableNames())).toBe("systemTableNames is for system transactions");
      const names = db.asSystemSync(() => db.systemTableNames());
      expect(names.length).toBeGreaterThan(2);
      expect(names.every((n) => n.startsWith("_"))).toBe(true);
      expect(names).toEqual([...names].sort());
    });
  });

  test("counting a missing table depends on `_tables`", async () => {
    const e = await engine();
    await e.query(async (db) => {
      const before = db.reads.length;
      expect(await db.query("nothere").count()).toBe(0);
      // the query's own read of `_tables`, and the count's
      expect(db.reads.length).toBe(before + 2);
    });
  });

  test("summaries unavailable: a system error the function cannot catch; any other error is thrown as is", async () => {
    const e = await engine();
    const unavailable = new TableSummariesUnavailableError();
    const counting = (err: Error) =>
      e.query(async (db) => {
        db.tableCount = () => {
          throw err;
        };
        // under a function's timer, as the server runs one: a system error ends it when the body returns
        return withUserTimer(newUserTimer(60_000, 60_000), () =>
          db
            .query("items")
            .count()
            .catch((x: Error) => `caught ${x.message}`),
        );
      });
    expect(await message(counting(unavailable))).toBe(unavailable.message);
    expect(await counting(new Error("boom"))).toBe("caught boom");
  });

  test("written tables: each once", async () => {
    const e = await engine();
    await e.mutation(async (db) => {
      await db.insert("items", { n: 1 });
      await db.insert("items", { n: 2 });
      await db.insert("other", {});
      expect(db.writtenTables().map((t) => t.name)).toEqual(["items", "other"]);
    });
  });
});

const search = (db: Tx, text: string, table = "messages") =>
  db.query(table).withSearchIndex("search_body", (q) => q.search("body", text));
const bodies = (docs: Record<string, unknown>[]) => docs.map((d) => d.body);

describe("search", () => {
  async function seeded() {
    const e = await engine();
    await e.mutation(async (db) => {
      await db.insert("messages", { body: "quick quick quick", channel: "a" });
      await db.insert("messages", { body: "quick quick", channel: "a" });
      await db.insert("messages", { body: "quick", channel: "a" });
    });
    return e;
  }

  test("no search indexes, or a pending index of that name", async () => {
    const e = await seeded();
    await e.query(async (db) => {
      const indexes = db.searchIndexes;
      db.searchIndexes = null;
      expect(await message(search(db, "quick").collect())).toBe("Index messages.search_body not found.");
      db.searchIndexes = indexes;
      const t = (db as unknown as { catalog: { table(n: string): { pending: { name: string }[] } } }).catalog.table(
        "items",
      );
      t.pending.push({ name: "other_index" });
      try {
        expect(await message(search(db, "quick", "items").collect())).toBe("Index items.search_body not found.");
        t.pending.push({ name: "search_body" });
        expect(await message(search(db, "quick", "items").collect())).toBe(
          "Index items.search_body is not a search index",
        );
      } finally {
        t.pending.length = 0;
      }
    });
  });

  test("the search filter is found wherever it is: an empty `eq` before it is not an empty search", async () => {
    const e = await seeded();
    await e.mutation((db) => db.insert("messages", { body: "quick", channel: "" }));
    const docs = await e.query((db) =>
      db
        .query("messages")
        .withSearchIndex("search_body", (q) => q.eq("channel", "").search("body", "quick"))
        .collect(),
    );
    expect(docs).toHaveLength(1);
    const all = await e.query((db) =>
      db
        .query("messages")
        .withSearchIndex("search_body", (q) => q.eq("channel", "a").search("body", "quick"))
        .collect(),
    );
    expect(all).toHaveLength(3);
  });

  test("a mutation's search reads: at most 16 terms, only the last one a prefix", async () => {
    const e = await seeded();
    await e.mutation(async (db) => {
      const many = Array.from({ length: 17 }, (_, i) => `t${i}`).join(" ");
      await search(db, many).collect();
      await search(db, "qu zzz").collect();
      const [first, second] = db.searchReads;
      expect(first!.terms).toHaveLength(16);
      expect(second!.terms).toEqual([
        { term: "qu", prefix: false },
        { term: "zzz", prefix: true },
      ]);
    });
  });

  test("bootstrapping: a system error the function cannot catch", async () => {
    const e = await seeded();
    const run = () =>
      e.query(async (db) => {
        db.searchIndexes = { get: () => ({ staged: false, ready: false, bootstrapping: true }) } as never;
        return withUserTimer(newUserTimer(60_000, 60_000), () =>
          search(db, "quick")
            .collect()
            .catch(() => "caught"),
        );
      });
    expect(await message(run())).toBe("Search indexes bootstrapping and not yet available for use");
  });

  test("exactly the maximum of filter conditions is allowed", async () => {
    const e = await seeded();
    const docs = await e.query((db) =>
      db
        .query("messages")
        .withSearchIndex("search_body", (q) => {
          let b = q.search("body", "quick");
          for (let i = 0; i < 8; i++) b = b.eq("channel", "a");
          return b;
        })
        .collect(),
    );
    expect(docs).toHaveLength(3);
  });

  test("terms past the 16th are ignored; only the last term matches as a prefix", async () => {
    const e = await seeded();
    const many = `${Array.from({ length: 16 }, (_, i) => `zz${i}`).join(" ")} quick`;
    expect(await e.query((db) => search(db, many).collect())).toEqual([]);
    expect(await e.query((db) => search(db, "qu zzz").collect())).toEqual([]);
    expect(bodies(await e.query((db) => search(db, "zzz qu").collect()))).toHaveLength(3);
  });

  test("own writes of another table are not this table's hits", async () => {
    const e = await seeded();
    await e.mutation(async (db) => {
      await db.insert("notes_", { body: "quick" });
      expect(await search(db, "quick").collect()).toHaveLength(3);
    });
  });

  test("a search charges its index's bytes, on any user table", async () => {
    const e = await seeded();
    await e.mutation((db) => db.insert("notes_", { body: "quick" }));
    await e.query(async (db) => {
      await search(db, "quick").collect();
      const one = db.io(false).textQueryBytes;
      expect(one).toBeGreaterThan(0);
      await search(db, "quick", "notes_").collect();
      expect(db.io(false).textQueryBytes).toBeGreaterThan(one);
    });
  });

  test("take(0), take(1) and first(); a missing table's search index is not found (Convex's error)", async () => {
    const e = await seeded();
    await e.query(async (db) => {
      expect(await search(db, "quick").take(0)).toEqual([]);
      expect(await search(db, "quick").take(1)).toHaveLength(1);
      expect((await search(db, "quick").first())!.body).toBe("quick quick quick");
      expect(
        await search(db, "quick")
          .filter((q) => q.eq(1, 1))
          .take(2),
      ).toHaveLength(2);
      const missing = db.query("nothere").withSearchIndex("search_body", (q) => q.search("body", "quick"));
      let error: unknown;
      try {
        await missing.collect();
      } catch (e) {
        error = e;
      }
      expect((error as Error).message).toBe("Index nothere.search_body not found.");
    });
  });

  test("paginated in relevance order, one by one", async () => {
    const e = await seeded();
    const seen: unknown[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 4; i++) {
      const page = await e.query((db) => search(db, "quick").paginate({ numItems: 1, cursor }));
      seen.push(...bodies(page.page));
      cursor = page.continueCursor;
      if (page.isDone) break;
    }
    expect(seen).toEqual(["quick quick quick", "quick quick", "quick"]);
  });
});

describe("scan reads", () => {
  async function three() {
    const e = await engine();
    await e.mutation(async (db) => {
      for (let n = 1; n <= 3; n++) await db.insert("items", { n, o: { x: n } });
    });
    return e;
  }

  test("a key holding an object is taken when handed out: changing the document leaves the read-set", async () => {
    const e = await three();
    await e.query(async (db) => {
      const [d] = await db.query("items").withIndex("by_o").take(1);
      const before = db.reads.map((i) => [...i.hi]);
      const [d2] = await db.query("items").withIndex("by_o").take(1);
      (d2!.o as { x: number }).x = 99;
      const after = db.reads.map((i) => [...i.hi]);
      expect(after.at(-1)).toEqual(before.at(-1));
      expect(d).toBeDefined();
    });
  });

  test("a scan that runs out records one interval", async () => {
    const e = await three();
    await e.query(async (db) => {
      await db.query("items").collect(); // the table's own read, once
      const before = db.reads.length;
      await db
        .query("items")
        .withIndex("by_n")
        .filter((q) => q.neq(q.field("n"), 0))
        .collect();
      // the index's `_index` row, and the scan's one interval
      expect(db.reads.length).toBe(before + 2);
    });
  });

  test("a scan stopped by a read limit past dropped documents ends its read-set at the last one reached", async () => {
    const e = await three();
    await e.query(async (db) => {
      db.limits.documentsRead = 2;
      await db
        .query("items")
        .withIndex("by_n")
        .filter((q) => q.eq(q.field("n"), 0))
        .collect()
        .catch(() => {});
      const iv = db.reads.at(-1)!;
      // not the whole index: it ends just past the second document's key
      expect(Buffer.from(iv.hi).toString("hex")).not.toBe("ffffffff");
      expect(Buffer.from(iv.lo).toString("hex")).toBe("");
    });
  });
});

describe("readEndAfter", () => {
  test("just past the key's prefix, but never past the range's end", () => {
    expect([...readEndAfter(new Uint8Array([1, 2]), new Uint8Array([9]))]).toEqual([1, 3]);
    expect([...readEndAfter(new Uint8Array([1, 255]), new Uint8Array([1, 255, 5]))]).toEqual([1, 255, 5]);
  });
});

describe("builders", () => {
  test("QueryCursorError's name", () => {
    expect(new QueryCursorError().name).toBe("QueryCursorError");
  });

  test("search filter builder: Convex's argument checks and its `Eq` filters", () => {
    const b = () => new SearchFilterBuilder([]);
    const call = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return `${(e as Error).constructor.name}: ${(e as Error).message}`;
      }
      return "ok";
    };
    expect(call(() => b().search(undefined as never, "x"))).toBe(
      "TypeError: Must provide arg 1 `fieldName` to `search`",
    );
    expect(call(() => b().search("f", undefined as never))).toBe("TypeError: Must provide arg 2 `query` to `search`");
    expect(call(() => b().eq(undefined as never, 1))).toBe("TypeError: Must provide arg 1 `fieldName` to `eq`");
    expect(call(() => (b().eq as (f: string) => unknown)("f"))).toBe(
      "TypeError: Must provide arg 2 `value` to `search`",
    );
    expect(b().eq("f", undefined).filters()).toEqual([{ type: "Eq", field: "f", value: undefined }]);
  });

  test("isQueryObject: queries and system queries, nothing else", async () => {
    const e = await engine();
    await e.query(async (db) => {
      expect(isQueryObject(db.query("items"))).toBe(true);
      expect(isQueryObject(db.query("items").filter((q) => q.eq(1, 1)))).toBe(true);
      expect(isQueryObject(db.system.query("_scheduled_functions"))).toBe(true);
      expect(isQueryObject({})).toBe(false);
    });
  });

  test("chaining: once, never after iteration, never after the query ran", async () => {
    const e = await engine();
    await e.mutation((db) => db.insert("items", { n: 1 }));
    await e.query(async (db) => {
      const q = db.query("items");
      q.filter((x) => x.eq(1, 1));
      expect(await message(() => q.filter((x) => x.eq(1, 1)))).toBe(
        "This query has been chained with another operator and can't be reused.",
      );
      const it = db.query("items");
      it[Symbol.asyncIterator]();
      expect(await message(() => it.filter((x) => x.eq(1, 1)))).toBe(
        "A query can only be chained once and can't be chained after iteration begins.",
      );
      const ran = db.query("items");
      await ran.collect();
      expect(await message(() => ran.collect())).toContain("can't be reused");
      const taken = db.query("items");
      await taken.take(1);
      expect(await message(() => taken.take(1))).toContain("can't be reused");
      const paged = db.query("items");
      await paged.paginate({ numItems: 1, cursor: null });
      expect(await message(() => paged.paginate({ numItems: 1, cursor: null }))).toContain("can't be reused");
      const iterated = db.query("items");
      iterated[Symbol.asyncIterator]();
      expect(await message(() => iterated.paginate({ numItems: 1, cursor: null }))).toContain("can't be reused");
      const closed = db.query("items");
      await closed.collect();
      expect(await message(() => closed[Symbol.asyncIterator]())).toContain("can't be reused");
    });
  });

  test("argument checks: filter, take, withSearchIndex", async () => {
    const e = await engine();
    await e.query(async (db) => {
      expect(await message(() => db.query("items").filter(undefined as never))).toBe(
        "Must provide arg 1 `predicate` to `filter`",
      );
      expect(await message(() => db.query("items").take(undefined as never))).toBe("Must provide arg 1 `n` to `take`");
      expect(await message(() => db.query("messages").withSearchIndex("search_body", undefined as never))).toBe(
        "Must provide arg 2 `filter` to `withSearchIndex`",
      );
    });
  });

  test("a lone surrogate in a search, an iteration, an index with no range", async () => {
    const e = await engine();
    await e.query(async (db) => {
      const H = "\ud800";
      const m = [
        await message(
          db
            .query("messages")
            .withSearchIndex("search_body", (q) => q.search("body", H).eq("channel", undefined))
            .collect(),
        ),
        await message(() =>
          db
            .query("items")
            .filter((q) => q.eq(q.field("k"), H))
            [Symbol.asyncIterator](),
        ),
        await message(
          db
            .query("items")
            .withIndex("by_n")
            .filter((q) => q.eq(q.field("k"), H))
            .collect(),
        ),
        await message(
          db
            .query("items")
            .limit(5)
            .filter((q) => q.eq(q.field("k"), H))
            .collect(),
        ),
      ];
      const end = (column: number) => `Received invalid json: unexpected end of hex escape at line 1 column ${column}`;
      expect(m).toEqual([end(134), end(143), end(156), end(155)]);
    });
  });
});

describe("index entries of repeated writes", () => {
  test("a document written twice in one transaction leaves no entry of its first or middle version", async () => {
    const e = await engine();
    const id = await e.mutation((db) => db.insert("items", { n: 1 }));
    await e.mutation(async (db) => {
      await db.patch(id, { n: 2 });
      await db.patch(id, { n: 3 });
    });
    for (const n of [1, 2])
      expect(
        await e.query((db) =>
          db
            .query("items")
            .withIndex("by_n", (q) => q.eq("n", n))
            .collect(),
        ),
      ).toEqual([]);
    expect(
      await e.query((db) =>
        db
          .query("items")
          .withIndex("by_n", (q) => q.eq("n", 3))
          .collect(),
      ),
    ).toHaveLength(1);
  });

  test("a page over own deletes fetches past them", async () => {
    const e = await engine();
    await e.mutation(async (db) => {
      for (let n = 1; n <= 5; n++) await db.insert("items", { n });
    });
    await e.mutation(async (db) => {
      for (const d of await db.query("items").withIndex("by_n").take(2)) await db.delete(d._id as string);
      expect((await db.query("items").withIndex("by_n").take(3)).map((d) => d.n)).toEqual([3, 4, 5]);
    });
  });
});

describe("document checks", () => {
  test("nested exactly to the document limit is allowed", async () => {
    const e = await engine();
    let deep: unknown = 1;
    for (let i = 0; i < 15; i++) deep = { d: deep };
    const id = await e.mutation((db) => db.insert("items", { deep }));
    expect(id).toBeString();
  });

  test("underscore fields are listed in field order", async () => {
    const e = await engine();
    const msg = await message(e.mutation((db) => db.insert("items", { _z: 1, _a: 1 })));
    expect(msg.indexOf("'_a'")).toBeLessThan(msg.indexOf("'_z'"));
  });

  test("an imported row: no other field may start with an underscore; one that ends with one may", async () => {
    const e = await engine();
    await e.mutation(async (db) => {
      const t = (db as unknown as { catalog: { table(n: string): never } }).catalog.table("items");
      expect(await message(db.asSystem(() => db.importInsert(t, { _x: 1 })))).toBe(
        "Field '_x' starts with an underscore, which is only allowed for system fields like '_id'",
      );
      const id = await db.asSystem(() => db.importInsert(t, { a_: 1 }));
      expect((await db.get(id))!.a_).toBe(1);
    });
  });

  test("a lone surrogate after an `eq` to undefined, or in an ordered query: columns past that text", async () => {
    const e = await engine();
    const end = (column: number) => `Received invalid json: unexpected end of hex escape at line 1 column ${column}`;
    await e.query(async (db) => {
      const H = "\ud800";
      expect(
        await message(
          db
            .query("messages")
            .withSearchIndex("search_body", (q) => q.eq("channel", undefined).search("body", H))
            .collect(),
        ),
      ).toBe(end(198));
      expect(
        await message(
          db
            .query("items")
            .order("asc")
            .filter((q) => q.eq(q.field("k"), H))
            .collect(),
        ),
      ).toBe(end(144));
    });
  });
});

describe("search cursor ties", () => {
  test("hits of equal score and creation time page one by one, none skipped", async () => {
    const e = await engine();
    await e.mutation(async (db) => {
      const t = (db as unknown as { catalog: { table(n: string): never } }).catalog.table("messages");
      for (let i = 0; i < 3; i++) await db.asSystem(() => db.importInsert(t, { body: "tie", _creationTime: 1000 }));
    });
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const page = await e.query((db) => search(db, "tie").paginate({ numItems: 1, cursor }));
      for (const d of page.page) seen.add(d._id as string);
      cursor = page.continueCursor;
      if (page.isDone) break;
    }
    expect(seen.size).toBe(3);
  });
});

// Edges of the transaction (tx.ts) that its mutation testing found untested (TEST-01 §7): system access
// around `asSystem` and table creation, `resolveIndex`'s read of the `_index` row, the uncounted reads,
// `db.get` / `normalizeId` on ids of other tables, the system-only entry points (`queryDef`, `importInsert`,
// `deleteFrom`), the reads a missing table records, descending scans past a page with the transaction's own
// writes, and a store failure while the snapshot leaves retention.
import { expect, test } from "bun:test";
import { encodeId, v } from "@bunvex/values";
import { INDEX_TABLE, IndexBackfillingError, TABLES_TABLE } from "../src/catalog.ts";
import { PersistenceReadError } from "../src/determinism.ts";
import { Engine } from "../src/engine.ts";
import { encodeKey, prefixEnd } from "../src/keyenc.ts";
import { DanglingReferenceError } from "../src/persistence/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable, type IndexDef, type TableDef } from "../src/schema.ts";
import { ImportIdError, Tx, type TxQueryChained } from "../src/tx.ts";

const schema = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) });
async function engine() {
  const p = await MemoryPersistence.open(null, { durable: false });
  const e = await new Engine(schema, p).init();
  return { e, p };
}
const FULL_LO = new Uint8Array(0);
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
/** The intervals of `db.reads` on index `index`. */
const readsOn = (db: Tx, index: string) => db.reads.filter((i) => i.index === index);
const fullRead = (db: Tx, index: string) =>
  readsOn(db, index).some((i) => sameBytes(i.lo, FULL_LO) && i.hi.length === 4 && i.hi.every((b) => b === 0xff));

test("system access ends with asSystem, asSystemSync and the creation of a table", async () => {
  const { e } = await engine();
  const denied = "System tables can only be accessed from db.system.query().";
  await e.mutation(async (db) => {
    await db.asSystem(async () => db.query(TABLES_TABLE).first());
    expect(() => db.query(TABLES_TABLE)).toThrow(denied);
    db.asSystemSync(() => db.query(TABLES_TABLE));
    expect(() => db.query(TABLES_TABLE)).toThrow(denied);
    // A write to an unknown table creates it, reading the catalog as the system; then app access again.
    await db.insert("fresh", { a: 1 });
    expect(() => db.query(TABLES_TABLE)).toThrow(denied);
  });
});

test("a table whose name starts with an underscore is not created, even by the system", async () => {
  const { e } = await engine();
  await expect(e.mutation((db) => db.asSystem(() => db.insert("_mine", {})))).rejects.toThrow(
    'Invalid table name "_mine": names starting with "_" are reserved.',
  );
});

test("resolveIndex: an enabled index's read of its _index row, none for a system index", async () => {
  const { e } = await engine();
  const t = e.catalog.tables.get("items")!;
  const byN = t.indexes.get("by_n")!;
  const indexById = e.catalog.table(INDEX_TABLE).byId.id;
  await e.query(async (db) => {
    const before = readsOn(db, indexById).length;
    db.resolveIndex(t, "by_creation_time");
    expect(readsOn(db, indexById).length).toBe(before);
    expect(db.resolveIndex(t, "by_n")).toBe(byN);
    const k = encodeKey([byN.metaId!]);
    const after = readsOn(db, indexById);
    expect(after.length).toBe(before + 1);
    expect(sameBytes(after.at(-1)!.lo, k) && sameBytes(after.at(-1)!.hi, prefixEnd(k))).toBe(true);
    // Each use records it again (a re-run reads it each time).
    db.resolveIndex(t, "by_n");
    expect(readsOn(db, indexById).length).toBe(before + 2);
  });
});

test("resolveIndex: a pending index records its row when it has one; an unknown name is not found", async () => {
  const { e } = await engine();
  const real = e.catalog.tables.get("items")!;
  const pend = (name: string, metaId?: string): IndexDef => ({
    id: real.indexes.get("by_n")!.id,
    table: "items",
    name,
    fields: ["n"],
    ...(metaId === undefined ? {} : { metaId }),
  });
  const t: TableDef = { ...real, pending: [pend("building", "meta-of-building"), pend("bare")] };
  const indexById = e.catalog.table(INDEX_TABLE).byId.id;
  await e.query(async (db) => {
    const n = readsOn(db, indexById).length;
    expect(() => db.resolveIndex(t, "nope")).toThrow("Index items.nope not found.");
    expect(readsOn(db, indexById).length).toBe(n);
    expect(() => db.resolveIndex(t, "bare")).toThrow(IndexBackfillingError);
    expect(readsOn(db, indexById).length).toBe(n);
    expect(() => db.resolveIndex(t, "building")).toThrow(IndexBackfillingError);
    const k = encodeKey(["meta-of-building"]);
    expect(sameBytes(readsOn(db, indexById).at(-1)!.lo, k)).toBe(true);
  });
});

test("resolveIndex without search indexes: an unknown name is not found", async () => {
  const { e, p } = await engine();
  const tx = new Tx(e.catalog, p, 0n, false);
  expect(() => tx.resolveIndex(e.catalog.tables.get("items")!, "nope")).toThrow("Index items.nope not found.");
});

test("uncountedRead keeps neither the reads nor the documents of its body; it records the whole index", async () => {
  const { e } = await engine();
  await e.mutation(async (db) => {
    for (let i = 0; i < 3; i++) await db.insert("items", { n: i });
  });
  const byId = e.catalog.tables.get("items")!.byId.id;
  await e.query(async (db) => {
    await db.query("items").first();
    const before = db.usage;
    const n = db.reads.length;
    const docs = await db.uncountedRead(byId, () => db.query("items").collect());
    expect(docs).toHaveLength(3);
    expect(db.usage).toEqual(before);
    expect(db.reads.length).toBe(n + 1);
    expect(fullRead(db, byId)).toBe(true);
    // No index (a table that does not exist yet): nothing recorded.
    await db.uncountedRead(undefined, async () => null);
    expect(db.reads.length).toBe(n + 1);
    expect(db.usage).toEqual(before);
  });
});

test("the read limit counts recorded reads less the uncounted ones, up to the limit included", async () => {
  const { e } = await engine();
  const byId = e.catalog.tables.get("items")!.byId.id;
  await e.query(async (db) => {
    db.recordUncounted(byId);
    db.recordUncounted(byId);
    db.limits.databaseQueries = db.usage.databaseQueries + 1;
    db.recordInterval({ index: byId, lo: FULL_LO, hi: prefixEnd(FULL_LO) });
    expect(() => db.recordInterval({ index: byId, lo: FULL_LO, hi: prefixEnd(FULL_LO) })).toThrow(
      "Too many reads in a single function execution",
    );
  });
});

test("db.get of an id of no known table: null, with no read recorded", async () => {
  const { e } = await engine();
  const stray = encodeId(123_456, new Uint8Array(16));
  await e.query(async (db) => {
    await db.query("items").first();
    const before = db.usage.databaseQueries;
    expect(await db.get("items", stray)).toBeNull();
    expect(db.usage.databaseQueries).toBe(before);
  });
});

test("db.get of a private system table's id is null for apps, not an error", async () => {
  const { e } = await engine();
  const id = await e.query((db) => db.asSystem(async () => (await db.query(TABLES_TABLE).first())!._id as string));
  expect(await e.query((db) => db.get(id))).toBeNull();
});

test("db.get counts the documents it hands out, the transaction's own writes too; a deleted one is not", async () => {
  const { e } = await engine();
  const stored = (await e.mutation((db) => db.insert("items", { n: 1 }))) as string;
  await e.mutation(async (db) => {
    const mine = (await db.insert("items", { n: 2 })) as string;
    const gone = (await db.insert("items", { n: 3 })) as string;
    await db.delete("items", gone);
    const rows = db.tableStats.get("items")!.rowsRead;
    const u0 = db.usage;
    expect(await db.get("items", mine)).toMatchObject({ n: 2 });
    const u1 = db.usage;
    expect(u1.documentsRead).toBe(u0.documentsRead + 1);
    expect(u1.bytesRead).toBeGreaterThan(u0.bytesRead);
    expect(await db.get("items", gone)).toBeNull();
    expect(db.usage.documentsRead).toBe(u1.documentsRead);
    expect(await db.get("items", stored)).toMatchObject({ n: 1 });
    expect(db.usage.documentsRead).toBe(u1.documentsRead + 1);
    // Rows read per table: one per get, whether or not it found a document.
    expect(db.tableStats.get("items")!.rowsRead).toBe(rows + 3);
  });
});

test("a scan counts its rows read per table", async () => {
  const { e } = await engine();
  await e.mutation(async (db) => {
    for (let i = 0; i < 5; i++) await db.insert("items", { n: i });
  });
  await e.query(async (db) => {
    await db.query("items").take(2);
    expect(db.tableStats.get("items")!.rowsRead).toBeGreaterThanOrEqual(2);
    await db.query("items").collect();
    expect(db.tableStats.get("items")!.rowsRead).toBeGreaterThanOrEqual(7);
  });
});

test("normalizeId: the table argument must be a string; system tables only with system access", async () => {
  const { e } = await engine();
  const id = await e.query((db) => db.asSystem(async () => (await db.query(TABLES_TABLE).first())!._id as string));
  await e.query(async (db) => {
    expect(() => db.normalizeId(5 as never, id)).toThrow("Invalid argument `table` for `db.normalizeId`");
    expect(() => db.normalizeId(TABLES_TABLE, id)).toThrow(
      "System tables can only be accessed from db.system.normalizeId().",
    );
    expect(db.asSystemSync(() => db.normalizeId(TABLES_TABLE, id))).toBe(id);
    expect(db.normalizeId("missing", id)).toBeNull();
  });
});

test("a missing table's reads depend on _tables (get, query, a virtual table's system table)", async () => {
  const { e } = await engine();
  const tables = e.catalog.table(TABLES_TABLE);
  const tablesById = (tables.indexes.get("by_creation_time") ?? tables.byId).id;
  const stray = encodeId(123_456, new Uint8Array(16));
  await e.query(async (db) => {
    expect(fullRead(db, tablesById)).toBe(false);
    await db.query("items").collect();
    expect(fullRead(db, tablesById)).toBe(false);
    await db.asSystem(async () => db.queryVirtual("v", "_scheduled_jobs", (d) => d).collect());
    expect(fullRead(db, tablesById)).toBe(false);
  });
  await e.query(async (db) => {
    expect(await db.get("missing", stray)).toBeNull();
    expect(fullRead(db, tablesById)).toBe(true);
  });
  await e.query(async (db) => {
    expect(await db.asSystem(() => db.queryVirtual("v", "_none", (d) => d).collect())).toEqual([]);
    expect(fullRead(db, tablesById)).toBe(true);
  });
});

test("queryDef, importInsert and deleteFrom are for system transactions; importInsert writes", async () => {
  const { e } = await engine();
  const t = e.catalog.tables.get("items")!;
  const doc = { _id: "x", _creationTime: 1 };
  await expect(e.query(async (db) => db.queryDef(t))).rejects.toThrow("queryDef is for system transactions");
  await expect(e.mutation((db) => db.importInsert(t, {}))).rejects.toThrow("importInsert is for system transactions");
  await expect(e.query((db) => db.asSystem(() => db.importInsert(t, {})))).rejects.toThrow("queries cannot write");
  await expect(e.mutation((db) => db.deleteFrom(t, doc))).rejects.toThrow("deleteFrom is for system transactions");
});

test("queryDef and a private system query may set their order once", async () => {
  const { e } = await engine();
  const t = e.catalog.tables.get("items")!;
  await e.mutation((db) => db.insert("items", { n: 1 }));
  expect(await e.query((db) => db.asSystem(() => db.queryDef(t).order("desc").collect()))).toHaveLength(1);
  expect(await e.query((db) => db.privateSystemQuery("_secret").order("desc").collect())).toEqual([]);
});

test("importInsert: new ids are random, new creation times increase; codes and messages of refused rows", async () => {
  const { e } = await engine();
  const hidden = await e.createHiddenTable("other");
  const [a, b] = await e.mutation((db) =>
    db.asSystem(async () => [await db.importInsert(hidden, { k: 1 }), await db.importInsert(hidden, { k: 2 })]),
  );
  expect(a).not.toBe(b);
  const docs = await e.query((db) => db.asSystem(() => db.queryDef(hidden).collect()));
  expect(docs.map((d) => d.k)).toEqual([1, 2]);
  const [t1, t2] = docs.map((d) => d._creationTime as number);
  expect(typeof t1).toBe("number");
  expect(t2!).toBeGreaterThan(t1!);
  const itemsId = (await e.mutation((db) => db.insert("items", { n: 1 }))) as string;
  const refused = async (fields: Record<string, unknown>) =>
    e.mutation((db) => db.asSystem(() => db.importInsert(hidden, fields))).catch((err) => err);
  const conflict = await refused({ _id: itemsId });
  expect(conflict).toBeInstanceOf(ImportIdError);
  expect(conflict.code).toBe("ImportConflict");
  const invalid = await refused({ _id: "nope" });
  expect(invalid.code).toBe("InvalidId");
  expect((await refused({ _private: 1 })).message).toBe(
    "Field '_private' starts with an underscore, which is only allowed for system fields like '_id'",
  );
  expect((await refused({ a: new Array(10_000).fill(0) })).message).toStartWith(
    "Invalid argument `value` for `db.insert`: ",
  );
  // A kept id from this table's number.
  const kept = encodeId(hidden.number, new Uint8Array(16).fill(7));
  expect(await e.mutation((db) => db.asSystem(() => db.importInsert(hidden, { _id: kept })))).toBe(kept);
});

test("take(0) reads no document", async () => {
  const { e } = await engine();
  await e.mutation((db) => db.insert("items", { n: 1 }));
  await e.query(async (db) => {
    expect(await db.query("items").take(0)).toEqual([]);
    expect(db.usage.documentsRead).toBe(0);
  });
});

test("descending scans past a page: each document once, stored or this transaction's own", async () => {
  const { e } = await engine();
  const N = 150;
  await e.mutation(async (db) => {
    for (let i = 0; i < N; i++) await db.insert("items", { n: i });
  });
  const expected = Array.from({ length: N }, (_, i) => N - 1 - i);
  expect((await e.query((db) => db.query("items").order("desc").collect())).map((d) => d.n)).toEqual(expected);
  expect((await e.query((db) => db.query("items").withIndex("by_n").order("desc").collect())).map((d) => d.n)).toEqual(
    expected,
  );
  const iterated = async (db: Tx) => {
    const out: unknown[] = [];
    for await (const d of db.query("items").withIndex("by_n").order("desc")) out.push(d.n);
    return out;
  };
  expect(await e.query(iterated)).toEqual(expected);
  await e.mutation(async (db) => {
    for (let i = N; i < 2 * N; i++) await db.insert("items", { n: i });
    const all = Array.from({ length: 2 * N }, (_, i) => 2 * N - 1 - i);
    expect((await db.query("items").withIndex("by_n").order("desc").collect()).map((d) => d.n)).toEqual(all);
    expect(await iterated(db)).toEqual(all);
  });
});

test("a store failure as the snapshot leaves retention is the store's failure; a dangling reference stays its cause", async () => {
  const { e, p } = await engine();
  await e.mutation((db) => db.insert("items", { n: 1 }));
  const scan = p.scan.bind(p);
  let failure: Error | null = null;
  p.scan = ((...args: Parameters<typeof scan>) => (failure ? Promise.reject(failure) : scan(...args))) as never;
  try {
    failure = new Error("disk on fire");
    let checks = 0;
    const err = await e
      .query(async (db) => {
        // Within retention at the first check; out of it afterwards.
        db.retention = {
          check() {
            if (++checks > 1) throw new Error("out of retention");
          },
        };
        return db.query("items").collect();
      })
      .catch((x) => x);
    expect(err).toBeInstanceOf(PersistenceReadError);
    expect(err.message).toBe("persistence read failed: disk on fire");
    failure = new DanglingReferenceError("index" as never, "id" as never, 1n, false);
    const dangling = await e
      .query((db) => {
        db.retention = null;
        return db.query("items").collect();
      })
      .catch((x) => x);
    expect(dangling).toBeInstanceOf(PersistenceReadError);
    expect(dangling.cause).toBeInstanceOf(DanglingReferenceError);
  } finally {
    p.scan = scan as never;
  }
});

test("iterating a search: only its matches, by relevance, through its filter, ending at a limit", async () => {
  const e = await new Engine(
    defineSchema({ notes: defineTable(v.any()).searchIndex("s", { searchField: "body" }) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  await e.searchReady();
  await e.mutation(async (db) => {
    for (const [body, n] of [
      ["pear", 0],
      ["apple pie", 1],
      ["apple apple apple", 2],
      ["apple apple jam", 3],
    ] as const)
      await db.insert("notes", { body, n });
  });
  const iterate = (shape: (q: TxQueryChained) => TxQueryChained) =>
    e.query(async (db) => {
      const out: number[] = [];
      for await (const d of shape(db.query("notes").withSearchIndex("s", (s) => s.search("body", "apple"))))
        out.push(d.n as number);
      return { out, read: db.usage.documentsRead };
    });
  expect((await iterate((q) => q)).out).toEqual([2, 3, 1]);
  expect((await iterate((q) => q.filter((f) => f.neq(f.field("n"), 3)))).out).toEqual([2, 1]);
  const limited = await iterate((q) => q.limit(1));
  expect(limited.out).toEqual([2]);
  expect(limited.read).toBe(1);
});

test("iterating a query limited to nothing reads nothing", async () => {
  const { e } = await engine();
  await e.mutation((db) => db.insert("items", { n: 1 }));
  await e.query(async (db) => {
    for await (const _ of db.query("items").limit(0)) throw new Error("no document expected");
    expect(db.usage.documentsRead).toBe(0);
  });
});

test("a transaction is not the system's identity until its runner says so", async () => {
  const { e, p } = await engine();
  expect(new Tx(e.catalog, p, 0n, false).systemIdentity).toBe(false);
  expect(await e.query(async (db) => db.systemIdentity)).toBe(false);
});

test("a system table outside db.system: Convex's message for each operation (STUDY-151)", async () => {
  const { e } = await engine();
  const id = await e.query((db) => db.asSystem(async () => (await db.query(TABLES_TABLE).first())!._id as string));
  const withDbSystem = "System tables can only be accessed with db.system.";
  await expect(e.mutation((db) => db.insert(TABLES_TABLE, {}))).rejects.toThrow(
    "System tables (prefixed with `_`) are read-only.",
  );
  await expect(e.query((db) => db.query(TABLES_TABLE).first())).rejects.toThrow(
    "System tables can only be accessed from db.system.query().",
  );
  await expect(e.mutation((db) => db.patch(TABLES_TABLE, id, {}))).rejects.toThrow(withDbSystem);
  await expect(e.mutation((db) => db.replace(TABLES_TABLE, id, {}))).rejects.toThrow(withDbSystem);
  await expect(e.mutation((db) => db.delete(TABLES_TABLE, id))).rejects.toThrow(withDbSystem);
  // `db.system` reads only system tables: a user table is refused with Convex's message.
  await expect(e.query(async (db) => db.system.normalizeId("users", id))).rejects.toThrow(
    "User tables can only be accessed from db.normalizeId().",
  );
});

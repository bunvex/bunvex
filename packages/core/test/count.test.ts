// `db.query(table).count()` (STUDY-107), Convex's internal `count()`: the table's documents at the
// transaction's snapshot with its own writes, a read of the whole table (re-run on any write to it) charged
// to no read limit, on the query initializer only; virtual tables through `db.system`; while the table
// summaries are built, Convex's `TableSummariesUnavailable`.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { FILE_STORAGE_TABLE, SCHEDULED_FUNCTIONS_TABLE, STORAGE_TABLE } from "../src/catalog.ts";
import { OutOfRetentionError } from "../src/committer.ts";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import { TableSummaries, TableSummariesUnavailableError } from "../src/table-summaries.ts";
import type { Tx } from "../src/tx.ts";

const schema = defineSchema({ t: defineTable(v.any()).index("by_x", ["x"]), u: defineTable(v.any()) });

async function engine() {
  const e = await new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
  await e.summariesReady();
  return e;
}

test("the count includes the transaction's own inserts and deletes", async () => {
  const e = await engine();
  const [a] = await e.mutation(async (db) => [await db.insert("t", { x: 1 }), await db.insert("t", { x: 2 })]);
  const counts = await e.mutation(async (db) => {
    const before = await db.query("t").count();
    await db.insert("t", { x: 3 });
    const inserted = await db.query("t").count();
    await db.delete(a);
    await db.patch((await db.query("t").first())!._id, { x: 9 }); // a replace: no change
    return [before, inserted, await db.query("t").count(), await db.query("u").count()];
  });
  expect(counts).toEqual([2, 3, 2, 0]);
  expect(await e.query((db) => db.query("t").count())).toBe(2);
});

test("a missing table counts 0; a bad table name is an argument error", async () => {
  const e = await engine();
  expect(await e.query((db) => db.query("nothing_here").count())).toBe(0);
  await expect(e.query((db) => db.query("bad-name").count())).rejects.toThrow(
    'Invalid argument `table` for `db.count`: Invalid table name "bad-name"',
  );
});

test("the count is the snapshot's, not the latest commit's", async () => {
  const e = await engine();
  await e.mutation(async (db) => {
    await db.insert("t", { x: 1 });
    await db.insert("t", { x: 2 });
  });
  const at = e.committer.visibleTs;
  await e.mutation((db) => db.insert("t", { x: 3 }));
  const ids = await e.mutation(async (db) => [await db.insert("t", { x: 4 }), await db.insert("u", {})]);
  await e.mutation((db) => db.delete(ids[0]));
  const old = await e.queryTracked((db) => Promise.all([db.query("t").count(), db.query("t").collect()]), {}, at);
  expect(old.ok && [old.value[0], old.value[1].length]).toEqual([2, 2]);
  expect(await e.query((db) => db.query("t").count())).toBe(3);
});

test("the read covers the whole table: a write to it invalidates, another table's does not", async () => {
  const e = await engine();
  await e.mutation((db) => db.insert("t", { x: 1 }));
  const r = await e.queryTracked((db) => db.query("t").count());
  expect(r.ok && r.value).toBe(1);
  await e.mutation((db) => db.insert("u", {}));
  expect(e.committer.changedBetween(r.reads, r.ts, e.committer.visibleTs)).toBe(false);
  const id = await e.mutation((db) => db.insert("t", { x: 2 }));
  expect(e.committer.changedBetween(r.reads, r.ts, e.committer.visibleTs)).toBe(true);
  // Even a write that leaves the count alone (a replace): the read is of the table, as Convex's.
  const r2 = await e.queryTracked((db) => db.query("t").count());
  await e.mutation((db) => db.patch(id, { x: 3 }));
  expect(e.committer.changedBetween(r2.reads, r2.ts, e.committer.visibleTs)).toBe(true);
  // A missing table's count is re-run when the table is created.
  const r3 = await e.queryTracked((db) => db.query("later").count());
  await e.mutation((db) => db.insert("later", {}));
  expect(e.committer.changedBetween(r3.reads, r3.ts, e.committer.visibleTs)).toBe(true);
});

test("no documents are read: the count is charged to no read limit", async () => {
  const e = await engine();
  await e.mutation(async (db) => {
    for (let i = 0; i < 5; i++) await db.insert("t", { x: i });
  });
  const used = await e.query(async (db) => {
    const q = db.query("t"); // reads the table's `_tables` entry (a read interval of its own)
    const before = db.usage.databaseQueries;
    await q.count();
    const u = db.usage;
    return { docs: u.documentsRead, bytes: u.bytesRead, queries: u.databaseQueries - before };
  });
  expect(used).toEqual({ docs: 0, bytes: 0, queries: 1 });
});

test("only on the query initializer, which it leaves usable", async () => {
  const e = await engine();
  await e.mutation((db) => db.insert("t", { x: 1 }));
  const shapes = await e.query(async (db) => {
    const q = db.query("t");
    const n = await q.count();
    const docs = await q.collect(); // count() did not consume the query
    return [
      n,
      docs.length,
      typeof (db.query("t").withIndex("by_x") as unknown as { count?: unknown }).count,
      typeof (db.query("t").fullTableScan() as unknown as { count?: unknown }).count,
      typeof (db.query("t").order("desc") as unknown as { count?: unknown }).count,
      typeof (db.query("t").filter((f) => f.eq(f.field("x"), 1)) as unknown as { count?: unknown }).count,
      await db.table("t").query().count(),
    ];
  });
  expect(shapes).toEqual([1, 1, "undefined", "undefined", "undefined", "undefined", 1]);
});

// The virtual tables (STUDY-125) count as their system tables: `_storage` as `_file_storage`.
test("virtual tables are counted through db.system; db.query refuses them", async () => {
  const e = await engine();
  await e.mutation(async (db) => {
    for (let i = 0; i < 3; i++)
      await db.asSystem(() => db.insert(FILE_STORAGE_TABLE, { storageId: `s${i}`, storageKey: `b${i}`, size: 1n }));
  });
  const counts = await e.query(async (db) => [
    await db.system.query(STORAGE_TABLE).count(),
    await db.system.query(SCHEDULED_FUNCTIONS_TABLE).count(),
  ]);
  expect(counts).toEqual([3, 0]);
  await expect(e.query(async (db) => db.query(STORAGE_TABLE).count())).rejects.toThrow("System table _storage");
  // Inside a mutation, its own writes count too.
  expect(
    await e.mutation(async (db) => {
      await db.asSystem(() => db.insert(FILE_STORAGE_TABLE, { storageId: "s9", storageKey: "b9", size: 1n }));
      return db.system.query(STORAGE_TABLE).count();
    }),
  ).toBe(4);
});

test("while the summaries are built: Convex's TableSummariesUnavailable (uncatchable: server/test/count.test.ts)", async () => {
  const e = await engine();
  await e.mutation((db) => db.insert("t", { x: 1 }));
  // As at a start, before the build finishes (the summaries queue commits until then).
  const summaries = e.tableSummaries as unknown as { queued: unknown[] | null };
  summaries.queued = [];
  const counted = e.query((db) => db.query("t").count());
  await expect(counted).rejects.toThrow(TableSummariesUnavailableError);
  await expect(counted).rejects.toMatchObject({
    code: "TableSummariesUnavailable",
    message: "Table count unavailable while bootstrapping",
  });
  e.tableSummaries.finish();
  expect(await e.query((db) => db.query("t").count())).toBe(1);
});

test("a count's changes are kept as long as the write log keeps its commits", () => {
  const s = new TableSummaries();
  let logStart = 0n;
  s.retainedAfter = () => logStart;
  s.finish();
  s.apply(1n, [{ tablet: "t7", old: null, next: { _id: "a" } as never }]);
  s.apply(2n, [{ tablet: "t7", old: null, next: { _id: "b" } as never }]);
  expect([s.countAt("t7", 0n), s.countAt("t7", 1n), s.countAt("t7", 2n), s.countAt("t8", 1n)]).toEqual([0, 1, 2, 0]);
  logStart = 2n; // the write log dropped the commits at ts 1 and 2
  s.apply(3n, [{ tablet: "t8", old: null, next: { _id: "c" } as never }]);
  expect([s.countAt("t7", 2n), s.countAt("t8", 2n), s.countAt("t8", 3n)]).toEqual([2, 0, 1]);
  expect(() => s.countAt("t7", 1n)).toThrow(OutOfRetentionError);
});

test("the engine drops a count's changes with the write log's commits", async () => {
  const e = await new Engine(schema, await MemoryPersistence.open(null, { durable: false }), {
    writeLogRetention: { minRetentionNs: 0n, maxRetentionNs: 0n },
  }).init();
  await e.summariesReady();
  await e.mutation((db) => db.insert("t", { x: 1 }));
  const at = e.committer.visibleTs;
  await e.mutation((db) => db.insert("t", { x: 2 }));
  // Each commit purges the log up to the one before it (the snapshot at the purged ts itself stays valid).
  await e.mutation((db) => db.insert("u", {}));
  await e.mutation((db) => db.insert("u", {}));
  expect(e.committer.logStartTs).toBeGreaterThan(at);
  const old = await e.queryTracked((db) => db.query("t").count(), {}, at);
  expect(!old.ok && old.error).toBeInstanceOf(OutOfRetentionError);
  expect(await e.query((db) => db.query("t").count())).toBe(2);
});

/** Run `start` (one transaction that counts, waits, counts again) while commits push the write log past it. */
async function countAcrossCommits(start: (e: Engine, body: (db: Tx) => Promise<number[]>) => Promise<number[]>) {
  const e = await new Engine(schema, await MemoryPersistence.open(null, { durable: false }), {
    writeLogRetention: { minRetentionNs: 0n, maxRetentionNs: 0n },
  }).init();
  await e.summariesReady();
  await e.mutation((db) => db.insert("t", { x: 1 }));
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const running = start(e, async (db) => {
    const before = await db.query("t").count();
    started.resolve();
    await gate.promise; // meanwhile commits land and the write log drops the older ones
    return [before, await db.query("t").count(), await db.query("u").count()];
  });
  await started.promise;
  const at = e.committer.visibleTs;
  for (let i = 0; i < 4; i++) await e.mutation((db) => db.insert(i % 2 ? "u" : "t", { x: i }));
  expect(e.committer.logStartTs).toBeGreaterThan(at);
  gate.resolve();
  const counts = await running;
  expect(await e.query((db) => db.query("t").count())).toBe(3);
  return counts;
}

test("a running transaction counts at its snapshot for its whole life, past the write log's retention", async () => {
  expect(await countAcrossCommits((e, body) => e.query(body))).toEqual([1, 1, 0]);
  // A subscription's run (`queryTracked`) too.
  const tracked = await countAcrossCommits(async (e, body) => {
    const r = await e.queryTracked(body);
    if (!r.ok) throw r.error;
    return r.value;
  });
  expect(tracked).toEqual([1, 1, 0]);
});

test("pins: changes are kept while a transaction holds an older snapshot, dropped after", () => {
  const s = new TableSummaries();
  s.retainedAfter = () => (1n << 63n) - 1n; // the write log keeps nothing
  s.finish();
  const unpin = s.pin(1n);
  const unpinAgain = s.pin(1n);
  for (let ts = 2n; ts <= 4n; ts++) s.apply(ts, [{ tablet: "t7", old: null, next: { _id: `d${ts}` } as never }]);
  expect(s.countAt("t7", 1n)).toBe(0);
  unpin();
  s.apply(5n, [{ tablet: "t7", old: null, next: { _id: "d5" } as never }]);
  expect(s.countAt("t7", 1n)).toBe(0); // still held once
  unpinAgain();
  unpinAgain(); // twice is once
  s.apply(6n, [{ tablet: "t7", old: null, next: { _id: "d6" } as never }]);
  expect(() => s.countAt("t7", 1n)).toThrow(OutOfRetentionError);
  expect(s.countAt("t7", 6n)).toBe(5);
});

test("db.system.query counts any system table, as Convex's 1.0/count; unknown names are 0", async () => {
  const e = await engine();
  const r = await e.mutation(async (db) => {
    const tables = (await db.asSystem(() => db.query("_tables").collect())).length;
    const indexes = (await db.asSystem(() => db.query("_index").collect())).length;
    const before = await db.system.query("_tables").count();
    await db.insert("brand_new", {}); // creates the table: its `_tables` row is this transaction's own write
    return {
      tables,
      indexes,
      before,
      after: await db.system.query("_tables").count(),
      index: await db.system.query("_index").count(),
      unknown: await db.system.query("_no_such_table").count(),
      // Its reads find nothing, whatever the index, as Convex's (the index is missing to a function).
      read: await db.system.query("_tables").collect(),
      byIndex: await db.system.query("_index").withIndex("by_anything").collect(),
    };
  });
  expect(r.before).toBe(r.tables);
  expect(r.after).toBe(r.tables + 1);
  expect(r.index).toBeGreaterThan(r.indexes); // the new table's system indexes too
  expect([r.unknown, r.read, r.byIndex]).toEqual([0, [], []]);
  expect(await e.query((db) => db.system.query("_tables").count())).toBe(r.tables + 1);
  // User tables are still refused through db.system, and system tables through db.query.
  await expect(e.query((db) => db.system.query("t").count())).rejects.toThrow();
  await expect(e.query((db) => db.query("_tables").count())).rejects.toThrow("System table _tables");
});

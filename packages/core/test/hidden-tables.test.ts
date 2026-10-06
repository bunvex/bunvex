// Hidden and deleted tables (STUDY-42 PR 2), as Convex's table states: a hidden table is invisible to
// functions (it may share an active table's name and number), filled with imported documents (their `_id`
// and `_creationTime` kept), then activated in ONE commit that replaces the active table; transactions that
// used the replaced table conflict, cached queries are invalidated; a deleted table is emptied in the
// background, and the work resumes after a restart.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeId, v } from "@bunvex/values";
import { SCHEDULED_JOB_ARGS_TABLE, SCHEDULED_JOBS_TABLE, TABLES_TABLE, tableMeta } from "../src/catalog.ts";
import { Engine, TABLE_DELETION_BATCH } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";
import { dueJobs, getJob, insertJob } from "../src/scheduled-jobs.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const schema = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) });
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** Wait for the deletion worker, failing (instead of hanging) if it never finishes. */
const deleted = async (e: Engine) => {
  const timeout = Bun.sleep(10_000).then(() => {
    throw new Error("the table deletion did not finish");
  });
  try {
    await Promise.race([e.tablesDeleted(), timeout]);
  } catch (err) {
    await e.close();
    throw err;
  }
};
const memory = async () => new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
const names = (e: Engine) => e.query(async (db) => (await db.query("items").collect()).map((d) => d.n));
const sys = <T>(e: Engine, f: (db: import("../src/tx.ts").Tx) => Promise<T>) =>
  e.mutation((db) => db.asSystem(() => f(db)));

test("a hidden table: invisible, filled with kept ids and times, its indexes copied; activated in one commit", async () => {
  const e = await memory();
  await e.mutation((db) => db.insert("items", { n: "old" }));
  const active = e.catalog.tables.get("items")!;
  const hidden = await e.createHiddenTable("items", { number: active.number, copyIndexesOf: "items" });
  expect(hidden.number).toBe(active.number);
  expect([...hidden.indexes.keys()].sort()).toEqual(["by_creation_time", "by_id", "by_n"]);
  const keptId = (await e.mutation((db) => db.insert("items", { n: "probe" }))) as string;
  await e.mutation((db) => db.delete("items", keptId));
  await sys(e, async (db) => {
    await db.importInsert(hidden, { _id: keptId, _creationTime: 1234.5, n: "b" });
    await db.importInsert(hidden, { n: "a" });
  });
  // Functions still see the active table.
  expect(await names(e)).toEqual(["old"]);
  // The hidden one, through its definition, with its copied index.
  const inHidden = await e.query((db) => db.asSystem(() => db.queryDef(hidden).withIndex("by_n").collect()));
  expect(inHidden.map((d) => [d.n, d._id === keptId, d._creationTime === 1234.5])).toEqual([
    ["a", false, false],
    ["b", true, true],
  ]);
  await e.activateTables([hidden.id]);
  expect((await names(e)).sort()).toEqual(["a", "b"]);
  expect(e.catalog.tables.get("items")!.id).toBe(hidden.id);
  await deleted(e);
  expect(e.catalog.deleting.size).toBe(0);
  const rows = await e.query((db) => db.asSystem(() => db.query(TABLES_TABLE).collect()));
  expect(rows.filter((r) => r.name === "items").map((r) => r.state)).toEqual(["active"]);
  await e.close();
});

test("activation conflicts with a mutation that used the old table, and invalidates cached queries", async () => {
  const e = await memory();
  await e.mutation((db) => db.insert("items", { n: "old" }));
  const cached = () => e.query(async (db) => (await db.query("items").collect()).length, "count");
  expect(await cached()).toBe(1);
  const hidden = await e.createHiddenTable("items", { copyIndexesOf: "items" });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let attempts = 0;
  const racing = e.mutation(async (db) => {
    attempts++;
    await db.insert("items", { n: "racer" });
    if (attempts === 1) await gate;
  });
  await Bun.sleep(10);
  await e.activateTables([hidden.id]);
  release();
  await racing;
  // Retried on the new table: the write is not lost in the deleted one.
  expect(attempts).toBe(2);
  expect(await names(e)).toEqual(["racer"]);
  expect(await cached()).toBe(1); // recomputed on the new table, not the old cached 1 by chance
  await e.mutation((db) => db.insert("items", { n: "more" }));
  expect(await cached()).toBe(2);
  await e.close();
});

test("imported ids: from another table's number, or not an id, are refused with Convex's messages", async () => {
  const e = await memory();
  const hidden = await e.createHiddenTable("other");
  const itemsId = (await e.mutation((db) => db.insert("items", { n: 1 }))) as string;
  await expect(sys(e, (db) => db.importInsert(hidden, { _id: itemsId }))).rejects.toThrow(
    `_id ${itemsId} cannot be imported into 'other' because it came from a different deployment and conflict with preexisting tables in this deployment. Try deleting preexisting tables or importing into an empty deployment.`,
  );
  await expect(sys(e, (db) => db.importInsert(hidden, { _id: "nope" }))).rejects.toThrow("invalid _id 'nope'");
  // A chosen number, and a number already taken.
  const chosen = await e.createHiddenTable("fresh", { number: 10050 });
  const id = await sys(e, (db) => db.importInsert(chosen, {}));
  expect(decodeId(id).tableNumber).toBe(10050);
  await expect(e.createHiddenTable("again", { number: 10050 })).rejects.toThrow(
    'Table number 10050 is already used by table "fresh".',
  );
  await e.close();
});

test("a deleted table disappears at once and is emptied in the background, across a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-hidden-"));
  dirs.push(dir);
  const open = async () => new Engine(schema, new SqlitePersistence(join(dir, "db.sqlite"), { durable: true })).init();
  const e = await open();
  const n = TABLE_DELETION_BATCH + 200;
  for (let i = 0; i < n; i += 500)
    await e.mutation(async (db) => {
      for (let j = i; j < Math.min(i + 500, n); j++) await db.insert("items", { n: j });
    });
  const tablet = e.catalog.tables.get("items")!.id;
  await e.deleteTable("items");
  expect(e.catalog.tables.has("items")).toBe(false);
  expect(e.catalog.deleting.has(tablet)).toBe(true);
  // Close before the worker is done: the next start resumes it.
  await e.close();
  const again = await open();
  // The schema still declares `items`: a new active table, beside the one being deleted.
  expect(again.catalog.tables.get("items")?.id).not.toBe(tablet);
  expect(again.catalog.tables.has("items")).toBe(true);
  await deleted(again);
  expect(again.catalog.deleting.size).toBe(0);
  const rows = await again.query((db) => db.asSystem(() => db.query(TABLES_TABLE).collect()));
  expect(rows.some((r) => tableMeta(r).tablet === tablet)).toBe(false);
  // The schema's table is created afresh, empty.
  expect(await names(again)).toEqual([]);
  await again.close();
});

test("a hidden table survives a restart as hidden, beside the active table of its name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-hidden-"));
  dirs.push(dir);
  const open = async () => new Engine(schema, new SqlitePersistence(join(dir, "db.sqlite"), { durable: true })).init();
  const e = await open();
  await e.mutation((db) => db.insert("items", { n: "active" }));
  const hidden = await e.createHiddenTable("items", { copyIndexesOf: "items" });
  await e.close();
  const again = await open();
  expect(again.catalog.hidden.has(hidden.id)).toBe(true);
  expect(await names(again)).toEqual(["active"]);
  await again.close();
});

test("stale hidden tables (a crashed import's) are dropped after their age, as Convex's cleanup; others stay", async () => {
  const e = await memory();
  await e.mutation((db) => db.insert("items", { n: 1 }));
  const left = await e.createHiddenTable("items", { copyIndexesOf: "items" });
  await sys(e, (db) => db.importInsert(left, { n: 2 }));
  const day = 24 * 60 * 60 * 1000;
  // Young: kept.
  expect(await e.dropStaleHiddenTables(14 * day)).toBe(0);
  expect(e.catalog.hidden.size).toBe(1);
  // Past the age: dropped and emptied; the active table is untouched.
  expect(await e.dropStaleHiddenTables(14 * day, Date.now() + 15 * day)).toBe(1);
  await deleted(e);
  expect(e.catalog.hidden.size).toBe(0);
  expect(await names(e)).toEqual([1]);
  await e.close();
});

test("deleteTables: one commit; a pending schema that uses a deleted table fails, as Convex's enforce_table_deletion", async () => {
  const e = await memory();
  await e.mutation((db) => db.insert("loose", { n: 1 }));
  await e.mutation((db) => db.insert("other", { n: 1 }));
  // A pending schema that declares `loose` (the push waits on nothing else here).
  const { schemaId } = await e.startSchemaPush(
    defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]), loose: defineTable(v.any()) }),
  );
  await e.deleteTables(["loose", "other"]);
  await deleted(e);
  expect(e.catalog.tables.has("loose")).toBe(false);
  expect(e.catalog.tables.has("other")).toBe(false);
  const row = (await e.query((db) => db.asSystem(() => db.get("_schemas", schemaId)))) as Record<string, unknown>;
  // Convex's failed state: the error and the table in it.
  expect(row.state).toEqual({
    state: "failed",
    error: 'Failed to delete table "loose" because it appears in the schema',
    table_name: "loose",
  });
  await e.close();
});

test("replaceWithEmptyTables: a system table emptied in one commit, same number and indexes, and so after a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-hidden-"));
  dirs.push(dir);
  const open = async () => new Engine(schema, new SqlitePersistence(join(dir, "db.sqlite"), { durable: true })).init();
  const e = await open();
  const job = (engine: Engine, name: string) =>
    engine.mutation((db) => insertJob(db, { name, args: [{}], scheduledTime: 1, now: 1 }));
  const old = await job(e, "a.js:f");
  await job(e, "b.js:g");
  const before = e.catalog.table(SCHEDULED_JOBS_TABLE);
  let inCommit = 0;
  await e.replaceWithEmptyTables([SCHEDULED_JOBS_TABLE, SCHEDULED_JOB_ARGS_TABLE], async () => {
    inCommit++;
  });
  expect(inCommit).toBe(1);
  const after = e.catalog.table(SCHEDULED_JOBS_TABLE);
  expect(after.id).not.toBe(before.id);
  expect(after.number).toBe(before.number);
  expect([...after.indexes.keys()].sort()).toEqual([...before.indexes.keys()].sort());
  expect(await e.query((db) => dueJobs(db, 10, 100))).toEqual([]);
  expect(await e.query((db) => getJob(db, old))).toBeNull();
  await deleted(e);
  await job(e, "c.js:h");
  await e.close();
  const again = await open();
  expect((await again.query((db) => dueJobs(db, 10, 100))).map((j) => j.name)).toEqual(["c.js:h"]);
  expect(again.catalog.table(SCHEDULED_JOBS_TABLE).id).toBe(after.id);
  await again.close();
});

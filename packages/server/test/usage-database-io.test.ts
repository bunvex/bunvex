// Database I/O usage (STUDY-71), as Convex's usage tracker meters it: a read is the document's size plus, from
// a user-defined index, its index key's bytes; a committed write is the new version's size plus each
// user-defined index entry it adds (`IndexKey::size`), one row per document and one per index entry changed;
// system tables and failed writes are not metered. Expected sizes are worked out by hand from Convex's rules.
import { expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import type { FunctionLog, UsageStats } from "../src/function-log.ts";
import { Functions, mutation, query } from "../src/functions.ts";

/** Convex's `Size` of a string: tag, UTF-8 bytes, terminator. */
const str = (s: string) => Buffer.byteLength(s) + 2;
/** A stored document `{_id, _creationTime, n, ...extra}` by Convex's object size. */
const docSize = (id: string, n: number, extra = 0) => 2 + (3 + 1 + str(id)) + (13 + 1 + 9) + (1 + 1 + 9) + extra;
/**
 * A `by_n` entry, whose fields are `[n, _creationTime, _id]` as Convex's: written, `IndexKey::size` (33 plus
 * each value's size); read, its sort key (a float is a tag and 8 bytes, a string a tag, its bytes and a 0).
 */
const entryWritten = (id: string) => 33 + 9 + 9 + str(id);
const keyRead = (id: string) => 9 + 9 + (1 + id.length + 1);

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const usage: { path: string; u: UsageStats; error: string | null }[] = [];
  const functions = new Functions(engine).register("m", {
    insert: mutation(({ db }, { n }: { n: number }) => db.insert("items", { n })),
    touch: mutation(({ db }, { id }: { id: string }) => db.patch(id as never, { m: true })),
    move: mutation(({ db }, { id }: { id: string }) => db.patch(id as never, { n: 2 })),
    remove: mutation(({ db }, { id }: { id: string }) => db.delete(id as never)),
    byIndex: query(({ db }) =>
      db
        .query("items")
        .withIndex("by_n", (q) => q.eq("n", 1))
        .collect(),
    ),
    scan: query(({ db }) => db.query("items").collect()),
    filtered: query(({ db }) =>
      db
        .query("items")
        .withIndex("by_n")
        .filter((q) => q.eq(q.field("n"), 3))
        .collect(),
    ),
    get: query(({ db }, { id }: { id: string }) => db.get(id as never)),
    system: query(({ db }) => db.system.query("_scheduled_functions").collect()),
    schedule: mutation(({ scheduler }) => scheduler.runAfter(1e9, "m:scan" as never, {})),
    readOwnWrite: mutation(async ({ db }) => {
      const id = await db.insert("items", { n: 5 });
      return db.get(id);
    }),
    readThenFail: mutation(async ({ db }) => {
      await db.query("items").collect();
      await db.insert("items", { n: 9 });
      throw new Error("no");
    }),
  });
  functions.functionLog = {
    append: (p: any) => {
      if (p.kind === "Completion") usage.push({ path: p.identifier, u: p.usageStats, error: p.error });
    },
  } as unknown as FunctionLog;
  const last = () => usage.at(-1)!.u;
  return { functions, last };
}

test("writes: the new version and its user index entries; index rows changed; a delete adds no bytes", async () => {
  const { functions, last } = await setup();
  const id = (await functions.runMutation("m:insert", { n: 1 })) as string;
  // by_id, by_creation_time and by_n each get one entry; only by_n's bytes are metered.
  expect(last()).toMatchObject({
    databaseWriteDocuments: 1,
    databaseWriteIndexRows: 3,
    databaseWriteBytes: docSize(id, 1) + entryWritten(id),
    databaseIoWriteBytes: docSize(id, 1) + entryWritten(id),
    databaseReadBytes: 0,
  });
  // A patch that keeps every key: one entry per index, still charged.
  await functions.runMutation("m:touch", { id });
  const touched = docSize(id, 1, 1 + 1 + 1);
  expect(last()).toMatchObject({ databaseWriteIndexRows: 3, databaseWriteBytes: touched + entryWritten(id) });
  // A patch that moves the by_n key: its old entry goes and a new one comes.
  await functions.runMutation("m:move", { id });
  expect(last()).toMatchObject({ databaseWriteIndexRows: 4, databaseWriteBytes: touched + entryWritten(id) });
  await functions.runMutation("m:remove", { id });
  expect(last()).toMatchObject({ databaseWriteDocuments: 1, databaseWriteIndexRows: 3, databaseWriteBytes: 0 });
});

test("reads: a user index adds its key's bytes; by_id, by_creation_time and a get do not", async () => {
  const { functions, last } = await setup();
  const a = (await functions.runMutation("m:insert", { n: 1 })) as string;
  const b = (await functions.runMutation("m:insert", { n: 1 })) as string;
  await functions.runMutation("m:insert", { n: 3 });
  await functions.runQuery("m:byIndex", {});
  expect(last()).toMatchObject({
    databaseReadDocuments: 2,
    databaseReadBytes: docSize(a, 1) + keyRead(a) + docSize(b, 1) + keyRead(b),
    databaseIoReadBytes: docSize(a, 1) + keyRead(a) + docSize(b, 1) + keyRead(b),
  });
  await functions.runQuery("m:scan", {});
  expect(last().databaseReadDocuments).toBe(3);
  expect(last().databaseReadBytes).toBe(docSize(a, 1) * 3);
  // A filter runs over what the index hands out: the documents it drops were read all the same.
  const c = (await functions.runQuery("m:filtered", {})) as { _id: string }[];
  expect(c).toHaveLength(1);
  expect(last()).toMatchObject({
    databaseReadDocuments: 3,
    databaseReadBytes: docSize(a, 1) * 3 + keyRead(a) * 3,
  });
  await functions.runQuery("m:get", { id: a });
  expect(last()).toMatchObject({ databaseReadDocuments: 1, databaseReadBytes: docSize(a, 1) });
});

test("system tables are not metered, read or written", async () => {
  const { functions, last } = await setup();
  await functions.runMutation("m:schedule", {});
  expect(last()).toMatchObject({ databaseWriteDocuments: 0, databaseWriteIndexRows: 0, databaseWriteBytes: 0 });
  await functions.runQuery("m:system", {});
  expect(last()).toMatchObject({ databaseReadDocuments: 0, databaseReadBytes: 0 });
});

test("a transaction's own write read back is metered; a failed mutation's reads count, its writes do not", async () => {
  const { functions, last } = await setup();
  const doc = (await functions.runMutation("m:readOwnWrite", {})) as { _id: string };
  expect(last()).toMatchObject({ databaseReadDocuments: 1, databaseReadBytes: docSize(doc._id, 5) });
  await expect(functions.runMutation("m:readThenFail", {})).rejects.toThrow("no");
  expect(last()).toMatchObject({
    databaseReadDocuments: 1,
    databaseReadBytes: docSize(doc._id, 5),
    databaseWriteDocuments: 0,
    databaseWriteBytes: 0,
  });
});

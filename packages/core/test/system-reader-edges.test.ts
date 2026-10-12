// `db.system` (system-reader.ts) at its edges: the refusals and the misses the server's tests reach but
// `core`'s did not. Mutation testing (TEST-01 §7) found these untested.
import { expect, test } from "bun:test";
import { encodeId, v } from "@bunvex/values";
import { FILE_STORAGE_TABLE, SCHEDULED_FUNCTIONS_TABLE, STORAGE_TABLE } from "../src/catalog.ts";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import { APP_VISIBLE_SYSTEM_TABLES } from "../src/system-reader.ts";

const schema = defineSchema({ items: defineTable(v.any()) });

async function withOneFile() {
  const e = await new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
  const id = await e.mutation((db) =>
    db.asSystem(() =>
      db.insert(FILE_STORAGE_TABLE, {
        storageId: "uuid-0",
        storageKey: "blob-0",
        sha256: new Uint8Array(32).buffer as ArrayBuffer,
        size: 5n,
        contentType: null,
      }),
    ),
  );
  return { e, id };
}

test("db.system.query of a user table is refused, by name", async () => {
  const { e } = await withOneFile();
  await expect(e.query(async (db) => db.system.query("items").collect())).rejects.toThrow(
    "System table items is not accessible here.",
  );
});

test("db.system.get of an id that does not decode is refused with db.get's message", async () => {
  const { e } = await withOneFile();
  const viaGet = await e.query((db) => db.get("not-an-id")).catch((err: Error) => err.message);
  expect(viaGet).toBe("Invalid argument `id` for `db.get`: Unable to decode ID: Invalid ID length 9");
  await expect(e.query((db) => db.system.get("not-an-id"))).rejects.toThrow(viaGet);
});

test("db.system.get of an id whose table number names no table reads nothing", async () => {
  const { e } = await withOneFile();
  const stray = encodeId(123_456, new Uint8Array(16).fill(7)); // not a table number in use (9_999 is _instance)
  expect(await e.query((db) => db.system.get(stray))).toBeNull();
});

test("db.system.table(name) reads that virtual table", async () => {
  const { e, id } = await withOneFile();
  const r = await e.query(async (db) => {
    const t = db.system.table(STORAGE_TABLE);
    return { got: await t.get(id), all: await t.query().collect() };
  });
  expect(r.got).toMatchObject({ _id: id, size: 5 });
  expect(r.all.map((d) => d._id)).toEqual([id]);
});

test("the system tables an app sees are the virtual ones", () => {
  expect([...APP_VISIBLE_SYSTEM_TABLES].sort()).toEqual([SCHEDULED_FUNCTIONS_TABLE, STORAGE_TABLE].sort());
});

import { describe, expect, test } from "bun:test";
import { encodeId, v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

async function engine() {
  const schema = defineSchema({ users: defineTable(v.any()), posts: defineTable(v.any()) });
  return new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
}

describe("one-argument forms and normalizeId, as Convex", () => {
  test("get / patch / replace / delete with only the id: the id names its table", async () => {
    const e = await engine();
    const id = await e.mutation((db) => db.insert("users", { name: "ada" }));
    expect(await e.query((db) => db.get(id))).toMatchObject({ name: "ada" });
    await e.mutation((db) => db.patch(id, { age: 3 }));
    expect(await e.query((db) => db.get(id))).toMatchObject({ name: "ada", age: 3 });
    await e.mutation((db) => db.replace(id, { name: "bob" }));
    expect(await e.query((db) => db.get(id))).toMatchObject({ name: "bob" });
    expect(await e.query((db) => db.get(id))).not.toHaveProperty("age");
    await e.mutation((db) => db.delete(id));
    expect(await e.query((db) => db.get(id))).toBeNull();
  });

  test("an id of an unknown table reads as null; a malformed one is an argument error", async () => {
    const e = await engine();
    expect(await e.query((db) => db.get(encodeId(10_999, new Uint8Array(16))))).toBeNull();
    await expect(e.query((db) => db.get("nope"))).rejects.toThrow(
      "Invalid argument `id` for `db.get`: Unable to decode ID",
    );
    await expect(e.query((db) => db.get(5 as never))).rejects.toThrow("expected string but got 'number'");
    await expect(e.mutation((db) => db.patch(encodeId(10_999, new Uint8Array(16)), {}))).rejects.toThrow(
      "Update on nonexistent document ID",
    );
  });

  test("normalizeId returns the id only for its own table", async () => {
    const e = await engine();
    const id = await e.mutation((db) => db.insert("users", {}));
    const r = await e.query(async (db) => ({
      own: db.normalizeId("users", id),
      other: db.normalizeId("posts", id),
      junk: db.normalizeId("users", "not-an-id"),
      missingTable: db.normalizeId("nope", id),
      system: db.normalizeId("_tables", id),
    }));
    expect(r).toEqual({ own: id, other: null, junk: null, missingTable: null, system: null });
  });
});

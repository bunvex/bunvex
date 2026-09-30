import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable, type SchemaDefinition } from "../src/schema.ts";

const schema = defineSchema({
  users: defineTable({ name: v.string(), age: v.optional(v.number()) }).index("by_name", ["name"]),
  posts: defineTable({ author: v.id("users"), body: v.string() }),
  events: defineTable(
    v.union(
      v.object({ kind: v.literal("click"), x: v.number() }),
      v.object({ kind: v.literal("key"), key: v.string() }),
    ),
  ),
  loose: defineTable(v.any()),
});
const engine = async (s: SchemaDefinition = schema) =>
  new Engine(s, await MemoryPersistence.open(null, { durable: false })).init();

describe("defineSchema / defineTable: documents are validated on write (STUDY-14)", () => {
  test("a matching document is written; system fields are part of the validator", async () => {
    const e = await engine();
    const id = await e.mutation((db) => db.insert("users", { name: "ada" }));
    await e.mutation((db) => db.patch("users", id, { age: 36 }));
    expect(await e.query((db) => db.get("users", id))).toMatchObject({ name: "ada", age: 36 });
  });

  test("a document that does not match is refused with Convex's message", async () => {
    const e = await engine();
    await expect(e.mutation((db) => db.insert("users", { age: 1 }))).rejects.toThrow(
      'Failed to insert or update a document in table "users" because it does not match the schema: Object is missing the required field `name`.',
    );
    await expect(e.mutation((db) => db.insert("users", { name: "a", nick: "b" }))).rejects.toThrow(
      "Object contains extra field `nick` that is not in the validator.",
    );
    const id = await e.mutation((db) => db.insert("users", { name: "ada" }));
    await expect(e.mutation((db) => db.patch("users", id, { age: "old" }))).rejects.toThrow(
      'Failed to insert or update a document in table "users" because it does not match the schema: Value does not match validator.\nPath: .age',
    );
    // Nothing of the refused mutations was written.
    expect(await e.query((db) => db.query("users").collect())).toHaveLength(1);
  });

  test("v.id fields must point at the right table", async () => {
    const e = await engine();
    const user = await e.mutation((db) => db.insert("users", { name: "ada" }));
    await e.mutation((db) => db.insert("posts", { author: user, body: "hi" }));
    const post = await e.mutation((db) => db.insert("posts", { author: user, body: "x" }));
    await expect(e.mutation((db) => db.insert("posts", { author: post, body: "x" }))).rejects.toThrow(
      'from table `posts`, which does not match the table name in validator `v.id("users")`',
    );
  });

  test("a union of objects accepts any member", async () => {
    const e = await engine();
    await e.mutation((db) => db.insert("events", { kind: "click", x: 1 }));
    await e.mutation((db) => db.insert("events", { kind: "key", key: "a" }));
    await expect(e.mutation((db) => db.insert("events", { kind: "key", x: 1 }))).rejects.toThrow(
      "does not match the schema",
    );
  });

  test("v.any() tables and schemaValidation: false accept anything", async () => {
    const e = await engine();
    await e.mutation((db) => db.insert("loose", { whatever: [1n, "x"] }));
    const off = await engine(defineSchema({ users: defineTable({ name: v.string() }) }, { schemaValidation: false }));
    await off.mutation((db) => db.insert("users", { name: 1, other: true }));
    expect(await off.query((db) => db.query("users").collect())).toHaveLength(1);
  });

  test("defineTable takes an object of validators, v.object, a union of objects or v.any", () => {
    expect(defineTable({ a: v.string() }).document.kind).toBe("object");
    expect(() => defineTable(v.string() as never)).toThrow("must be v.object(...), a v.union of objects, or v.any()");
    expect(() => defineTable(v.union(v.object({}), v.string()) as never)).toThrow("must be v.object");
    expect(() => defineSchema({ t: {} as never })).toThrow("must be defined with defineTable");
  });
});

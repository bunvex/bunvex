import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable, documentTypeError, type EngineSchema } from "../src/schema.ts";
import { schemaFromJson, schemaToJson } from "../src/schema-json.ts";

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
const engine = async (s: EngineSchema = schema) =>
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
    expect(() => defineSchema({ t: {} as never })).toThrow("must be defined with defineTable");
  });

  test("a validator a table cannot have: accepted when declared, refused at push, as Convex (STUDY-14 §6)", () => {
    const of = (d: unknown) => documentTypeError(defineSchema({ ok: defineTable({}), t: defineTable(d as never) }));
    // Convex's `defineTable` checks nothing: the declaration works.
    expect(defineTable(v.string() as never).document.kind).toBe("string");
    expect(of(v.object({ a: v.string() }))).toBeNull();
    expect(of(v.any())).toBeNull();
    expect(of(v.union(v.object({}), v.object({ k: v.string() })))).toBeNull();
    expect(of(v.string())).toBe(
      "The document validator in a schema must be an object, a union of objects, or `v.any()`. Found v.string().",
    );
    expect(of(v.union(v.object({}), v.array(v.string()), v.null()))).toBe(
      "The document validator in a schema must be an object, a union of objects, or `v.any()`. Found v.array(v.string()).",
    );
    // Convex's export check: a document validator whose JSON is not an object.
    const broken = { isValidator: true, kind: "object", json: "nope" };
    expect(() => schemaToJson(defineSchema({ t: defineTable(broken as never) }))).toThrow(
      new Error("Invalid validator: please make sure that the parameter of `defineTable` is valid"),
    );
  });
});

// STUDY-181 H-5: a table definition carries Convex's six index lists at run time, filled as Convex's `defineTable`
// fills them (libraries such as convex-helpers read `schema.tables[t].indexes`).
describe("a table definition's index lists, Convex's runtime shape", () => {
  const declare = () =>
    defineTable({ a: v.string(), b: v.number(), c: v.string(), e: v.array(v.float64()) })
      .index("by_a", ["a"])
      .index("by_b_staged", { fields: ["b"], staged: true })
      .index("by_ab", { fields: ["a", "b"] })
      .index("by_a", ["c"])
      .index("by_c_staged", { fields: ["c"], staged: true })
      .searchIndex("search_c", { searchField: "c" })
      .searchIndex("search_a", { searchField: "a", filterFields: ["b", "b"] })
      .searchIndex("search_staged", { searchField: "c", filterFields: ["a"], staged: true })
      .vectorIndex("vec", { vectorField: "e", dimensions: 3, filterFields: ["a"] })
      .vectorIndex("vec_bare", { vectorField: "e", dimensions: 4 })
      .vectorIndex("vec_staged", { vectorField: "e", dimensions: 5, staged: true });

  test("each list in declaration order, a staged index only in its staged list, a name declared twice listed twice", () => {
    const t = declare();
    expect(t.indexes).toEqual([
      { indexDescriptor: "by_a", fields: ["a"] },
      { indexDescriptor: "by_ab", fields: ["a", "b"] },
      { indexDescriptor: "by_a", fields: ["c"] },
    ]);
    expect(t.stagedDbIndexes).toEqual([
      { indexDescriptor: "by_b_staged", fields: ["b"] },
      { indexDescriptor: "by_c_staged", fields: ["c"] },
    ]);
    // `filterFields` as given (Convex keeps the repeat), `[]` when absent.
    expect(t.searchIndexes).toEqual([
      { indexDescriptor: "search_c", searchField: "c", filterFields: [] },
      { indexDescriptor: "search_a", searchField: "a", filterFields: ["b", "b"] },
    ]);
    expect(t.stagedSearchIndexes).toEqual([
      { indexDescriptor: "search_staged", searchField: "c", filterFields: ["a"] },
    ]);
    expect(t.vectorIndexes).toEqual([
      { indexDescriptor: "vec", vectorField: "e", dimensions: 3, filterFields: ["a"] },
      { indexDescriptor: "vec_bare", vectorField: "e", dimensions: 4, filterFields: [] },
    ]);
    expect(t.stagedVectorIndexes).toEqual([
      { indexDescriptor: "vec_staged", vectorField: "e", dimensions: 5, filterFields: [] },
    ]);
    // The experimental `" indexes"()` is the same array.
    expect(t[" indexes"]()).toBe(t.indexes);
    // bunvex's own name-keyed view is unchanged: the first declaration, the duplicate refused at push.
    expect(t.indexFields).toEqual({ by_a: ["a"], by_b_staged: ["b"], by_ab: ["a", "b"], by_c_staged: ["c"] });
    expect(t.duplicateIndexes).toEqual(["by_a"]);
    expect(t.stagedIndexes).toEqual(["by_b_staged", "by_c_staged"]);
    expect(() => defineSchema({ t })).toThrow('Table "t" has two or more definitions of index "by_a".');
  });

  test("a table read back from a pushed schema has the same lists", () => {
    const back = schemaFromJson(
      schemaToJson(
        defineSchema({
          t: defineTable({ a: v.string(), b: v.number(), e: v.array(v.float64()) })
            .index("by_a", ["a"])
            .index("by_b", { fields: ["b"], staged: true })
            .searchIndex("search_a", { searchField: "a", filterFields: ["b"] })
            .searchIndex("search_staged", { searchField: "a", staged: true })
            .vectorIndex("vec", { vectorField: "e", dimensions: 3 })
            .vectorIndex("vec_staged", { vectorField: "e", dimensions: 4, filterFields: ["a"], staged: true }),
        }),
      ),
    ).tables.t!;
    expect(back.indexes).toEqual([{ indexDescriptor: "by_a", fields: ["a"] }]);
    expect(back.stagedDbIndexes).toEqual([{ indexDescriptor: "by_b", fields: ["b"] }]);
    expect(back.searchIndexes).toEqual([{ indexDescriptor: "search_a", searchField: "a", filterFields: ["b"] }]);
    expect(back.stagedSearchIndexes).toEqual([
      { indexDescriptor: "search_staged", searchField: "a", filterFields: [] },
    ]);
    expect(back.vectorIndexes).toEqual([{ indexDescriptor: "vec", vectorField: "e", dimensions: 3, filterFields: [] }]);
    expect(back.stagedVectorIndexes).toEqual([
      { indexDescriptor: "vec_staged", vectorField: "e", dimensions: 4, filterFields: ["a"] },
    ]);
    expect(back.stagedSearch).toEqual(["search_staged"]);
    expect(back.stagedVector).toEqual(["vec_staged"]);
  });
});

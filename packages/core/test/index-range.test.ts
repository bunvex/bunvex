import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { type Doc, defineSchema, defineTable } from "../src/schema.ts";

async function engine() {
  const schema = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]).index("by_ab", ["a", "b"]) });
  return new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
}

describe("withIndex ranges follow Convex's rules", () => {
  test("documents with equal indexed values come back in creation order (implicit _creationTime)", async () => {
    const e = await engine();
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push(await e.mutation((db) => db.insert("items", { n: 1, i })));
    const got = await e.query((db) =>
      db
        .query("items")
        .withIndex("by_n", (q) => q.eq("n", 1))
        .collect(),
    );
    expect(got.map((d: Doc) => d._id)).toEqual(ids);
    const desc = await e.query((db) => db.query("items").withIndex("by_n").order("desc").collect());
    expect(desc.map((d: Doc) => d._id)).toEqual([...ids].reverse());
  });

  test("eq(field).gt('_creationTime', t) — the idiomatic time window — works", async () => {
    const e = await engine();
    const docs: Doc[] = [];
    for (let i = 0; i < 10; i++) {
      const id = await e.mutation((db) => db.insert("items", { n: i % 2 }));
      docs.push((await e.query((db) => db.get("items", id)))!);
    }
    const t = docs[4]._creationTime;
    const got = await e.query((db) =>
      db
        .query("items")
        .withIndex("by_n", (q) => q.eq("n", 0).gt("_creationTime", t))
        .collect(),
    );
    expect(got.map((d: Doc) => d._id)).toEqual(docs.filter((d) => d.n === 0 && d._creationTime > t).map((d) => d._id));
    const byTime = await e.query((db) =>
      db
        .query("items")
        .withIndex("by_creation_time", (q) => q.gte("_creationTime", t))
        .collect(),
    );
    expect(byTime).toHaveLength(6);
  });

  test("every field of the index, _id included, can be pinned", async () => {
    const e = await engine();
    const id = await e.mutation((db) => db.insert("items", { a: 1, b: "x" }));
    await e.mutation((db) => db.insert("items", { a: 1, b: "x" }));
    const d = (await e.query((db) => db.get("items", id)))!;
    const got = await e.query((db) =>
      db
        .query("items")
        .withIndex("by_ab", (q) => q.eq("a", 1).eq("b", "x").eq("_creationTime", d._creationTime).eq("_id", id))
        .collect(),
    );
    expect(got.map((x: Doc) => x._id)).toEqual([id]);
    const byId = await e.query((db) =>
      db
        .query("items")
        .withIndex("by_id", (q) => q.eq("_id", id))
        .collect(),
    );
    expect(byId.map((x: Doc) => x._id)).toEqual([id]);
  });

  const run = async (f: (q: any) => any, index = "by_ab") => {
    const e = await engine();
    return e.query((db) => db.query("items").withIndex(index, f).collect());
  };
  // A query's rejection, awaited here rather than inside `expect().rejects`: bun test runs the work of a promise
  // handed to `rejects` far slower (each committer drain waits ~150 ms), which pushed three engine starts past
  // the 5 s timeout. A query that resolves fails `toThrow`.
  const rejected = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    return () => {
      if (err) throw err;
    };
  };

  test("a field outside the index: FieldNotInIndex", async () => {
    expect(await rejected(run((q) => q.eq("wrong", 1), "by_n"))).toThrow(
      'The index range included a comparison with "wrong", but items.by_n with fields ["n", "_creationTime"] doesn\'t index this field.',
    );
  });

  test("fields not used as an index-order prefix: InvalidIndexRange", async () => {
    expect(await rejected(run((q) => q.eq("b", 1)))).toThrow(
      'Tried to query index items.by_ab but the query didn\'t use the index fields in order.\nIndex fields: ["a", "b", "_creationTime"]\nQuery fields: ["b"]\nFirst incorrect field: "b"',
    );
    expect(await rejected(run((q) => q.gt("a", 1).eq("b", 2)))).toThrow('First incorrect field: "b"');
    expect(await rejected(run((q) => q.eq("a", 1).gt("a", 0)))).toThrow("didn't use the index fields in order");
  });

  test("a second equality or bound of the same kind: AlreadyDefinedBound", async () => {
    expect(await rejected(run((q) => q.eq("a", 1).eq("a", 2)))).toThrow(
      'Already defined equality bound in index range. Can\'t add "a" == 2.',
    );
    expect(await rejected(run((q) => q.gt("a", 1).gte("a", 2)))).toThrow(
      'Already defined lower bound in index range. Can\'t add "a" >= 2.',
    );
    expect(await rejected(run((q) => q.lt("a", 1).lte("a", 2)))).toThrow("Already defined upper bound");
  });

  test("bounds on two fields: BoundsOnMultipleFields", async () => {
    expect(await rejected(run((q) => q.eq("a", 1).gt("b", 1).lt("_creationTime", 5)))).toThrow(
      'This query against index items.by_ab attempted to set a range bound on both "b" and "_creationTime".',
    );
  });

  test("equalities may come in any order; they are sorted by index position", async () => {
    const e = await engine();
    await e.mutation((db) => db.insert("items", { a: 1, b: 2 }));
    const got = await e.query((db) =>
      db
        .query("items")
        .withIndex("by_ab", (q) => q.eq("b", 2).eq("a", 1))
        .collect(),
    );
    expect(got).toHaveLength(1);
  });

  test("index definitions fail with Convex's codes' messages (STUDY-65 M1; Convex: tests/schema.rs, testing/schema.rs)", () => {
    const err = (t: Parameters<typeof defineSchema>[0][string], table = "t") => {
      try {
        defineSchema({ [table]: t });
      } catch (e) {
        return (e as Error).message;
      }
      return "no error";
    };
    const fields = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`);
    // IndexFieldsContainId, IndexFieldsContainCreationTime, IndexFieldNameReserved.
    expect(err(defineTable(v.any()).index("by_x", ["_id"]))).toBe(
      'In table "t": In index "by_x": `_id` is not a valid index field. To load documents by ID, use `db.get(id)`.',
    );
    expect(err(defineTable(v.any()).index("by_x", ["a", "_creationTime"]))).toBe(
      "`_creationTime` is automatically added to the end of each index. It should not be added explicitly in the index definition.",
    );
    expect(err(defineTable(v.any()).index("by_x", ["_secret"]))).toBe(
      "Reserved fields (starting with `_`) are not allowed in indexes.",
    );
    expect(err(defineTable(v.any()).index("by_x", ["a._secret"]))).toBe(
      "Reserved fields (starting with `_`) are not allowed in indexes.",
    );
    // FieldsNotUniqueWithinIndex: Convex's test checks the whole string.
    expect(err(defineTable(v.any()).index("by_email", ["email", "email"]), "test")).toBe(
      'In table "test": In index "by_email": Duplicate field "email". Index fields must be unique within an index.',
    );
    // IndexTooManyFields: more than 16 when parsed; and 16 too, once `_creationTime` is appended.
    expect(err(defineTable(v.any()).index("by_x", fields(17)))).toBe(
      'In table "t": In index "by_x": Indexes may have up to 16 fields.',
    );
    expect(err(defineTable(v.any()).index("by_x", fields(16)))).toBe("Indexes may have up to 16 fields.");
    expect(err(defineTable(v.any()).index("by_x", fields(15)))).toBe("no error");
    // EmptyIndex, IndexNotUnique, IndexNameReserved, IndexNamesNotUnique.
    expect(err(defineTable(v.any()).index("by_x", []))).toBe('In table "t" index "by_x" must have at least one field.');
    expect(err(defineTable(v.any()).index("by_x", { fields: [], staged: true }))).toBe(
      'In table "t" staged index "by_x" must have at least one field.',
    );
    expect(err(defineTable(v.any()).index("by_email", ["email"]).index("by_email2", ["email"]), "test")).toBe(
      'In table "test" index "by_email2" and index "by_email" have the same fields. Indexes must be unique within a table.',
    );
    expect(err(defineTable(v.any()).index("by_id", ["x"]))).toBe(
      'In table "t" cannot name an index "by_id" because the name is reserved. Indexes may not start with an underscore or be named "by_id" or "by_creation_time".',
    );
    expect(err(defineTable(v.any()).index("by_a", ["a"]).index("by_a", ["b"]))).toBe(
      'Table "t" has two or more definitions of index "by_a".',
    );
  });
});

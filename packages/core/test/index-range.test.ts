import { describe, expect, test } from "bun:test";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { type Doc, Schema } from "../src/schema.ts";

async function engine() {
  const schema = new Schema().table("items", { by_n: ["n"], by_ab: ["a", "b"] });
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

  test("a field outside the index: FieldNotInIndex", async () => {
    await expect(run((q) => q.eq("wrong", 1), "by_n")).rejects.toThrow(
      'The index range included a comparison with "wrong", but items.by_n with fields ["n", "_creationTime"] doesn\'t index this field.',
    );
  });

  test("fields not used as an index-order prefix: InvalidIndexRange", async () => {
    await expect(run((q) => q.eq("b", 1))).rejects.toThrow(
      'Tried to query index items.by_ab but the query didn\'t use the index fields in order.\nIndex fields: ["a", "b", "_creationTime"]\nQuery fields: ["b"]\nFirst incorrect field: "b"',
    );
    await expect(run((q) => q.gt("a", 1).eq("b", 2))).rejects.toThrow('First incorrect field: "b"');
    await expect(run((q) => q.eq("a", 1).gt("a", 0))).rejects.toThrow("didn't use the index fields in order");
  });

  test("a second equality or bound of the same kind: AlreadyDefinedBound", async () => {
    await expect(run((q) => q.eq("a", 1).eq("a", 2))).rejects.toThrow(
      'Already defined equality bound in index range. Can\'t add "a" == 2.',
    );
    await expect(run((q) => q.gt("a", 1).gte("a", 2))).rejects.toThrow(
      'Already defined lower bound in index range. Can\'t add "a" >= 2.',
    );
    await expect(run((q) => q.lt("a", 1).lte("a", 2))).rejects.toThrow("Already defined upper bound");
  });

  test("bounds on two fields: BoundsOnMultipleFields", async () => {
    await expect(run((q) => q.eq("a", 1).gt("b", 1).lt("_creationTime", 5))).rejects.toThrow(
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

  test("index fields follow Convex's rules", () => {
    expect(() => new Schema().table("t", { by_x: ["_creationTime"] })).toThrow("reserved field");
    expect(() => new Schema().table("t", { by_x: ["_id"] })).toThrow("reserved field");
    expect(() => new Schema().table("t", { by_x: ["a._secret"] })).toThrow("reserved field");
    expect(() => new Schema().table("t", { by_x: ["a", "a"] })).toThrow("duplicate fields");
    expect(() => new Schema().table("t", { by_x: Array.from({ length: 17 }, (_, i) => `f${i}`) })).toThrow("16");
  });
});

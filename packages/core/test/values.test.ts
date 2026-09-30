import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { type Doc, defineSchema, defineTable } from "../src/schema.ts";

async function engine() {
  const schema = defineSchema({ items: defineTable(v.any()).index("by_v", ["v"]).index("by_nested", ["meta.rank"]) });
  return new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
}

describe("Convex values in documents and indexes (STUDY-18)", () => {
  test("every value type round-trips through storage exactly", async () => {
    const e = await engine();
    const id = await e.mutation((db) =>
      db.insert("items", {
        big: 2n ** 62n,
        bytes: Uint8Array.from([0, 1, 255]).buffer,
        nan: Number.NaN,
        negZero: -0,
        inf: Number.NEGATIVE_INFINITY,
        nested: { list: [1, "two", null, false, { deep: 3n }] },
      }),
    );
    const d = (await e.query((db) => db.get("items", id))) as Doc;
    expect(d.big).toBe(2n ** 62n);
    expect([...new Uint8Array(d.bytes as ArrayBuffer)]).toEqual([0, 1, 255]);
    expect(Number.isNaN(d.nan)).toBe(true);
    expect(Object.is(d.negZero, -0)).toBe(true);
    expect(d.inf).toBe(Number.NEGATIVE_INFINITY);
    expect(d.nested).toEqual({ list: [1, "two", null, false, { deep: 3n }] });
    expect(Object.keys(d)).toEqual([...Object.keys(d)].sort()); // fields sorted, as Convex objects
  });

  test("unsupported values are refused at the call, with Convex's message", async () => {
    const e = await engine();
    await expect(e.mutation((db) => db.insert("items", { when: new Date(0) }))).rejects.toThrow(
      "is not a supported value type (present at path .when",
    );
    await expect(e.mutation((db) => db.insert("items", { $bad: 1 }))).rejects.toThrow("starts with a '$'");
  });

  test("a missing field is `undefined` in an index, below null, and eq(undefined) finds it", async () => {
    const e = await engine();
    const missing = await e.mutation((db) => db.insert("items", {}));
    const isNull = await e.mutation((db) => db.insert("items", { v: null }));
    const q = (v: unknown) =>
      e.query((db) =>
        db
          .query("items")
          .withIndex("by_v", (r) => r.eq("v", v as never))
          .collect(),
      );
    expect((await q(undefined)).map((d: Doc) => d._id)).toEqual([missing]);
    expect((await q(null)).map((d: Doc) => d._id)).toEqual([isNull]);
  });

  test("index order across types is Convex's", async () => {
    const e = await engine();
    const vs: unknown[] = [{ a: 1 }, [1], Uint8Array.from([1]).buffer, "a", true, false, 1.5, 7n, null, undefined];
    for (const v of vs) await e.mutation((db) => db.insert("items", v === undefined ? {} : { v }));
    const got = await e.query((db) => db.query("items").withIndex("by_v").collect());
    const kind = (d: Doc) => {
      const v = d.v;
      if (!("v" in d)) return "undefined";
      if (v === null) return "null";
      if (v instanceof ArrayBuffer) return "bytes";
      if (Array.isArray(v)) return "array";
      if (typeof v === "boolean") return String(v);
      return typeof v;
    };
    expect(got.map(kind)).toEqual([
      "undefined",
      "null",
      "bigint",
      "number",
      "false",
      "true",
      "string",
      "bytes",
      "array",
      "object",
    ]);
  });

  test("nested field paths can be indexed", async () => {
    const e = await engine();
    for (const rank of [3, 1, 2]) await e.mutation((db) => db.insert("items", { meta: { rank } }));
    const got = await e.query((db) => db.query("items").withIndex("by_nested").collect());
    expect(got.map((d: Doc) => (d.meta as { rank: number }).rank)).toEqual([1, 2, 3]);
  });

  test("patch with undefined removes a field; system fields follow Convex's rules", async () => {
    const e = await engine();
    const id = await e.mutation((db) => db.insert("items", { a: 1, b: 2 }));
    await e.mutation((db) => db.patch("items", id, { a: undefined, c: 3 }));
    const d = (await e.query((db) => db.get("items", id))) as Doc;
    expect("a" in d).toBe(false);
    expect(d).toMatchObject({ b: 2, c: 3 });
    // The same _id / _creationTime are accepted; different ones and other "_" fields are refused.
    await e.mutation((db) => db.patch("items", id, { _id: id, _creationTime: d._creationTime }));
    await expect(e.mutation((db) => db.patch("items", id, { _creationTime: 1 }))).rejects.toThrow(
      "doesn't match '_creationTime' field",
    );
    await expect(e.mutation((db) => db.insert("items", { _secret: 1 }))).rejects.toThrow(
      "Field '_secret' starts with an underscore, which is only allowed for system fields like '_id'",
    );
    await expect(e.mutation((db) => db.insert("items", { _id: "x" }))).rejects.toThrow("doesn't match '_id' field");
  });
});

// The schema as Convex's `DatabaseSchemaJson` (schema-json.ts), on its own: the order Convex's parse fixes,
// serde_json's float text, reading a stored schema back, and what Convex's schema equality compares. The push and
// `_schemas` tests check these through whole schemas whose names happen to be declared in order; mutation testing
// (TEST-01 §7) found the orders and the edge cases untested.
import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { defineSchema, defineTable } from "../src/schema.ts";
import {
  type SchemaJson,
  schemaFailureOf,
  schemaFromJson,
  schemaJsonText,
  schemaKey,
  schemaStateOf,
  schemaToJson,
  type TableJson,
} from "../src/schema-json.ts";

describe("schemaToJson: Convex's order, whatever the declaration's", () => {
  const s = defineSchema({
    zeta: defineTable({ b: v.string(), a: v.array(v.number()), c: v.string(), d: v.array(v.number()) })
      .index("by_z", ["b"])
      .index("by_a", ["a"])
      .index("by_staged", { fields: ["a", "b"], staged: true })
      .searchIndex("s_z", { searchField: "b", filterFields: ["z", "a", "z"] })
      .searchIndex("s_a", { searchField: "c" })
      .vectorIndex("v_z", { vectorField: "a", dimensions: 2, filterFields: ["y", "b"] })
      .vectorIndex("v_a", { vectorField: "d", dimensions: 3 }),
    alpha: defineTable(v.any()),
  });
  const j = schemaToJson(s);
  const zeta = j.tables[1]!;

  test("tables, indexes, search and vector indexes by name; staged ones apart; filter fields a sorted set", () => {
    expect(j.tables.map((t) => t.tableName)).toEqual(["alpha", "zeta"]);
    expect(zeta.indexes.map((i) => i.indexDescriptor)).toEqual(["by_a", "by_z"]);
    expect(zeta.stagedDbIndexes).toEqual([{ indexDescriptor: "by_staged", fields: ["a", "b", "_creationTime"] }]);
    expect(zeta.searchIndexes).toEqual([
      { indexDescriptor: "s_a", searchField: "c", filterFields: [] },
      { indexDescriptor: "s_z", searchField: "b", filterFields: ["a", "z"] },
    ]);
    expect(zeta.vectorIndexes).toEqual([
      { indexDescriptor: "v_a", vectorField: "d", dimensions: 3, dimension: null, filterFields: [] },
      { indexDescriptor: "v_z", vectorField: "a", dimensions: 2, dimension: null, filterFields: ["b", "y"] },
    ]);
    expect([zeta.stagedSearchIndexes, zeta.stagedVectorIndexes]).toEqual([[], []]);
  });

  test("a document union keeps a member that is not an object; its objects lose their system fields", () => {
    const u = schemaToJson(
      defineSchema({ t: defineTable(v.union(v.object({ a: v.string(), _x: v.string() }), v.null()) as never) }),
    );
    expect(u.tables[0]!.documentType).toEqual({
      type: "union",
      value: [{ type: "object", value: { a: { fieldType: { type: "string" }, optional: false } } }, { type: "null" }],
    });
  });

  test("an object validator's fields by name", () => {
    expect(Object.keys((zeta.documentType as { value: object }).value)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("schemaJsonText: serde_json's text", () => {
  test("a float literal is written as serde_json writes it", () => {
    const text = (n: number) => {
      const t = schemaJsonText(defineSchema({ t: defineTable({ x: v.literal(n) }) }));
      return /"value":([^}]*)}/.exec(t.slice(t.indexOf('"literal"')))![1];
    };
    // (-0 is not a number here: a literal's value is a Convex value's JSON, `{"$float":…}` for it.)
    expect([0, 1, 1.5, -2, 1e15, 1e16, 1.5e-7, 0.00001].map(text)).toEqual([
      "0.0",
      "1.0",
      "1.5",
      "-2.0",
      "1000000000000000.0",
      "1e16",
      "1.5e-7",
      "0.00001",
    ]);
  });

  test("everything else is JSON.stringify's text, in the JSON's own order", () => {
    const s = defineSchema({ t: defineTable({ k: v.literal("x"), n: v.optional(v.boolean()) }).index("by_k", ["k"]) });
    expect(schemaJsonText(s)).toBe(JSON.stringify(schemaToJson(s)));
  });
});

describe("a _schemas row's state", () => {
  test("its name, and a failed one's error and table; nothing for no row", () => {
    expect(schemaStateOf(null)).toBeUndefined();
    expect(schemaStateOf(undefined)).toBeUndefined();
    expect(schemaStateOf({})).toBeUndefined();
    expect(schemaStateOf({ state: { state: "active" } })).toBe("active");
    expect(schemaFailureOf(null)).toBeNull();
    expect(schemaFailureOf({})).toBeNull();
    expect(schemaFailureOf({ state: { state: "active" } })).toBeNull();
    expect(schemaFailureOf({ state: { state: "failed", error: "bad", table_name: "t" } })).toEqual({
      error: "bad",
      tableName: "t",
    });
    expect(schemaFailureOf({ state: { state: "failed", error: "bad" } })).toEqual({ error: "bad", tableName: null });
  });
});

describe("schemaFromJson: a stored schema read back", () => {
  const table = (t: Partial<TableJson>): SchemaJson => ({
    tables: [
      {
        tableName: "t",
        indexes: [],
        stagedDbIndexes: [],
        searchIndexes: [],
        stagedSearchIndexes: [],
        vectorIndexes: [],
        stagedVectorIndexes: [],
        documentType: { type: "any" },
        stagedDocumentType: null,
        ...t,
      },
    ],
    schemaValidation: true,
  });
  const back = (t: Partial<TableJson>) => schemaToJson(schemaFromJson(table(t))).tables[0]!;

  test("a null document type (a schema that had none) is v.any()", () => {
    expect(back({ documentType: null }).documentType).toEqual({ type: "any" });
  });

  test("only a trailing _creationTime is bunvex's implicit one; other fields are kept as they are", () => {
    const fields = (f: string[]) => back({ indexes: [{ indexDescriptor: "i", fields: f }] }).indexes[0]!.fields;
    expect(fields(["a", "_creationTime"])).toEqual(["a", "_creationTime"]);
    expect(fields(["a"])).toEqual(["a", "_creationTime"]);
    expect(fields(["_creationTime", "a"])).toEqual(["_creationTime", "a", "_creationTime"]);
  });

  test("search and vector indexes: absent lists are none; staged-only ones are kept, staged", () => {
    const none = back({
      searchIndexes: undefined as never,
      stagedSearchIndexes: undefined as never,
      vectorIndexes: undefined as never,
      stagedVectorIndexes: undefined as never,
      stagedDbIndexes: undefined as never,
    });
    expect([none.searchIndexes, none.vectorIndexes, none.stagedDbIndexes]).toEqual([[], [], []]);
    const staged = back({
      stagedSearchIndexes: [{ indexDescriptor: "s", searchField: "b", filterFields: [] }],
      stagedVectorIndexes: [{ indexDescriptor: "vv", vectorField: "a", dimensions: 2, filterFields: [] }],
    });
    expect(staged.searchIndexes).toEqual([]);
    expect(staged.stagedSearchIndexes.map((i) => i.indexDescriptor)).toEqual(["s"]);
    expect(staged.stagedVectorIndexes.map((i) => i.indexDescriptor)).toEqual(["vv"]);
    // One list absent, the other present, each way.
    const s = { indexDescriptor: "s", searchField: "b", filterFields: [] };
    const w = { indexDescriptor: "vv", vectorField: "a", dimensions: 2, filterFields: [] };
    const oneSide = back({
      searchIndexes: undefined as never,
      stagedSearchIndexes: [s],
      vectorIndexes: [w],
      stagedVectorIndexes: undefined as never,
    });
    expect([oneSide.searchIndexes, oneSide.stagedSearchIndexes.length]).toEqual([[], 1]);
    expect([oneSide.vectorIndexes.length, oneSide.stagedVectorIndexes]).toEqual([1, []]);
    const otherSide = back({
      searchIndexes: [s],
      stagedSearchIndexes: undefined as never,
      vectorIndexes: undefined as never,
      stagedVectorIndexes: [w],
    });
    expect([otherSide.searchIndexes.length, otherSide.stagedSearchIndexes]).toEqual([1, []]);
    expect([otherSide.vectorIndexes, otherSide.stagedVectorIndexes.length]).toEqual([[], 1]);
  });
});

describe("schemaKey: what Convex's schema equality compares", () => {
  const base = schemaToJson(
    defineSchema({
      a: defineTable({ x: v.array(v.number()), y: v.string(), w: v.string(), u: v.array(v.number()) })
        .index("i1", ["x"])
        .index("i2", ["y"])
        .searchIndex("s1", { searchField: "y" })
        .searchIndex("s2", { searchField: "w" })
        .vectorIndex("v1", { vectorField: "x", dimensions: 2 })
        .vectorIndex("v2", { vectorField: "u", dimensions: 2 }),
      b: defineTable(v.any()),
    }),
  );
  const reversed = (j: SchemaJson): SchemaJson =>
    JSON.parse(
      JSON.stringify(j, (_k, x) =>
        Array.isArray(x) && x.every((e) => e && typeof e === "object" && ("tableName" in e || "indexDescriptor" in e))
          ? [...x].reverse()
          : x && typeof x === "object" && !Array.isArray(x)
            ? Object.fromEntries(Object.entries(x).reverse())
            : x,
      ),
    );

  test("the same whatever the order of tables, of each kind of index, and of an object's keys", () => {
    const r = reversed(base);
    expect(r.tables[0]!.tableName).toBe("b"); // the reversal did reorder
    expect(schemaKey(r)).toBe(schemaKey(base));
  });

  test("different when a name, a field's order or the validation flag differs; absent lists are empty ones", () => {
    const k = schemaKey(base);
    const renamed = structuredClone(base);
    renamed.tables[0]!.indexes[0]!.indexDescriptor = "i0";
    expect(schemaKey(renamed)).not.toBe(k);
    const swapped = structuredClone(base);
    swapped.tables[0]!.indexes[0]!.fields.reverse();
    expect(schemaKey(swapped)).not.toBe(k);
    expect(schemaKey({ ...base, schemaValidation: false })).not.toBe(k);
    const empty: SchemaJson = {
      tables: [{ ...base.tables[1]!, stagedDbIndexes: undefined as never }],
      schemaValidation: true,
    };
    expect(schemaKey(empty)).toBe(schemaKey({ tables: [base.tables[1]!], schemaValidation: true }));
  });
});

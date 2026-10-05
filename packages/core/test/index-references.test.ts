// Convex's `check_index_references` (STUDY-100): with schema validation, an index must name fields the
// table's validator can hold, and a vector index a field that can hold an array of float64. Convex's order
// and messages.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { defineSchema, defineTable, indexReferenceError } from "../src/index.ts";

const missing = (table: string, index: string, field: string) =>
  `In table "${table}" the index "${index}" is invalid because it references the field "${field}" that does not exist.`;

test("a database index on a field the validator does not have", () => {
  const s = defineSchema({ t: defineTable({ a: v.string() }).index("by_b", ["b"]) });
  expect(indexReferenceError(s)).toBe(missing("t", "by_b", "b"));
  expect(indexReferenceError(defineSchema({ t: defineTable({ a: v.string() }).index("by_a", ["a"]) }))).toBeNull();
});

test("without schema validation, or with v.any(), nothing is checked", () => {
  const t = defineTable({ a: v.string() }).index("by_b", ["b"]);
  expect(indexReferenceError(defineSchema({ t }, { schemaValidation: false }))).toBeNull();
  expect(indexReferenceError(defineSchema({ t: defineTable(v.any()).index("by_b", ["b"]) }))).toBeNull();
});

test("nested paths: objects, optional fields, unions and any pass; records, arrays and scalars do not", () => {
  const ok = (doc: unknown, field: string) =>
    indexReferenceError(defineSchema({ t: defineTable(doc as never).index("i", [field]) }));
  expect(ok({ a: v.object({ b: v.string() }) }, "a.b")).toBeNull();
  expect(ok({ a: v.optional(v.object({ b: v.string() })) }, "a.b")).toBeNull();
  expect(ok({ a: v.union(v.string(), v.object({ b: v.number() })) }, "a.b")).toBeNull();
  expect(ok({ a: v.any() }, "a.b.c")).toBeNull();
  expect(ok(v.union(v.object({ x: v.string() }), v.object({ y: v.string() })), "y")).toBeNull();
  expect(ok({ a: v.object({ b: v.string() }) }, "a.c")).toBe(missing("t", "i", "a.c"));
  expect(ok({ a: v.record(v.string(), v.string()) }, "a.b")).toBe(missing("t", "i", "a.b"));
  expect(ok({ a: v.array(v.object({ b: v.string() })) }, "a.b")).toBe(missing("t", "i", "a.b"));
  expect(ok({ a: v.string() }, "a.b")).toBe(missing("t", "i", "a.b"));
});

test("search and vector indexes: the search field, filter fields and vector field", () => {
  const base = { body: v.string(), kind: v.string(), v: v.array(v.float64()) };
  const search = (searchField: string, filterFields: string[]) =>
    indexReferenceError(defineSchema({ t: defineTable(base).searchIndex("s", { searchField, filterFields }) }));
  expect(search("body", ["kind"])).toBeNull();
  expect(search("nope", [])).toBe(missing("t", "s", "nope"));
  expect(search("body", ["nope"])).toBe(missing("t", "s", "nope"));
  const vector = (vectorField: string) =>
    indexReferenceError(defineSchema({ t: defineTable(base).vectorIndex("vi", { vectorField, dimensions: 2 }) }));
  expect(vector("v")).toBeNull();
  expect(vector("nope")).toBe(missing("t", "vi", "nope"));
});

test("a vector field that cannot hold an array of float64", () => {
  const vector = (field: Parameters<typeof v.optional>[0] | ReturnType<typeof v.optional>) =>
    indexReferenceError(
      defineSchema({ t: defineTable({ e: field as never }).vectorIndex("vi", { vectorField: "e", dimensions: 2 }) }),
    );
  for (const ok of [
    v.array(v.float64()),
    v.optional(v.array(v.float64())),
    v.array(v.any()),
    v.any(),
    v.union(v.string(), v.array(v.float64())),
  ])
    expect(vector(ok)).toBeNull();
  for (const bad of [v.array(v.string()), v.string(), v.array(v.int64())])
    expect(vector(bad)).toBe(
      `In table "t" the vector index "vi" is invalid because it references the field "e" that is neither an array of float64 or optional array of float64.`,
    );
});

test("a union branch that does not declare the vector field counts as able to hold it (Convex's rule)", () => {
  const doc = v.union(v.object({ a: v.string() }), v.object({ e: v.string() }));
  expect(
    indexReferenceError(defineSchema({ t: defineTable(doc).vectorIndex("vi", { vectorField: "e", dimensions: 2 }) })),
  ).toBeNull();
});

test("Convex's order: tables by name; database, staged, search, filter, vector fields; then vector types", () => {
  const s = defineSchema({
    zeta: defineTable({ a: v.string() }).index("by_x", ["x"]),
    alpha: defineTable({ a: v.string(), e: v.string() })
      .vectorIndex("v1", { vectorField: "e", dimensions: 2 })
      .searchIndex("s1", { searchField: "missing_search" })
      .index("by_a", { fields: ["missing_staged"], staged: true })
      .index("by_b", ["missing_db"]),
  });
  expect(indexReferenceError(s)).toBe(missing("alpha", "by_b", "missing_db"));
  const noDb = defineSchema({
    alpha: defineTable({ a: v.string(), e: v.string() })
      .vectorIndex("v1", { vectorField: "e", dimensions: 2 })
      .searchIndex("s1", { searchField: "a", filterFields: ["missing_filter"] }),
  });
  expect(indexReferenceError(noDb)).toBe(missing("alpha", "s1", "missing_filter"));
});

test("a single system field passes whatever the validator", () => {
  expect(
    indexReferenceError(
      defineSchema({ t: defineTable({ a: v.string() }).searchIndex("s", { searchField: "a", filterFields: ["_id"] }) }),
    ),
  ).toBeNull();
});

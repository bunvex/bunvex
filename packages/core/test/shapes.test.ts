// Table shapes (STUDY-52), as Convex's shape_inference: shapes of values, unions kept disjoint and short,
// contraction in Convex's order, counts, and the dashboard's reduced form.
import { expect, test } from "bun:test";
import { encodeId } from "@bunvex/values";
import { isIdentifier, isSubtype, reduceShape, type Shape, shapeOf, tableShape } from "../src/shapes.ts";

const names = (n: number) => (n === 10001 ? "users" : undefined);
const reduce = (docs: unknown[]) => reduceShape(tableShape(docs as never), names);
const kind = (s: Shape) => s.v.kind;

test("the shape of each kind of value", () => {
  expect(kind(shapeOf(null))).toBe("Null");
  expect(kind(shapeOf(1n))).toBe("Int64");
  expect([1.5, Number.NaN, Infinity, -Infinity, -0].map((x) => kind(shapeOf(x)))).toEqual([
    "NormalFloat64",
    "NaN",
    "PositiveInf",
    "NegativeInf",
    "NegativeZero",
  ]);
  expect(shapeOf("abc").v).toEqual({ kind: "StringLiteral", literal: "abc" });
  expect(kind(shapeOf("a b"))).toBe("FieldName");
  expect(kind(shapeOf("$x"))).toBe("String");
  expect(kind(shapeOf(new ArrayBuffer(1)))).toBe("Bytes");
  expect(kind(shapeOf({ "not an identifier": 1 }))).toBe("Record");
  const wide = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`f${i}`, 1n]));
  expect(kind(shapeOf(wide))).toBe("Record");
  expect(kind(shapeOf(Object.fromEntries(Object.entries(wide).slice(0, 64))))).toBe("Object");
});

test("objects that differ in a required field stay apart; the dashboard merges them, the field optional", () => {
  const s = tableShape([{ a: 1n }, { a: 2n, b: "x" }] as never);
  expect(s.v.kind).toBe("Union");
  expect(s.n).toBe(2);
  expect(reduce([{ a: 1n }, { a: 2n, b: "x" }])).toEqual({
    type: "Object",
    fields: [
      { fieldName: "a", optional: false, shape: { type: "Int64" } },
      { fieldName: "b", optional: true, shape: { type: "String" } },
    ],
  });
});

test("unions stay at most 16 long: string literals contract to a field name, then a string", () => {
  const few = tableShape(["a", "b", "c"] as never);
  expect(few.v.kind).toBe("Union");
  const many = tableShape(Array.from({ length: 17 }, (_, i) => `v${i}`) as never);
  expect(many).toEqual({ n: 17, v: { kind: "FieldName" } });
  expect(reduceShape(many, names)).toEqual({ type: "String" });
  expect(tableShape(["$a", "b"] as never)).toEqual({ n: 2, v: { kind: "String" } }); // the literal is a string
});

test("floats join as Float64 with special values; ints and floats stay apart; arrays merge their elements", () => {
  expect(reduce([1.5, Number.NaN])).toEqual({ type: "Float64", float64Range: { hasSpecialValues: true } });
  expect(reduce([1.5, 2.5])).toEqual({ type: "Float64", float64Range: { hasSpecialValues: false } });
  expect(reduce([1n, 1.5])).toEqual({
    type: "Union",
    shapes: [{ type: "Int64" }, { type: "Float64", float64Range: { hasSpecialValues: false } }],
  });
  const arrays = tableShape([[1n], ["x"]] as never);
  expect(arrays.v.kind).toBe("Array");
  expect(reduceShape(arrays, names)).toEqual({
    type: "Array",
    shape: { type: "Union", shapes: [{ type: "Int64" }, { type: "String" }] },
  });
  expect(reduce([[]])).toEqual({ type: "Array", shape: { type: "Never" } });
});

test("ids of a known table are Id; an empty table is Never; records mark literal keys optional", () => {
  const id = encodeId(10001, new Uint8Array(16).fill(7));
  expect(reduce([{ owner: id }])).toEqual({
    type: "Object",
    fields: [{ fieldName: "owner", optional: false, shape: { type: "Id", tableName: "users" } }],
  });
  expect(reduce([])).toEqual({ type: "Never" });
  expect(reduce([{ "a b": 1n }])).toEqual({
    type: "Record",
    keyShape: { type: "String" },
    valueShape: { optional: false, shape: { type: "Int64" } },
  });
});

test("an id is a literal first, as Convex's; literals of one table become Id past the union's limit (STUDY-133 §12 M4)", () => {
  const ids: string[] = [];
  for (let i = 0; ids.length < 17; i++) {
    const id = encodeId(10001, new Uint8Array(16).fill(i));
    if (isIdentifier(id)) ids.push(id);
  }
  expect(shapeOf(ids[0]!).v).toEqual({ kind: "StringLiteral", literal: ids[0] });
  const two = tableShape(ids.slice(0, 2));
  expect(two.v.kind === "Union" && two.v.variants.map(kind)).toEqual(["StringLiteral", "StringLiteral"]);
  expect(tableShape(ids)).toEqual({ n: 17, v: { kind: "Id", table: 10001 } });
  // The dashboard reads them as the table's id either way.
  expect(reduce(ids.slice(0, 2))).toEqual({ type: "Id", tableName: "users" });
});

test("subtyping: literals in field names in strings; objects with optional fields", () => {
  expect(isSubtype(shapeOf("abc"), { n: 0, v: { kind: "String" } })).toBe(true);
  expect(isSubtype(shapeOf(1n), { n: 0, v: { kind: "Float64" } })).toBe(false);
  const merged = tableShape(
    Array.from({ length: 20 }, (_, i) => (i % 2 ? { a: 1n } : { a: 1n, [`f${i}`]: 1n })) as never,
  );
  expect(merged.n).toBe(20);
});

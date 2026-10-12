// The Data screen's mappings (STUDY-149 PR 2), where no live server is needed: the contract's filter
// expression in Convex's form, an index's listing, and a table's shape as a document type.
import { describe, expect, test } from "bun:test";
import { indexInfoOf, toServerFilter, UNDEFINED_PLACEHOLDER, validatorOfShape } from "../src/tables.ts";

describe("toServerFilter", () => {
  test("clauses keep their ids, order and enablement; int64 is Convex's bigint type", () => {
    const { json, origins, matchesNothing } = toServerFilter({
      clauses: [
        { id: "a", field: "k", op: "eq", value: 1, enabled: true },
        { id: "b", field: "k", op: "type", value: "int64", enabled: false },
        { id: "c", field: "k", op: "anyOf", value: ["x"], enabled: true },
      ],
      order: "desc",
    });
    expect(json).toEqual({
      clauses: [
        { id: "a", field: "k", op: "eq", value: 1, enabled: true },
        { id: "b", field: "k", op: "type", value: "bigint", enabled: false },
        { id: "c", field: "k", op: "anyOf", value: ["x"], enabled: true },
      ],
      order: "desc",
    });
    expect(origins).toEqual(["a", "b", "c"]);
    expect(matchesNothing).toBe(false);
  });

  test("lt and lte also require the field to be set; the added clause answers for its own", () => {
    const { json, origins } = toServerFilter({
      clauses: [
        { id: "a", field: "k", op: "lt", value: 3, enabled: true },
        { id: "b", field: "n", op: "lte", value: 1, enabled: false },
        { id: "c", field: "n", op: "gt", value: 1, enabled: true },
      ],
      order: "asc",
    });
    expect(json.clauses).toEqual([
      { id: "a", field: "k", op: "lt", value: 3, enabled: true },
      { id: "a:set", field: "k", op: "neq", value: UNDEFINED_PLACEHOLDER, enabled: true },
      { id: "b", field: "n", op: "lte", value: 1, enabled: false },
      { id: "b:set", field: "n", op: "neq", value: UNDEFINED_PLACEHOLDER, enabled: false },
      { id: "c", field: "n", op: "gt", value: 1, enabled: true },
    ]);
    expect(origins).toEqual(["a", "a", "b", "b", "c"]);
  });

  test("an enabled anyOf of nothing matches nothing; a disabled one is ignored", () => {
    const empty = (enabled: boolean) =>
      toServerFilter({ clauses: [{ id: "a", field: "k", op: "anyOf", value: [], enabled }], order: "asc" });
    expect(empty(true).matchesNothing).toBe(true);
    expect(empty(false).matchesNothing).toBe(false);
  });

  test("an index: its enabled equalities, then the range as one clause", () => {
    const { json } = toServerFilter({
      index: {
        name: "by_k_n",
        eq: [
          { value: 1, enabled: true },
          { value: 2, enabled: false },
        ],
        range: { lower: { op: "gt", value: 0 }, upper: { op: "lte", value: 9 } },
      },
      clauses: [],
      order: "asc",
    });
    expect(json.index).toEqual({
      name: "by_k_n",
      clauses: [
        { type: "indexEq", enabled: true, value: 1 },
        { type: "indexRange", enabled: true, lowerOp: "gt", lowerValue: 0, upperOp: "lte", upperValue: 9 },
      ],
    });
    const lowerOnly = toServerFilter({
      index: { name: "by_k", eq: [], range: { lower: { op: "gte", value: 0 } } },
      clauses: [],
      order: "desc",
    }).json.index;
    expect(lowerOnly).toEqual({
      name: "by_k",
      clauses: [{ type: "indexRange", enabled: true, lowerOp: "gte", lowerValue: 0 }],
    });
  });
});

describe("indexInfoOf", () => {
  const ix = (o: object) => ({
    name: "by_k",
    staged: false,
    fields: ["k", "_creationTime"],
    backfill: { state: "done" },
    ...o,
  });
  test("a ready index: its declared fields, without the implied _creationTime", () => {
    expect(indexInfoOf(ix({}) as never)).toEqual({ name: "by_k", fields: ["k"], system: false, state: "ready" });
  });
  test("a backfilling one with its progress; a backfilled one not yet ready", () => {
    expect(
      indexInfoOf(ix({ backfill: { state: "backfilling", stats: { numDocsIndexed: 3, totalDocs: 9 } } }) as never),
    ).toEqual({ name: "by_k", fields: ["k"], system: false, state: "backfilling", progress: { indexed: 3, total: 9 } });
    expect(
      indexInfoOf(ix({ backfill: { state: "backfilling", stats: { numDocsIndexed: 3, totalDocs: null } } }) as never)
        ?.progress,
    ).toEqual({ indexed: 3 });
    expect(indexInfoOf(ix({ backfill: { state: "backfilled" } }) as never)?.state).toBe("backfilling");
  });
  test("staged, search and vector indexes are not listed", () => {
    expect(indexInfoOf(ix({ staged: true }) as never)).toBeNull();
    expect(indexInfoOf(ix({ fields: { searchField: "s", filterFields: [] } }) as never)).toBeNull();
  });
});

describe("validatorOfShape", () => {
  test("an object without its system fields, optional fields kept", () => {
    expect(
      validatorOfShape({
        type: "Object",
        fields: [
          { fieldName: "_creationTime", optional: false, shape: { type: "Float64" } },
          { fieldName: "_id", optional: false, shape: { type: "Id", tableName: "t" } },
          { fieldName: "big", optional: true, shape: { type: "Int64" } },
          { fieldName: "list", optional: false, shape: { type: "Array", shape: { type: "Never" } } },
          {
            fieldName: "nested",
            optional: false,
            shape: { type: "Object", fields: [{ fieldName: "_x", optional: false, shape: { type: "Null" } }] },
          },
          { fieldName: "ref", optional: false, shape: { type: "Id", tableName: "t" } },
        ],
      }),
    ).toEqual({
      type: "object",
      value: {
        big: { fieldType: { type: "bigint" }, optional: true },
        list: { fieldType: { type: "array", value: { type: "any" } }, optional: false },
        nested: {
          fieldType: { type: "object", value: { _x: { fieldType: { type: "null" }, optional: false } } },
          optional: false,
        },
        ref: { fieldType: { type: "id", tableName: "t" }, optional: false },
      },
    });
  });
  test("an empty table is null; unknown is any; unions and records", () => {
    expect(validatorOfShape({ type: "Never" })).toBeNull();
    expect(validatorOfShape({ type: "Unknown" })).toEqual({ type: "any" });
    expect(
      validatorOfShape({
        type: "Record",
        keyShape: { type: "String" },
        valueShape: { optional: false, shape: { type: "Union", shapes: [{ type: "Boolean" }, { type: "Bytes" }] } },
      }),
    ).toEqual({
      type: "record",
      keys: { type: "string" },
      values: { fieldType: { type: "union", value: [{ type: "boolean" }, { type: "bytes" }] }, optional: false },
    });
  });
});

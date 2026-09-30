// The filter semantics, pinned by hand-written expectations. The contract suite uses these functions as
// its oracle, so they must be right on their own — not merely agree with the mock that also uses them.
import { describe, expect, test } from "bun:test";
import { DataSourceError, type Document, type FilterExpression, type IndexInfo } from "@bunvex/dashboard";
import {
  canonicalFilter,
  compareValues,
  decodeInt64,
  encodeInt64,
  fieldValue,
  matchesClause,
  matchesFilter,
  validateFilter,
  valueType,
} from "../src/filters.ts";

const doc = (fields: Record<string, unknown>): Document => ({ _id: "id1", _creationTime: 1000, ...fields }) as Document;
const ready = (name: string, ...fields: string[]): IndexInfo => ({ name, fields, system: false, state: "ready" });
const INDEXES: IndexInfo[] = [
  { name: "by_id", fields: ["_id"], system: true, state: "ready" },
  { name: "by_creation_time", fields: ["_creationTime"], system: true, state: "ready" },
  ready("by_done_priority", "done", "priority"),
  { ...ready("by_text", "text"), state: "backfilling" },
];

describe("values", () => {
  test("types, including the encodings and unset", () => {
    expect(
      [undefined, null, true, 1.5, "s", encodeInt64(3n), { $bytes: "AA==" }, [], { a: 1 }].map((v) =>
        valueType(v as never),
      ),
    ).toEqual(["unset", "null", "boolean", "number", "string", "int64", "bytes", "array", "object"]);
  });

  test("int64 round-trips through its encoding, sign included", () => {
    for (const n of [0n, 1n, -1n, 2n ** 63n - 1n, -(2n ** 63n), 10_000_000_000n])
      expect(decodeInt64(encodeInt64(n))).toBe(n);
  });

  test("the order across types is Convex's", () => {
    const ordered = [
      undefined,
      null,
      encodeInt64(-5n),
      encodeInt64(7n),
      -1,
      0.5,
      false,
      true,
      "a",
      "b",
      { $bytes: "AQ==" },
      [1],
      [1, 2],
      { a: 1 },
    ];
    for (let i = 0; i < ordered.length - 1; i++)
      expect([i, compareValues(ordered[i] as never, ordered[i + 1] as never)]).toEqual([i, -1]);
    expect(compareValues({ b: 1, a: 2 }, { a: 2, b: 1 })).toBe(0);
  });

  test("dotted fields reach into objects, not into encodings", () => {
    const d = doc({ meta: { edited: true }, big: encodeInt64(1n) });
    expect(fieldValue(d, "meta.edited")).toBe(true);
    expect(fieldValue(d, "meta.missing")).toBeUndefined();
    expect(fieldValue(d, "big.$integer")).toBeUndefined();
  });
});

describe("clauses", () => {
  const c = (op: string, value?: unknown) => ({ id: "c", field: "n", op, value, enabled: true }) as never;
  const has = doc({ n: 5 });
  const unset = doc({});
  test("comparisons never match an unset field; neq and noneOf do", () => {
    expect([matchesClause(has, c("eq", 5)), matchesClause(has, c("eq", 6)), matchesClause(unset, c("eq", 5))]).toEqual([
      true,
      false,
      false,
    ]);
    expect([matchesClause(has, c("neq", 5)), matchesClause(unset, c("neq", 5))]).toEqual([false, true]);
    expect([
      matchesClause(has, c("gt", 4)),
      matchesClause(has, c("gte", 5)),
      matchesClause(has, c("lt", 5)),
      matchesClause(has, c("lte", 5)),
    ]).toEqual([true, true, false, true]);
    expect([matchesClause(unset, c("lt", 100)), matchesClause(unset, c("gt", -100))]).toEqual([false, false]);
    expect([
      matchesClause(has, c("anyOf", [1, 5])),
      matchesClause(has, c("noneOf", [5])),
      matchesClause(unset, c("noneOf", [5])),
    ]).toEqual([true, false, true]);
  });

  test("a comparison across types follows the type order", () => {
    // every string sorts after every number
    expect(matchesClause(doc({ n: "x" }), c("gt", 1_000_000))).toBe(true);
  });

  test("type and notype, unset included", () => {
    expect([
      matchesClause(has, c("type", "number")),
      matchesClause(unset, c("type", "unset")),
      matchesClause(unset, c("notype", "unset")),
    ]).toEqual([true, true, false]);
  });
});

describe("expressions", () => {
  const e = (x: Partial<FilterExpression>): FilterExpression => ({ clauses: [], order: "asc", ...x });

  test("an index prefix, then a range on the next field", () => {
    const ix = INDEXES[2]!;
    const expr = e({
      index: {
        name: "by_done_priority",
        eq: [{ value: false, enabled: true }],
        range: { lower: { op: "gte", value: 2 }, upper: { op: "lt", value: 4 } },
      },
    });
    const at = (done: boolean, priority: number) => matchesFilter(doc({ done, priority }), expr, ix);
    expect([at(false, 1), at(false, 2), at(false, 3), at(false, 4), at(true, 3)]).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);
  });

  test("disabled clauses are ignored, enabled ones all apply", () => {
    const ix = INDEXES[1]!;
    const expr = e({
      clauses: [
        { id: "a", field: "n", op: "eq", value: 1, enabled: false },
        { id: "b", field: "n", op: "gt", value: 2, enabled: true },
      ],
    });
    expect([matchesFilter(doc({ n: 1 }), expr, ix), matchesFilter(doc({ n: 3 }), expr, ix)]).toEqual([false, true]);
  });

  const reject = (expr: FilterExpression, clause: string) => {
    try {
      validateFilter(expr, INDEXES);
    } catch (err) {
      expect(err).toBeInstanceOf(DataSourceError);
      expect([(err as DataSourceError).code, (err as DataSourceError).details.clause]).toEqual([
        "invalid_request",
        clause,
      ]);
      return;
    }
    throw new Error(`accepted: ${JSON.stringify(expr)}`);
  };

  test("validation: the index rules", () => {
    expect(validateFilter(e({}), INDEXES).name).toBe("by_creation_time");
    reject(e({ index: { name: "nope", eq: [] } }), "index");
    reject(e({ index: { name: "by_text", eq: [] } }), "index"); // still backfilling
    reject(
      e({ index: { name: "by_done_priority", eq: [1, 2, 3].map((value) => ({ value, enabled: true })) } }),
      "index",
    );
    reject(
      e({
        index: {
          name: "by_done_priority",
          eq: [
            { value: true, enabled: false },
            { value: 1, enabled: true },
          ],
        },
      }),
      "index",
    );
    reject(
      e({
        index: {
          name: "by_done_priority",
          eq: [true, 1].map((value) => ({ value, enabled: true })),
          range: { lower: { op: "gt", value: 0 } },
        },
      }),
      "index",
    ); // no field left for the range
    reject(
      e({ index: { name: "by_creation_time", eq: [], range: { lower: { op: "lt" as never, value: 0 } } } }),
      "index",
    );
    reject({ clauses: [], order: "sideways" as never }, "order");
  });

  test("validation: the clauses, each named by its id", () => {
    reject(e({ clauses: [{ id: "a", field: "", op: "eq", value: 1, enabled: true }] }), "a");
    reject(e({ clauses: [{ id: "b", field: "n", op: "near" as never, value: 1, enabled: true }] }), "b");
    reject(e({ clauses: [{ id: "c", field: "n", op: "anyOf", value: 1, enabled: true }] }), "c");
    reject(e({ clauses: [{ id: "d", field: "n", op: "type", value: "colour" as never, enabled: true }] }), "d");
    reject(e({ clauses: [{ id: "f", field: "n", op: "eq", enabled: true }] }), "f");
    reject(
      e({
        clauses: [
          { id: "g", field: "n", op: "eq", value: 1, enabled: true },
          { id: "g", field: "m", op: "eq", value: 1, enabled: true },
        ],
      }),
      "g",
    );
    // a disabled clause may be incomplete: it is being edited
    expect(() =>
      validateFilter(e({ clauses: [{ id: "h", field: "", op: "eq", enabled: false }] }), INDEXES),
    ).not.toThrow();
  });

  test("a cursor's query ignores disabled clauses and clause ids", () => {
    const a = e({ clauses: [{ id: "a", field: "n", op: "eq", value: 1, enabled: true }] });
    const b = e({
      clauses: [
        { id: "zz", field: "n", op: "eq", value: 1, enabled: true },
        { id: "off", field: "m", op: "eq", value: 2, enabled: false },
      ],
    });
    expect(canonicalFilter("t", a)).toBe(canonicalFilter("t", b));
    expect(canonicalFilter("t", a)).not.toBe(canonicalFilter("t", { ...a, order: "desc" }));
    expect(canonicalFilter("t", undefined)).toBe(canonicalFilter("t", { clauses: [], order: "desc" }));
  });
});

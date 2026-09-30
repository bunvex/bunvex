import { describe, expect, test } from "bun:test";
import type { FilterExpression } from "@bunvex/dashboard";
import { decodeFilter, encodeFilter, isEmptyFilter } from "../src/database/filter-url.ts";
import { formatValueInput, parseValueInput } from "../src/database/value-input.ts";
import { encodeInt64 } from "../src/filters.ts";

const EXPR: FilterExpression = {
  index: {
    name: "by_done_priority",
    eq: [{ value: false, enabled: true }],
    range: { lower: { op: "gte", value: 2 }, upper: { op: "lt", value: 4 } },
  },
  clauses: [
    { id: "a", field: "text", op: "eq", value: "Ship é ✓ /+=", enabled: true },
    { id: "b", field: "owner", op: "type", value: "unset", enabled: false },
    { id: "c", field: "credits", op: "gt", value: encodeInt64(10n), enabled: true },
  ],
  order: "asc",
};

describe("filter in the URL", () => {
  test("round-trips, in URL-safe characters", () => {
    const param = encodeFilter(EXPR);
    expect(param).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeFilter(param)).toEqual(EXPR);
  });

  test("anything that is not an expression is ignored, not an error", () => {
    const bad = [
      undefined,
      "",
      "%%%",
      encodeFilter({ ...EXPR, order: "sideways" as never }),
      encodeFilter({ ...EXPR, clauses: [{ ...EXPR.clauses[0]!, op: "near" as never }] }),
      encodeFilter({ ...EXPR, clauses: [{ ...EXPR.clauses[1]!, value: "colour" as never }] }),
      encodeFilter({ ...EXPR, index: { name: "x", eq: [], range: { lower: { op: "lt" as never, value: 1 } } } }),
      btoa("[1,2]"),
    ];
    for (const p of bad) expect(decodeFilter(p)).toBeNull();
  });

  test("the default expression stays out of the URL", () => {
    expect(isEmptyFilter({ clauses: [], order: "desc" })).toBe(true);
    expect(isEmptyFilter({ index: { name: "by_creation_time", eq: [] }, clauses: [], order: "desc" })).toBe(true);
    expect(isEmptyFilter({ clauses: [], order: "asc" })).toBe(false);
    expect(isEmptyFilter(EXPR)).toBe(false);
  });
});

describe("value boxes", () => {
  test("JSON is JSON, 42n is an int64, a bare word is text", () => {
    expect(parseValueInput("42")).toEqual({ ok: true, value: 42 });
    expect(parseValueInput(" true ")).toEqual({ ok: true, value: true });
    expect(parseValueInput('"42"')).toEqual({ ok: true, value: "42" });
    expect(parseValueInput("[1, 2]")).toEqual({ ok: true, value: [1, 2] });
    expect(parseValueInput("-9n")).toEqual({ ok: true, value: encodeInt64(-9n) });
    expect(parseValueInput("ada@example.com")).toEqual({ ok: true, value: "ada@example.com" });
  });

  test("mistakes are reported, not guessed", () => {
    expect(parseValueInput("").ok).toBe(false);
    expect(parseValueInput("[1, 2").ok).toBe(false);
    expect(parseValueInput('{"a": ').ok).toBe(false);
    expect(parseValueInput(`${2n ** 63n}n`).ok).toBe(false);
  });

  test("formatting reads back to the same value", () => {
    for (const v of [42, "hello", "42", "true", "", " spaced ", null, [1, "a"], { a: 1 }, encodeInt64(123n), false]) {
      const text = formatValueInput(v as never);
      expect(v === "" ? text : parseValueInput(text)).toEqual(v === "" ? '""' : { ok: true, value: v });
    }
  });
});

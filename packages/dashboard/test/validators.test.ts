import { describe, expect, test } from "bun:test";
import type { ObjectFieldJson, ValidatorJson } from "../src/data-source.ts";
import { encodeInt64 } from "../src/filters.ts";
import { defaultValueFor, displayValidator, isValidatorJson, validateValue } from "../src/validators.ts";

const req = (fieldType: ValidatorJson): ObjectFieldJson => ({ fieldType, optional: false });
const opt = (fieldType: ValidatorJson): ObjectFieldJson => ({ fieldType, optional: true });
const obj = (value: Record<string, ObjectFieldJson>): ValidatorJson => ({ type: "object", value });
const S: ValidatorJson = { type: "string" };
const N: ValidatorJson = { type: "number" };

describe("validators as code", () => {
  test("each kind, as Convex writes it", () => {
    const cases: [ValidatorJson, string][] = [
      [{ type: "null" }, "v.null()"],
      [N, "v.float64()"],
      [{ type: "bigint" }, "v.int64()"],
      [{ type: "boolean" }, "v.boolean()"],
      [S, "v.string()"],
      [{ type: "bytes" }, "v.bytes()"],
      [{ type: "any" }, "v.any()"],
      [{ type: "literal", value: "a" }, 'v.literal("a")'],
      [{ type: "literal", value: encodeInt64(3n) }, "v.literal(3n)"],
      [{ type: "id", tableName: "users" }, 'v.id("users")'],
      [{ type: "array", value: S }, "v.array(v.string())"],
      [{ type: "record", keys: S, values: { fieldType: N, optional: false } }, "v.record(v.string(), v.float64())"],
      [{ type: "union", value: [S, { type: "null" }] }, "v.union(v.string(), v.null())"],
      [obj({ a: req(S), "b-c": opt(N) }), 'v.object({ a: v.string(), "b-c": v.optional(v.float64()) })'],
      [obj({}), "v.object({})"],
    ];
    for (const [v, text] of cases) expect(displayValidator(v)).toBe(text);
  });

  test("too wide for one line: an object's fields and a union's members go one per line", () => {
    const wide = obj({
      text: req(S),
      owner: req({ type: "id", tableName: "users" }),
      meta: req({
        type: "union",
        value: [{ type: "null" }, obj({ edited: req({ type: "boolean" }), editedAt: req(N) })],
      }),
    });
    expect(displayValidator(wide, { width: 40 })).toBe(
      [
        "v.object({",
        "  text: v.string(),",
        '  owner: v.id("users"),',
        "  meta: v.union(",
        "    v.null(),",
        "    v.object({",
        "      edited: v.boolean(),",
        "      editedAt: v.float64(),",
        "    }),",
        "  ),",
        "})",
      ].join("\n"),
    );
  });
});

describe("a template", () => {
  test("empty values for required fields; optional ones left out; a union's first member", () => {
    const v = obj({
      s: req(S),
      n: req(N),
      i: req({ type: "bigint" }),
      b: req({ type: "boolean" }),
      id: req({ type: "id", tableName: "t" }),
      l: req({ type: "literal", value: "x" }),
      a: req({ type: "array", value: S }),
      u: req({ type: "union", value: [N, S] }),
      o: opt(S),
    });
    expect(defaultValueFor(v)).toEqual({ s: "", n: 0, i: encodeInt64(0n), b: false, id: "", l: "x", a: [], u: 0 });
    expect(defaultValueFor({ type: "union", value: [] })).toBeNull();
  });
});

describe("checking a value", () => {
  const v = obj({
    limit: opt(N),
    owner: req({ type: "id", tableName: "users" }),
    tags: opt({ type: "array", value: S }),
  });

  test("a fit has no issues", () => {
    expect(validateValue(v, { owner: "x" })).toEqual([]);
    expect(validateValue(v, { owner: "x", limit: 2, tags: ["a"] })).toEqual([]);
    expect(validateValue({ type: "any" }, [1, { a: null }])).toEqual([]);
    expect(validateValue({ type: "bigint" }, encodeInt64(1n))).toEqual([]);
    expect(validateValue({ type: "literal", value: encodeInt64(1n) }, encodeInt64(1n))).toEqual([]);
  });

  test("each misfit, with its path and what to point at", () => {
    expect(validateValue(v, {})).toEqual([
      { path: [], at: "value", message: `Property 'owner' is missing but required: v.id("users")` },
    ]);
    expect(validateValue(v, { owner: "x", nope: 1 })[0]).toMatchObject({ path: ["nope"], at: "key" });
    expect(validateValue(v, { owner: "x", tags: ["a", 2] })).toEqual([
      { path: ["tags", 1], at: "value", message: "tags.1: Type 'number' is not assignable to v.string()" },
    ]);
    expect(validateValue(v, [])[0]?.message).toBe(
      `Type 'array' is not assignable to v.object({ limit: v.optional(v.float64()), owner: v.id("users"), tags: v.optional(v.array(v.string())) })`,
    );
    expect(validateValue({ type: "bigint" }, 1)[0]?.message).toBe("Type 'number' is not assignable to v.int64()");
    expect(validateValue({ type: "union", value: [N, S] }, true)[0]?.message).toBe(
      "Value does not match any type in v.union(v.float64(), v.string())",
    );
    expect(validateValue({ type: "literal", value: "a" }, "b")).toHaveLength(1);
    const rec: ValidatorJson = { type: "record", keys: S, values: { fieldType: N, optional: false } };
    expect(validateValue(rec, { a: 1, b: "x" })[0]?.path).toEqual(["b"]);
  });
});

describe("the JSON form", () => {
  test("recognised, and malformed ones refused", () => {
    expect(isValidatorJson(obj({ a: req({ type: "array", value: { type: "union", value: [S, N] } }) }))).toBe(true);
    expect(isValidatorJson({ type: "record", keys: S, values: { fieldType: N, optional: false } })).toBe(true);
    for (const bad of [
      null,
      {},
      { type: "float" },
      { type: "id" },
      { type: "object", value: { a: S } },
      { type: "array" },
    ])
      expect(isValidatorJson(bad)).toBe(false);
  });
});

// A builder given `undefined` where a validator goes (usually a circular import) throws when it is called, as
// Convex's `throwUndefinedValidatorError` (values/validators.ts), and the builders' other argument checks are
// Convex's, in its order and words (STUDY-13 §8).
import { describe, expect, test } from "bun:test";
import { v } from "../src/index.ts";

const U = undefined as never;
const message = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  return "no error";
};
const CIRCULAR = "This is often caused by circular imports.";

describe("undefined validators", () => {
  test("v.object: the field's name", () => {
    expect(message(() => v.object({ ok: v.string(), author: U }))).toBe(
      `A validator is undefined for field "author" in v.object(). ${CIRCULAR}`,
    );
  });

  test("v.array, v.record (key, value), v.union (the member's index)", () => {
    expect(message(() => v.array(U))).toBe(`A validator is undefined in v.array(). ${CIRCULAR}`);
    expect(message(() => v.record(U, v.number()))).toBe(
      `A validator is undefined for field "key" in v.record(). ${CIRCULAR}`,
    );
    expect(message(() => v.record(v.string(), U))).toBe(
      `A validator is undefined for field "value" in v.record(). ${CIRCULAR}`,
    );
    expect(message(() => v.union(v.string(), U, v.number()))).toBe(
      `A validator is undefined for field "member at index 1" in v.union(). ${CIRCULAR}`,
    );
  });

  test("no docs link (DV-358)", () => {
    expect(message(() => v.array(U))).not.toContain("http");
  });
});

describe("the builders' other checks, as Convex's", () => {
  test("entries that are not validators", () => {
    expect(message(() => v.object({ a: "nope" as never }))).toBe("v.object() entries must be validators");
    expect(message(() => v.union(v.string(), {} as never))).toBe("All members of v.union() must be validators");
    expect(message(() => v.record({} as never, v.number()))).toBe("Key and value of v.record() must be validators");
  });

  test("v.literal takes a string, number, bigint or boolean; v.id a string table name", () => {
    for (const bad of [undefined, null, {}, []])
      expect(message(() => v.literal(bad as never))).toBe("v.literal(value) must be a string, number, or boolean");
    for (const ok of ["a", 1, 1n, true]) expect(v.literal(ok).value).toBe(ok);
    expect(message(() => v.id(U))).toBe("v.id(tableName) requires a string");
    expect(message(() => v.id(5 as never))).toBe("v.id(tableName) requires a string");
  });

  test("a record: optional keys and values are refused before non-validators", () => {
    expect(message(() => v.record(v.optional(v.string()), {} as never))).toBe(
      "Record validator cannot have optional keys",
    );
    expect(message(() => v.record({} as never, v.optional(v.string())))).toBe(
      "Record validator cannot have optional values",
    );
  });
});

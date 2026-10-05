// Convex's value nesting limit (STUDY-109): 64 levels of arrays and objects (`MAX_NESTING`,
// crates/value/src/size.rs). `fromJsonValue` and `copyValue` refuse a deeper value with Convex's message;
// `measureRawValue` gives the size and the nesting in one walk, safely at any depth.
import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  copyValue,
  fromJsonValue,
  type JSONValue,
  MAX_VALUE_NESTING,
  measureRawValue,
  rawValueSize,
  TOO_NESTED_MESSAGE,
  type Value,
  valueNesting,
} from "../src/index.ts";
import { runs, value } from "./arbitraries.ts";

/** A value nested `n` levels: objects and arrays in turn around a leaf. */
const deep = (n: number, leaf: Value = "leaf"): Value => {
  let v = leaf;
  for (let i = 0; i < n; i++) v = i % 2 ? [v] : { a: v };
  return v;
};

test("Convex's limit and message", () => {
  expect(MAX_VALUE_NESTING).toBe(64);
  expect(TOO_NESTED_MESSAGE).toBe("Value is too nested (nested 65 levels deep > maximum nesting 64)");
});

test("fromJsonValue takes 64 levels and refuses 65", () => {
  expect(valueNesting(fromJsonValue(deep(64) as JSONValue))).toBe(64);
  expect(() => fromJsonValue(deep(65) as JSONValue)).toThrow(TOO_NESTED_MESSAGE);
  expect(() => fromJsonValue([deep(64)] as JSONValue)).toThrow(TOO_NESTED_MESSAGE);
});

test("an encoded scalar ($integer, $bytes) is no level of its own", () => {
  const int = { $integer: "AQAAAAAAAAA=" };
  expect(fromJsonValue(deep(64, int as never) as JSONValue)).toBeDefined();
  expect(() => fromJsonValue(deep(64, [] as never) as JSONValue)).toThrow(TOO_NESTED_MESSAGE);
});

test("copyValue takes 64 levels and refuses 65, or its own limit", () => {
  expect(valueNesting(copyValue(deep(64)))).toBe(64);
  expect(() => copyValue(deep(65))).toThrow(TOO_NESTED_MESSAGE);
  expect(valueNesting(copyValue(deep(65), 65))).toBe(65);
  expect(() => copyValue(deep(66), 65)).toThrow(TOO_NESTED_MESSAGE);
});

test("100 000 levels fail with the message, not a stack overflow", () => {
  const v = deep(100_000);
  expect(() => fromJsonValue(v as JSONValue)).toThrow(TOO_NESTED_MESSAGE);
  expect(() => copyValue(v)).toThrow(TOO_NESTED_MESSAGE);
  expect(measureRawValue(v).nesting).toBe(MAX_VALUE_NESTING + 1);
});

test("measureRawValue: exact nesting up to the cap + 1, then stops", () => {
  for (const n of [0, 1, 2, 63, 64, 65]) expect(measureRawValue(deep(n)).nesting).toBe(n);
  expect(measureRawValue(deep(66)).nesting).toBe(65);
  expect(measureRawValue(deep(66), 65).nesting).toBe(66);
  expect(measureRawValue(deep(70), 65).nesting).toBe(66);
  // Bytes and an empty container: a scalar, and one level.
  expect(measureRawValue({ b: new ArrayBuffer(3) }).nesting).toBe(1);
  expect(measureRawValue([[], {}]).nesting).toBe(2);
});

test("measureRawValue's size and nesting are rawValueSize's and valueNesting's, for any value", () => {
  fc.assert(
    fc.property(value, (v) => {
      const m = measureRawValue(v);
      expect(m.size).toBe(rawValueSize(v));
      expect(m.nesting).toBe(valueNesting(v));
    }),
    { numRuns: runs(2_000) },
  );
});

test("measuring leaves rawValueSize unlimited afterwards", () => {
  measureRawValue(deep(100));
  expect(rawValueSize(deep(100))).toBe(rawValueSize(deep(100)));
  // 100 levels walked in full: 50 objects ({a: …}: 2 + 1 + 1) and 50 arrays (2), around "leaf" (6).
  expect(rawValueSize(deep(100))).toBe(50 * 4 + 50 * 2 + 6);
});

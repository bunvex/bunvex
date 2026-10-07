// A sort key straight to JSON text (STUDY-133 Q4, MySQL's v1 documents): `sortKeyToJsonText(k)` is exactly
// `JSON.stringify(toJsonValue(sortKeyToValue(k)))` up to field order (fields come in sort-key order), for any
// value, special floats, int64 bounds and bytes included.
import { expect, test } from "bun:test";
import fc from "fast-check";
import { sortKeyToJsonText, sortKeyToValue, valuesToKey } from "../src/sorting.ts";
import { toJsonValue } from "../src/value.ts";
import { runs, value } from "./arbitraries.ts";

const viaValue = (key: Uint8Array) => JSON.stringify(toJsonValue(sortKeyToValue(key)));

test("sortKeyToJsonText equals the value path for any value", () => {
  fc.assert(
    fc.property(value, (v) => {
      const key = valuesToKey([v]);
      // The same JSON; field order may differ only for integer-like names, which JS objects list first.
      expect(JSON.parse(sortKeyToJsonText(key))).toEqual(JSON.parse(viaValue(key)));
    }),
    { numRuns: runs(1000) },
  );
});

test("examples: special floats, int64 bounds, bytes, an empty field name, nesting", () => {
  const doc = {
    "": 1,
    a: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 0, 1.5, -2],
    b: [-(2n ** 63n), 2n ** 63n - 1n, 0n, -1n, 300n],
    c: new Uint8Array([0, 255, 0, 1]).buffer,
    d: { e: { f: ["x\u0000y", "é", "😀"] } },
    t: true,
    n: null,
  };
  const key = valuesToKey([doc]);
  expect(sortKeyToJsonText(key)).toBe(viaValue(key));
});

test("a key with bytes after its value is refused", () => {
  const key = new Uint8Array([...valuesToKey([{ a: 1 }]), 0x03]);
  let err: unknown = null;
  try {
    sortKeyToJsonText(key);
  } catch (e) {
    err = e;
  }
  expect(err).not.toBeNull();
});

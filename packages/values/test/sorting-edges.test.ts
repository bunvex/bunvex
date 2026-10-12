// Sort keys (sorting.ts) at their edges: what the property tests' arbitraries never build (a commit timestamp
// placeholder, an object field holding `undefined`) and the decoders' refusals, message by message. Mutation
// testing (TEST-01 §7) found these untested.
import { describe, expect, test } from "bun:test";
import { commitTsPlaceholder, MAX_COMMIT_TS } from "../src/commit-ts.ts";
import { keyBytesLength, keyToValues, sortKeyToJsonText, sortKeyToValue, valuesToKey } from "../src/sorting.ts";

describe("encoding", () => {
  test("a commit timestamp placeholder is the largest int64, in the key and in its length", () => {
    const key = valuesToKey([commitTsPlaceholder as never]);
    expect(key).toEqual(valuesToKey([MAX_COMMIT_TS]));
    expect(keyBytesLength([commitTsPlaceholder as never])).toBe(key.length);
  });

  test("an object field holding undefined is left out, as if absent, in the key and in its length", () => {
    const withUndefined = { a: undefined, b: 1n } as never;
    expect(valuesToKey([withUndefined])).toEqual(valuesToKey([{ b: 1n }]));
    expect(keyBytesLength([withUndefined])).toBe(valuesToKey([{ b: 1n }]).length);
  });

  test("an empty field name is told from the object's terminator, and read back", () => {
    const key = valuesToKey([{ "": 1n, a: "x" }]);
    expect(sortKeyToValue(key)).toEqual({ "": 1n, a: "x" });
    expect(sortKeyToJsonText(key)).toBe('{"":{"$integer":"AQAAAAAAAAA="},"a":"x"}');
  });
});

describe("decoding refusals", () => {
  const cut = (k: Uint8Array) => k.subarray(0, k.length - 1);

  test("an unknown type tag is named, by either decoder", () => {
    for (const tag of [0x02, 0x00, 0x16, 0xff]) {
      const hex = tag.toString(16);
      expect(() => sortKeyToValue(Uint8Array.of(tag))).toThrow(`unknown type tag 0x${hex}`);
      expect(() => sortKeyToJsonText(Uint8Array.of(tag))).toThrow(`unknown type tag 0x${hex}`);
    }
  });

  test("a key cut inside a value", () => {
    const key = cut(valuesToKey([123456n]));
    expect(() => sortKeyToValue(key)).toThrow("key ends inside a value");
    expect(() => sortKeyToJsonText(key)).toThrow("key ends inside a value");
    expect(keyToValues(key)).toEqual({ values: [], consumed: 0 });
  });

  test("trailing bytes after the one value", () => {
    const key = valuesToKey([1n, 2n]);
    expect(() => sortKeyToValue(key)).toThrow("trailing bytes after the value");
    expect(() => sortKeyToJsonText(key)).toThrow("trailing bytes after the value");
  });

  test("undefined (a missing field) is not a value", () => {
    expect(() => sortKeyToValue(valuesToKey([undefined]))).toThrow("undefined is not a value");
  });
});

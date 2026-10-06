// Reading sort keys back (STUDY-131 AD-25): `keyToValues` is the inverse of `valuesToKey`. Any tuple of values
// (a missing field included) encodes to a key that decodes to values whose key is the same bytes, consuming
// it whole; a key cut short decodes as far as its values are whole (an interval bound's trailing 0xFF is read
// by @bunvex/core's `describeBound`, since after a string it reads as an escape).
import { expect, test } from "bun:test";
import fc from "fast-check";
import { keyToValues, valuesToKey } from "../src/sorting.ts";
import { keyPart, runs } from "./arbitraries.ts";

test("round trip: valuesToKey(keyToValues(k)) is k, consumed whole", () => {
  fc.assert(
    fc.property(fc.array(keyPart, { maxLength: 4 }), (vals) => {
      const key = valuesToKey(vals);
      const { values, consumed } = keyToValues(key);
      expect(consumed).toBe(key.length);
      expect(values.length).toBe(vals.length);
      expect(valuesToKey(values)).toEqual(key);
    }),
    { numRuns: runs(500) },
  );
});

test("a key cut short decodes as far as its values are whole", () => {
  fc.assert(
    fc.property(fc.array(keyPart, { minLength: 1, maxLength: 3 }), (vals) => {
      const key = valuesToKey(vals);
      const firstLen = valuesToKey(vals.slice(0, 1)).length;
      const cut = keyToValues(key.slice(0, firstLen - 1));
      expect(cut.values).toEqual([]);
      expect(cut.consumed).toBe(0);
    }),
    { numRuns: runs(300) },
  );
});

test("examples: each type", () => {
  const vals = [
    undefined,
    null,
    -5n,
    0n,
    300n,
    2n ** 40n,
    -1.5,
    0,
    true,
    false,
    "a\0b",
    "",
    [1n, "x"],
    { a: 1, "": null },
  ];
  const { values } = keyToValues(valuesToKey(vals as never));
  expect(values).toEqual(vals as never);
  const bytes = keyToValues(valuesToKey([new Uint8Array([0, 1, 255]).buffer])).values[0] as ArrayBuffer;
  expect([...new Uint8Array(bytes)]).toEqual([0, 1, 255]);
});

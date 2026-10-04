// Properties of the sort-key encoding (TEST-01 §2). Convex property-tests the same claims for its encoding
// (crates/value/src/sorting.rs: "compatible_with_manual_impl" per type and for nested values; round trips):
// comparing two values must give the same answer as comparing their keys byte-wise, and different values
// must have different keys. bunvex has no key decoder, so injectivity stands in for the round trip.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { keyBytesLength, valuesToKey } from "../src/sorting.ts";
import { compareValues } from "../src/value.ts";
import { bytes, float64, int64, keyPart, runs, text, value } from "./arbitraries.ts";

const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);
function compareBytes(a: Uint8Array, b: Uint8Array) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}
const keyOrder = (a: unknown, b: unknown) => sign(compareBytes(valuesToKey([a as never]), valuesToKey([b as never])));

describe("sort keys order values as compareValues does", () => {
  for (const [name, arb, n] of [
    ["integers", int64, 1000],
    ["floats (NaN, ±Infinity, −0 included)", float64, 1000],
    ["booleans", fc.boolean(), 50],
    ["strings (NUL inside included)", text, 1000],
    ["bytes", bytes, 1000],
    ["any values, nested", value, 500],
    ["values or a missing field", keyPart, 500],
  ] as const) {
    test(name, () => {
      fc.assert(
        fc.property(arb as fc.Arbitrary<unknown>, arb as fc.Arbitrary<unknown>, (a, b) => {
          expect(keyOrder(a, b)).toBe(sign(compareValues(a as never, b as never)));
        }),
        { numRuns: runs(n) },
      );
    });
  }

  test("a value is compared with nearby values of its own shape (shrinks well, finds near-ties)", () => {
    // equal-prefix pairs: b is a with one more element / field, or the same value
    fc.assert(
      fc.property(value, value, (a, extra) => {
        for (const b of [a, [a], [a, extra], { x: a }, { x: a, y: extra }]) {
          expect(keyOrder(a, b)).toBe(sign(compareValues(a, b as never)));
          expect(keyOrder(b, a)).toBe(sign(compareValues(b as never, a)));
        }
      }),
      { numRuns: runs(300) },
    );
  });
});

describe("sort keys are injective and self-delimiting", () => {
  test("equal keys exactly when compareValues says equal", () => {
    fc.assert(
      fc.property(keyPart, keyPart, (a, b) => {
        const same = compareBytes(valuesToKey([a]), valuesToKey([b])) === 0;
        expect(same).toBe(compareValues(a, b) === 0);
      }),
      { numRuns: runs(500) },
    );
  });

  test("a tuple's key orders lexicographically by component (keys are self-delimiting)", () => {
    // (a1, a2) vs (b1, b2): the first differing component decides, whatever comes after it
    fc.assert(
      fc.property(keyPart, keyPart, keyPart, keyPart, (a1, a2, b1, b2) => {
        const c = sign(compareValues(a1, b1)) || sign(compareValues(a2, b2));
        expect(sign(compareBytes(valuesToKey([a1, a2]), valuesToKey([b1, b2])))).toBe(c);
      }),
      { numRuns: runs(500) },
    );
  });

  test("when one value's key is a proper prefix of another's, the next byte is the 0xFF escape, never a type tag", () => {
    // `""` is a prefix of `"\0"`, `{}` of `{"": x}`, empty bytes of `[0x00]`: the encoding (as Convex's,
    // crates/value/src/sorting.rs) continues those with 0xFF, above every type tag, so a tuple still orders by
    // its first component. (It is also why an eq-prefix range [k, increment(k)) can reach such keys.)
    fc.assert(
      fc.property(keyPart, keyPart, (a, b) => {
        const ka = valuesToKey([a]);
        const kb = valuesToKey([b]);
        if (ka.length < kb.length && compareBytes(ka, kb.subarray(0, ka.length)) === 0)
          expect(kb[ka.length]).toBe(0xff);
      }),
      { numRuns: runs(500) },
    );
  });
});

// What usage metering charges for an index key read (STUDY-71) is the encoded key's length, computed
// without encoding it.
test("keyBytesLength is the encoded key's length", () => {
  fc.assert(
    fc.property(fc.array(keyPart, { maxLength: 4 }), (parts) => {
      expect(keyBytesLength(parts)).toBe(valuesToKey(parts).length);
    }),
    { numRuns: runs(2000) },
  );
});

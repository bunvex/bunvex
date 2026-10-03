// fast-check arbitraries for values, for the core property tests (TEST-01 §2). A copy of
// packages/values/test/arbitraries.ts: a package may not import another package's test files (check-deps
// rule 3), and these are test-only, so they are not exported from @bunvex/values.

import type { Value } from "@bunvex/values";
import fc from "fast-check";

export const int64 = fc.oneof(
  fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }),
  // the width boundaries of the integer encoding, and the int64 ends
  fc.constantFrom(
    0n,
    -1n,
    1n,
    127n,
    128n,
    -128n,
    -129n,
    32767n,
    32768n,
    -32768n,
    -32769n,
    2n ** 31n - 1n,
    2n ** 31n,
    -(2n ** 31n),
    -(2n ** 31n) - 1n,
    -(2n ** 63n),
    2n ** 63n - 1n,
  ),
);

export const float64 = fc.oneof(
  fc.double(),
  fc.constantFrom(
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -0,
    0,
    Number.MIN_VALUE,
    -Number.MIN_VALUE,
  ),
);

/** Strings of valid Unicode (no lone surrogates), with NUL and the byte 0xFF-adjacent characters well represented. */
export const text = fc.oneof(
  fc.string({ unit: "binary" }),
  fc.string({ unit: fc.constantFrom("\0", "a", "ÿ", "￿", "😀", "\u0001"), maxLength: 6 }),
);

export const bytes = fc
  .oneof(
    fc.uint8Array({ maxLength: 12 }),
    fc.uint8Array({ maxLength: 6, min: 0, max: 1 }),
    fc.uint8Array({ maxLength: 4, min: 254, max: 255 }),
  )
  .map((u) => u.slice().buffer as ArrayBuffer);

/** Field names Convex accepts: non-control ASCII, not starting with `$` (the empty name included). */
export const fieldName = fc
  .oneof(
    fc.string({ unit: fc.integer({ min: 32, max: 126 }).map((c) => String.fromCharCode(c)), maxLength: 5 }),
    fc.constantFrom("", "a", "b", "_id", "a b"),
  )
  .filter((k) => !k.startsWith("$"));

const leaf: fc.Arbitrary<Value> = fc.oneof(fc.constant(null), int64, float64, fc.boolean(), text, bytes);

/** Any value, nested up to a few levels. */
export const value: fc.Arbitrary<Value> = fc.letrec<{ v: Value }>((tie) => ({
  v: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    leaf,
    fc.array(tie("v"), { maxLength: 4 }),
    fc.dictionary(fieldName, tie("v"), { maxKeys: 4 }),
  ),
})).v;

/** A value or a missing field (`undefined`), as an index key component. */
export const keyPart = fc.oneof(fc.constant(undefined), value);

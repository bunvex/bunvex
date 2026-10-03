// fast-check arbitraries for values (TEST-01 §2): every Value type, nested, with the edge cases the
// encodings must get right — int64 bounds, NaN/±Infinity/−0, NUL bytes inside strings and bytes, the empty
// field name, deep nesting. Shared by the property tests of @bunvex/values and @bunvex/core.
import fc from "fast-check";
import type { Value } from "../src/value.ts";

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

/**
 * How many cases a property runs: `base` × BUNVEX_PROPERTY_MULTIPLIER (default 1). CI runs the default; the
 * nightly job raises it — as Convex scales its proptest cases by an environment multiplier.
 */
export const runs = (base: number) => base * Math.max(1, Number(process.env.BUNVEX_PROPERTY_MULTIPLIER ?? 1));

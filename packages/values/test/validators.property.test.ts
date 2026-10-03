// Validators accept the values they describe (TEST-01 §2): a generator builds a random validator together
// with a value of its shape — nested arrays, objects with optional fields, records, unions, literals — and
// checkValue must accept it; a value of another type at the top must be refused. The same claim Convex's
// validator code is property-tested for (crates/common/src/schemas/validator.rs builds on value's
// Arbitrary impls; crates/value/src/sorting.rs for the values themselves).
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { checkValue, displayValidator } from "../src/check.ts";
import { type GenericValidator, v } from "../src/validators.ts";
import type { Value } from "../src/value.ts";
import { bytes, fieldName, float64, int64, runs, text } from "./arbitraries.ts";

type Pair = { validator: GenericValidator; value: fc.Arbitrary<Value | undefined> };

const leafPairs: fc.Arbitrary<Pair> = fc.constantFrom<Pair>(
  { validator: v.null(), value: fc.constant(null) },
  { validator: v.number(), value: float64 },
  { validator: v.int64(), value: int64 },
  { validator: v.boolean(), value: fc.boolean() },
  { validator: v.string(), value: text },
  { validator: v.bytes(), value: bytes },
  { validator: v.any(), value: fc.oneof(int64, text, fc.constant(null)) },
  { validator: v.literal("on"), value: fc.constant("on") },
  { validator: v.literal(7n), value: fc.constant(7n) },
);

const pairs: fc.Arbitrary<Pair> = fc.letrec<{ p: Pair }>((tie) => ({
  p: fc.oneof(
    { depthSize: "small" },
    leafPairs,
    tie("p").map(
      (e): Pair => ({
        validator: v.array(e.validator as never),
        value: fc.array(e.value, { maxLength: 3 }) as fc.Arbitrary<Value>,
      }),
    ),
    fc.dictionary(fieldName, fc.tuple(tie("p"), fc.boolean()), { maxKeys: 3 }).map((fs): Pair => {
      const fields: Record<string, GenericValidator> = {};
      const values: Record<string, fc.Arbitrary<Value | undefined>> = {};
      for (const [k, [p, optional]] of Object.entries(fs)) {
        fields[k] = optional ? v.optional(p.validator) : p.validator;
        values[k] = optional ? fc.option(p.value, { nil: undefined }) : p.value;
      }
      return {
        validator: v.object(fields),
        value: fc
          .record(values)
          .map((o) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined)) as Value),
      };
    }),
    tie("p").map(
      (e): Pair => ({
        validator: v.record(v.string(), e.validator as never),
        value: fc.dictionary(fieldName, e.value as fc.Arbitrary<Value>, { maxKeys: 3 }) as fc.Arbitrary<Value>,
      }),
    ),
    fc.tuple(tie("p"), tie("p"), fc.boolean()).map(
      ([a, b, first]): Pair => ({
        validator: v.union(a.validator, b.validator),
        value: first ? a.value : b.value,
      }),
    ),
  ),
})).p;

const withValue = pairs.chain((p) => p.value.map((value) => ({ validator: p.validator, value })));

describe("validators", () => {
  test("accept every value generated for them", () => {
    fc.assert(
      fc.property(withValue, ({ validator, value }) => {
        const error = checkValue(validator, value as Value);
        if (error !== null) throw new Error(`${displayValidator(validator)} refused a value of its shape: ${error}`);
      }),
      { numRuns: runs(500) },
    );
  });

  test("refuse a value of another top-level type (an object validator refuses a string, …)", () => {
    const mismatched = fc.constantFrom<[GenericValidator, Value]>(
      [v.number(), 1n],
      [v.int64(), 1.5],
      [v.string(), new ArrayBuffer(1)],
      [v.bytes(), "x"],
      [v.boolean(), null],
      [v.array(v.null()), {}],
      [v.object({}), []],
      [v.literal("on"), "off"],
    );
    fc.assert(
      fc.property(mismatched, ([validator, value]) => expect(checkValue(validator, value)).not.toBeNull()),
      { numRuns: runs(50) },
    );
  });
});

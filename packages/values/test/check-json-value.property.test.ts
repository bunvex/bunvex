// `checkJsonValue`, the quick check of a nested call's arguments (STUDY-95): it throws exactly what
// `toJsonValue` throws, and nothing when `toJsonValue` does not, for supported values and for anything else
// (unsupported types, bad field names, out-of-range integers, `undefined`, too deep), at any depth.
import { expect, test } from "bun:test";
import fc from "fast-check";
import { commitTsPlaceholder } from "../src/commit-ts.ts";
import { checkJsonValue, MAX_VALUE_NESTING, toJsonValue, type Value } from "../src/index.ts";
import { runs, value } from "./arbitraries.ts";

const outcome = (f: () => unknown) => {
  try {
    f();
    return "ok";
  } catch (e) {
    return `${(e as Error).constructor.name}: ${(e as Error).message}`;
  }
};
const same = (v: unknown) =>
  expect(outcome(() => checkJsonValue(v as Value))).toBe(outcome(() => toJsonValue(v as Value)));

class Point {
  x = 1;
}
const odd = fc.constantFrom<unknown>(
  new Set([1]),
  new Map([[1, 2]]),
  () => 1,
  Symbol("s"),
  new Point(),
  new Date(0),
  undefined,
  2n ** 63n,
  -(2n ** 63n) - 1n,
  { $bad: 1 },
  { ["é"]: 1 },
  { ["\u0001"]: 1 },
  { ["x".repeat(1025)]: 1 },
  { a: undefined },
  [1, undefined],
  Object.create(null),
);
const mixed: fc.Arbitrary<unknown> = fc.letrec<{ v: unknown }>((tie) => ({
  v: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    value,
    odd,
    fc.array(tie("v"), { maxLength: 3 }),
    fc.dictionary(fc.constantFrom("a", "b", "_c", "$d"), tie("v"), { maxKeys: 3 }),
  ),
})).v;

test("supported values: never throws, as toJsonValue", () => {
  fc.assert(
    fc.property(value, (v) => same(v)),
    { numRuns: runs(300) },
  );
});

test("anything: throws what toJsonValue throws, or nothing when it does not", () => {
  fc.assert(
    fc.property(mixed, (v) => same(v)),
    { numRuns: runs(500) },
  );
});

test("the edges the quick walk leaves to toJsonValue", () => {
  let deep: unknown = 1;
  for (let i = 0; i <= MAX_VALUE_NESTING + 1; i++) deep = [deep];
  for (const v of [
    deep,
    { v: commitTsPlaceholder },
    2n ** 63n - 1n,
    -(2n ** 63n),
    { ["x".repeat(1024)]: 1 },
    { "~": 1, " ": 2 },
    new ArrayBuffer(2),
  ])
    same(v);
});

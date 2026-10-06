// The validator builders' argument errors against the official package (STUDY-13 §8): the same calls, with
// `undefined` or a non-validator where a validator goes, throw the same messages, but for Convex's docs link
// (DV-358).
import { expect, test } from "bun:test";
import { v as bv } from "@bunvex/values";
import { v as cv } from "convex/values";

// biome-ignore lint/suspicious/noExplicitAny: one call for both packages' `v`
type Any = any;
const U = undefined as Any;
const CALLS: [string, (v: Any) => unknown][] = [
  ["object field", (v) => v.object({ a: v.string(), b: U })],
  ["object entry", (v) => v.object({ a: "nope" })],
  ["array", (v) => v.array(U)],
  ["record key", (v) => v.record(U, v.number())],
  ["record value", (v) => v.record(v.string(), U)],
  ["record optional key", (v) => v.record(v.optional(v.string()), {})],
  ["record optional value", (v) => v.record({}, v.optional(v.string()))],
  ["record non-validator", (v) => v.record({}, v.number())],
  ["union member", (v) => v.union(v.string(), U)],
  ["union non-validator", (v) => v.union(v.string(), {})],
  ["literal undefined", (v) => v.literal(U)],
  ["literal null", (v) => v.literal(null)],
  ["literal object", (v) => v.literal({})],
  ["id undefined", (v) => v.id(U)],
  ["id number", (v) => v.id(5)],
  ["nullable undefined", (v) => v.nullable(U)],
];
const message = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  return "no error";
};

for (const [name, call] of CALLS)
  test(`${name}: the official package's message, without its docs link`, () => {
    const theirs = message(() => call(cv)).replace(/ See https:\/\/\S+ for details\.$/, "");
    expect(message(() => call(bv))).toBe(theirs);
  });

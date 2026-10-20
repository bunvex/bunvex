// A `Set` or `Map` where a value goes (STUDY-18 §9), against the official `convex` package as the oracle: bunvex's
// `toJsonValue` gives `convexToJson`'s message, entries included (`Set[1]`, `Map[["a",1]]`), for a Set or Map of
// this realm and of another (a pushed function's own context, STUDY-35). Convex's code runs in the app's realm, so
// its oracle is run on this realm's values. The words are bunvex's (DV-04), and a Set or Map that is not the one
// refused prints as `Name {…}` (DV-316), where Convex's `JSON.stringify` prints `{}`.
import { expect, test } from "bun:test";
import { runInNewContext, runInThisContext } from "node:vm";
import { toJsonValue, type Value } from "@bunvex/values";
import { type Value as ConvexValue, convexToJson } from "convex/values";

const SOURCES = [
  "new Set()",
  "new Set([1])",
  'new Set([1, "two", null, [3], { four: 4n }, undefined])',
  "new Map()",
  'new Map([["a", 1]])',
  'new Map([["a", 1], [2, [true]], [null, { b: "c" }]])',
  "new Set([new Set([1]), new Map([[1, 2]])])",
  "new (class Tags extends Set {})([1])",
  "({ v: new Set([1]), w: 2 })",
  '({ x: { m: new Map([["k", new Set()]]) } })',
  '[0, [new Set(["s"])]]',
  '({ s: new Set(["x".repeat(20000)]) })',
  '({ [Symbol.toStringTag]: "ArrayBuffer", a: 1 })',
];

type Outcome = { ok: unknown } | { error: string };
const err = (f: () => unknown): Outcome => {
  try {
    return { ok: f() };
  } catch (e) {
    return { error: (e as Error).message };
  }
};
const inBunvexWords = (m: string) =>
  m
    .replace(" is not a supported Convex type", " is not a supported value type")
    .replace(" To learn about Convex's supported types, see https://docs.convex.dev/using/types.", "");

test("a Set or Map of either realm: convexToJson's message", () => {
  for (const source of SOURCES) {
    const convex = err(() => convexToJson(runInThisContext(`(${source})`) as ConvexValue));
    const expected = "error" in convex ? { error: inBunvexWords(convex.error) } : convex;
    for (const realm of ["own", "other"] as const) {
      const v = realm === "own" ? runInThisContext(`(${source})`) : runInNewContext(`(${source})`, {});
      const got = err(() => toJsonValue(v as Value));
      const shown = "error" in got ? { error: got.error.replace(/\b(Set|Map) \{…\}/g, "{}") } : got;
      expect({ source, realm, shown }).toEqual({ source, realm, shown: expected });
    }
  }
});

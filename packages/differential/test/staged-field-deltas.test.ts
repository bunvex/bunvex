// STUDY-186 A7: `.staged()` with field deltas (Convex's `c3d9d79`), against Convex's own `defineTable` from the
// installed `convex` 1.48.0, for the same declarations: the staged validator each builds (its JSON), and the error
// each throws. No backend is needed: the staged validator is built by the client library and pushed as JSON.
import { expect, test } from "bun:test";
import * as b from "bunvex/server";
import * as bv from "bunvex/values";
import * as c from "convex/server";
import * as cv from "convex/values";

type V = typeof bv.v;
// biome-ignore lint/suspicious/noExplicitAny: either package's table definition
type Define = (d: any) => any;

/** Each declaration, as a function of either package's `defineTable` and `v`. */
const CASES: Record<string, (defineTable: Define, v: V) => unknown> = {
  "replace and add fields": (d, v) =>
    d({ apple: v.string(), banana: v.number() }).staged({
      banana: v.union(v.string(), v.number()),
      cherry: v.boolean(),
    }),
  "remove a field with undefined": (d, v) =>
    d({ apple: v.string(), legacy: v.optional(v.string()) }).staged({ legacy: undefined }),
  "remove a field the table lacks": (d, v) => d({ apple: v.string() }).staged({ nope: undefined }),
  "an empty delta": (d, v) => d({ apple: v.string() }).staged({}),
  "the order: enforced fields first, then the new ones": (d, v) =>
    d({ b: v.string(), a: v.number() }).staged({ c: v.null(), a: v.string(), b: undefined }),
  "a nested object is replaced whole": (d, v) =>
    d({ o: v.object({ x: v.string(), y: v.number() }) }).staged({ o: v.object({ x: v.number() }) }),
  "a delta over v.any()": (d, v) => d(v.any()).staged({ a: v.string(), b: undefined }),
  "an object validator for the table": (d, v) => d(v.object({ a: v.string() })).staged({ a: v.number() }),
  "a whole validator is taken as is": (d, v) => d({ a: v.string() }).staged(v.object({ z: v.string() })),
  "a whole union over a union table": (d, v) =>
    d(v.union(v.object({ a: v.string() }), v.object({ b: v.number() }))).staged(v.union(v.object({ a: v.string() }))),
  "a delta over a union table": (d, v) =>
    d(v.union(v.object({ a: v.string() }), v.object({ b: v.number() }))).staged({ a: v.number() }),
  "a delta over a record table": (d, v) => d(v.record(v.string(), v.number())).staged({ a: v.number() }),
  "staged twice": (d, v) => d({ a: v.string() }).staged({ a: v.number() }).staged({ a: v.string() }),
};

/** The staged validator's JSON, or the error thrown. */
function outcome(f: () => unknown, staged: (t: Record<string, unknown>) => unknown) {
  try {
    const t = f() as Record<string, unknown>;
    return { json: (staged(t) as { json: unknown }).json };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

for (const [name, declare] of Object.entries(CASES))
  test(`.staged(): ${name}, as Convex's`, () => {
    const ours = outcome(
      () => declare(b.defineTable, bv.v),
      (t) => t.stagedDocument,
    );
    const theirs = outcome(
      () => declare(c.defineTable, cv.v as unknown as V),
      (t) => t.stagedValidator,
    );
    expect({ name, ...ours }).toEqual({ name, ...theirs });
  });

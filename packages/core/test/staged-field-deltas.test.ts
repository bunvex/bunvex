// `.staged()` field deltas (STUDY-186 A7, Convex's `c3d9d79`): over a table defined as an object or `v.any()`, an
// object of fields replaces or adds to the enforced ones, and `undefined` removes one; a whole validator is taken as
// is; a union or record table refuses a delta. Against Convex's own package in
// packages/differential/test/staged-field-deltas.test.ts.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { defineTable } from "../src/schema.ts";

const json = (t: { stagedDocument?: { json: unknown } }) => t.stagedDocument?.json;

test("a delta keeps the enforced fields, replaces, adds and removes", () => {
  const t = defineTable({ apple: v.string(), banana: v.number(), legacy: v.optional(v.string()) }).staged({
    banana: v.union(v.string(), v.number()),
    cherry: v.boolean(),
    legacy: undefined,
  });
  expect(json(t)).toEqual(
    v.object({ apple: v.string(), banana: v.union(v.string(), v.number()), cherry: v.boolean() }).json,
  );
  // The enforced validator is left alone.
  expect(t.validator.json).toEqual(
    v.object({ apple: v.string(), banana: v.number(), legacy: v.optional(v.string()) }).json,
  );
});

test("over v.any(): the delta's own fields; a whole validator as is", () => {
  expect(json(defineTable(v.any()).staged({ a: v.string(), b: undefined }))).toEqual(v.object({ a: v.string() }).json);
  expect(json(defineTable({ a: v.string() }).staged(v.object({ z: v.string() })))).toEqual(
    v.object({ z: v.string() }).json,
  );
});

test("a union or record table refuses a delta, in Convex's words", () => {
  const message =
    "Specifying top-level field changes is only supported for simple table definitions. For a table defined with a union or record validator, you must stage a fully defined object or union validator.";
  expect(() => defineTable(v.union(v.object({ a: v.string() }))).staged({ a: v.number() })).toThrow(message);
  expect(() => defineTable(v.record(v.string(), v.number())).staged({ a: v.number() })).toThrow(message);
  expect(json(defineTable(v.union(v.object({ a: v.string() }))).staged(v.object({ a: v.number() })))).toEqual(
    v.object({ a: v.number() }).json,
  );
});

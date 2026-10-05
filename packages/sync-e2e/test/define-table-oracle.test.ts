// `defineTable` with a validator a table cannot have, against the official package (STUDY-14 §6): declaring it
// throws in neither; exporting one whose JSON is not an object throws the same message, but for Convex's docs
// link (DV-397).
import { expect, test } from "bun:test";
import { defineSchema as bunvexSchema, defineTable as bunvexTable, schemaToJson } from "@bunvex/core";
import { v as bv } from "@bunvex/values";
import { defineSchema, defineTable } from "convex/server";
import { v as cv } from "convex/values";

// biome-ignore lint/suspicious/noExplicitAny: one call for both packages
type Any = any;
const message = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  return "no error";
};

test("declaring a string, an array or a union with a non-object: no error in either", () => {
  for (const [table, v] of [
    [defineTable, cv],
    [bunvexTable, bv],
  ] as Any[]) {
    expect(message(() => table(v.string()))).toBe("no error");
    expect(message(() => table(v.array(v.string())))).toBe("no error");
    expect(message(() => table(v.union(v.object({}), v.null())))).toBe("no error");
  }
});

test("exporting a document validator whose JSON is not an object: the same message", () => {
  const broken = () => ({ isValidator: true, isConvexValidator: true, kind: "object", json: "nope" }) as Any;
  const theirs = message(() => (defineSchema({ t: defineTable(broken()) }) as Any).export()).replace(
    / \(see https:\/\/\S+\)$/,
    "",
  );
  expect(theirs).toStartWith("Invalid validator: please make sure that the parameter of `defineTable` is valid");
  expect(message(() => schemaToJson(bunvexSchema({ t: bunvexTable(broken()) })))).toBe(theirs);
});

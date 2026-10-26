// STUDY-181 H-5: a table definition's index lists at run time, against Convex's own `defineTable` from the installed
// `convex` 1.48.0, for the same declarations. Libraries such as convex-helpers read these lists
// (`schema.tables[t].indexes.find((i) => i.indexDescriptor === name).fields`). No backend is needed.
import { expect, test } from "bun:test";
import * as b from "bunvex/server";
import * as bv from "bunvex/values";
import * as c from "convex/server";
import * as cv from "convex/values";

const LISTS = [
  "indexes",
  "stagedDbIndexes",
  "searchIndexes",
  "stagedSearchIndexes",
  "vectorIndexes",
  "stagedVectorIndexes",
] as const;

// The same declarations, on either `defineTable`: plain, staged, repeated, search and vector indexes.
// biome-ignore lint/suspicious/noExplicitAny: either package's table definition
function declare(defineTable: (d: any) => any, v: typeof bv.v) {
  return defineTable({ a: v.string(), b: v.number(), c: v.string(), e: v.array(v.float64()) })
    .index("by_a", ["a"])
    .index("by_b_staged", { fields: ["b"], staged: true })
    .index("by_ab", { fields: ["a", "b"] })
    .index("by_a", ["c"])
    .index("by_c_staged", { fields: ["c"], staged: true })
    .index("by_c", { fields: ["c"], staged: false })
    .searchIndex("search_c", { searchField: "c" })
    .searchIndex("search_a", { searchField: "a", filterFields: ["b", "b"] })
    .searchIndex("search_staged", { searchField: "c", filterFields: ["a"], staged: true })
    .searchIndex("search_c", { searchField: "a", staged: false })
    .vectorIndex("vec", { vectorField: "e", dimensions: 3, filterFields: ["a"] })
    .vectorIndex("vec_bare", { vectorField: "e", dimensions: 4 })
    .vectorIndex("vec_staged", { vectorField: "e", dimensions: 5, staged: true });
}

test("defineTable's six index lists and ` indexes`() match Convex's", () => {
  const ours = declare(b.defineTable, bv.v);
  const theirs = declare(c.defineTable, cv.v as unknown as typeof bv.v);
  for (const list of LISTS) {
    expect(Array.isArray(ours[list])).toBe(true);
    expect({ list, value: ours[list] }).toEqual({ list, value: theirs[list] });
  }
  expect(ours[" indexes"]()).toEqual(theirs[" indexes"]());
  expect(ours[" indexes"]()).toBe(ours.indexes);
  expect(theirs[" indexes"]()).toBe(theirs.indexes);
});

test("an empty table's lists match Convex's", () => {
  const ours = b.defineTable({ a: bv.v.string() }) as unknown as Record<string, unknown>;
  const theirs = c.defineTable({ a: cv.v.string() }) as unknown as Record<string, unknown>;
  for (const list of LISTS) expect({ list, value: ours[list] }).toEqual({ list, value: theirs[list] });
});

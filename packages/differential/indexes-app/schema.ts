// The schema of the index list test (STUDY-149 "Index list"): one table with an index of every kind, staged and
// not, and a table with none.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  docs: defineTable({
    body: v.string(),
    title: v.string(),
    author: v.string(),
    n: v.number(),
    e: v.array(v.float64()),
    f: v.array(v.float64()),
  })
    .index("by_author", ["author"])
    .index("by_author_n", ["author", "n"])
    .index("by_n_staged", { fields: ["n"], staged: true })
    .searchIndex("search_body", { searchField: "body", filterFields: ["author", "n"] })
    .searchIndex("search_staged", { searchField: "title", staged: true })
    .vectorIndex("by_e", { vectorField: "e", dimensions: 3, filterFields: ["author"] })
    .vectorIndex("by_f_staged", { vectorField: "f", dimensions: 2, staged: true }),
  plain: defineTable({ x: v.number() }),
});

// The cross-open and export/import app (STUDY-133 PR 9, STUDY-139 P7): a table with a database index, a text search index and a vector index,
// so a store moved between the two binaries exercises each kind.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  notes: defineTable({ body: v.string(), kind: v.string(), v: v.array(v.float64()) })
    .index("by_kind", ["kind"])
    .searchIndex("search_body", { searchField: "body", filterFields: ["kind"] })
    .vectorIndex("by_v", { vectorField: "v", dimensions: 2, filterFields: ["kind"] }),
});

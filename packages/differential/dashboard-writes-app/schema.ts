// The Data screen's writes (STUDY-149 PR 3): a table with a strict document type, one of any documents, and an
// undeclared table the tests write too.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  strict: defineTable({ name: v.string(), n: v.optional(v.number()) }),
  free: defineTable(v.any()).index("by_k", ["k"]),
});

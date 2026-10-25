// A vector index with a filter field, for the filters of vector-filter.test.ts (STUDY-187 §2.3).
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  docs: defineTable({ tag: v.string(), e: v.array(v.float64()) }).vectorIndex("by_e", {
    vectorField: "e",
    dimensions: 3,
    filterFields: ["tag"],
  }),
});

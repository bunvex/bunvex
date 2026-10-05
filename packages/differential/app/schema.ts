// The differential app's schema (STUDY-129): two tables of any documents, with indexes of one and of two
// fields, so generated documents (any values, missing fields) are accepted and every index order is used.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  a: defineTable(v.any()).index("by_k", ["k"]).index("by_k_n", ["k", "n"]),
  b: defineTable(v.any()).index("by_x", ["x"]),
});

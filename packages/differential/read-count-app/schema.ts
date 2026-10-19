// The tables of the read-count tests (STUDY-161 §16).
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
export default defineSchema({
  big: defineTable(v.any()).index("by_i", ["i"]),
  small: defineTable(v.any()).index("by_k", ["k"]).searchIndex("s", { searchField: "t" }),
  other: defineTable(v.any()),
});

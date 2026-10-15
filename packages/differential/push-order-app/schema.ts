// The schema of the push-order test (STUDY-161 §7): tables with and without indexes of every kind, in no order.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  zebra: defineTable({ a: v.string() }),
  strict: defineTable({ name: v.string() }),
  free: defineTable(v.any()).index("by_k", ["k"]),
  apple: defineTable(v.any()),
  Mango: defineTable(v.any()),
  srch: defineTable({ body: v.string() }).searchIndex("s", { searchField: "body" }),
  vec: defineTable({ e: v.array(v.float64()) }).vectorIndex("v", { vectorField: "e", dimensions: 2 }),
  stg: defineTable({ k: v.number() }).index("by_k", { fields: ["k"], staged: true }),
  Beta: defineTable(v.any()),
  aaa: defineTable(v.any()),
});

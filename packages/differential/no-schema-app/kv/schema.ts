// The component's schema: one table, one index.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  entries: defineTable({ k: v.string() }).index("by_k", ["k"]),
});

// The app of the query reuse tests (STUDY-188 §X9): one table with an index.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  items: defineTable({ n: v.number() }).index("by_n", ["n"]),
});

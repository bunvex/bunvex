// The tables of the cache-metadata test (STUDY-174 §3): what a query reads, and a table it does not read.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
export default defineSchema({
  items: defineTable(v.any()),
  others: defineTable(v.any()),
});

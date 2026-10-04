import { defineSchema, defineTable } from "bunvex/server";
import { v } from "bunvex/values";

export default defineSchema({
  counters: defineTable({
    name: v.string(),
    value: v.number(),
  }).index("by_name", ["name"]),
});

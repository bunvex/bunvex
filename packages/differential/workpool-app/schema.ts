// What the pool's callbacks record, and the counters that make an action fail a given number of times.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  completions: defineTable({ label: v.string(), workId: v.string(), context: v.any(), result: v.any() }).index(
    "label",
    ["label"],
  ),
  attempts: defineTable({ label: v.string(), n: v.number() }).index("label", ["label"]),
});

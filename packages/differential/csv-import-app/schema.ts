// Tables whose validators have optional top-level fields, for csv-import.test.ts (STUDY-187 §2.2).
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  people: defineTable({ a: v.optional(v.float64()), b: v.optional(v.string()), c: v.string() }),
  either: defineTable(
    v.union(v.object({ k: v.literal("x"), p: v.optional(v.float64()) }), v.object({ k: v.literal("y") })),
  ),
});

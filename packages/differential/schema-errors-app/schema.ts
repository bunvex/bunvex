// The app of the schema error display tests (STUDY-161 §3): a strict table, and a union of objects.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  strict: defineTable({ name: v.string(), n: v.optional(v.number()) }),
  either: defineTable(v.union(v.object({ kind: v.literal("a") }), v.object({ kind: v.literal("b"), x: v.number() }))),
});

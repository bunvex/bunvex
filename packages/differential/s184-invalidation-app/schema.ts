// The table of the subscription bench (bench/s184-invalidation.ts, STUDY-184 §5.6) on Convex's backend.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
export default defineSchema({ docs: defineTable({ g: v.number(), t: v.number() }).index("by_g", ["g", "t"]) });

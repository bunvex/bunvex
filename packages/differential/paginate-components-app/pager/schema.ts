import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({ items: defineTable({ n: v.number() }).index("by_n", ["n"]) });

// The app of the unhandled rejection tests: one table of any documents.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({ items: defineTable(v.any()) });

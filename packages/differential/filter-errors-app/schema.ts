// The app of the filter error tests (STUDY-161 §14): one table of any documents.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({ free: defineTable(v.any()) });

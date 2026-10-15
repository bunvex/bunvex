// The app of the system-field mismatch tests (STUDY-161 §4): one table of any documents.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({ free: defineTable(v.any()) });

// The app of the write argument error tests (STUDY-161 §1, §2): one table of any documents.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({ free: defineTable(v.any()) });

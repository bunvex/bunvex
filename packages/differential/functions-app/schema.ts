// The table the app's functions read and write.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({ messages: defineTable({ body: v.string() }) });

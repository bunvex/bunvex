import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";

export default defineSchema({ counts: defineTable({ name: v.string(), n: v.number() }).index("name", ["name"]) });

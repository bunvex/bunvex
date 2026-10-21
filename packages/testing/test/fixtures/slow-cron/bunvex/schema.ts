import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";

export default defineSchema({ ticks: defineTable({ at: v.number() }), jobs: defineTable({ at: v.number() }) });

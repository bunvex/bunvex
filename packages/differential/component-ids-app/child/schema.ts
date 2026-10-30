// The component's tables: `messages` 10001, `notes` 10002.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  messages: defineTable({ body: v.string() }),
  notes: defineTable({ n: v.number() }),
});

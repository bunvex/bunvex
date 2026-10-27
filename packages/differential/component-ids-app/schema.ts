// The app's tables, numbered in name order: `items` 10001, `messages` 10002.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  items: defineTable({ n: v.number() }),
  messages: defineTable({ text: v.string() }),
});

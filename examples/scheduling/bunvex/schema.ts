import { defineSchema, defineTable } from "bunvex/server";
import { v } from "bunvex/values";

export default defineSchema({
  messages: defineTable({ body: v.string(), author: v.string() }),
});

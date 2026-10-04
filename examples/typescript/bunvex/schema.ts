import { defineSchema, defineTable } from "bunvex/server";
import { v } from "bunvex/values";

// The schema types everything below: `Doc<"messages">`, the functions' `ctx.db`, and the client's results.
export default defineSchema({
  messages: defineTable({
    author: v.string(),
    body: v.string(),
  }),
});

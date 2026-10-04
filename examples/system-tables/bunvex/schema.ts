import { defineSchema, defineTable } from "bunvex/server";
import { v } from "bunvex/values";

export default defineSchema({
  messages: defineTable({
    author: v.string(),
    body: v.string(),
    // An image message's body is its file's id in `_storage`.
    format: v.union(v.literal("text"), v.literal("image")),
  }),
  // Who uploaded which file: the file's own metadata lives in the system table `_storage`.
  uploads: defineTable({
    author: v.string(),
    file: v.id("_storage"),
  }),
});

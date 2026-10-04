import { defineSchema, defineTable } from "bunvex/server";
import { v } from "bunvex/values";

// A message belongs to a channel: it holds the channel's id, and an index over it reads one channel's messages
// without scanning the others.
export default defineSchema({
  channels: defineTable({
    name: v.string(),
  }),
  messages: defineTable({
    channel: v.id("channels"),
    author: v.string(),
    body: v.string(),
  }).index("by_channel", ["channel"]),
});

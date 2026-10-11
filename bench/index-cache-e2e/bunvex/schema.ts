import { defineSchema, defineTable } from "bunvex/server";
import { v } from "bunvex/values";

export default defineSchema({
  channels: defineTable({ name: v.string() }),
  messages: defineTable({ channel: v.id("channels"), body: v.string(), m: v.number() }).index("by_channel", [
    "channel",
  ]),
  users: defineTable({ name: v.string() }),
  settings: defineTable({ maxLen: v.number(), slowMode: v.boolean() }),
});

// The soak app's tables (STUDY-174 §2): a chat with search, a hot counter, a config row read by the cache canary,
// scheduled jobs that record when they ran, and uploaded files.
import { defineSchema, defineTable } from "bunvex/server";
import { v } from "bunvex/values";

export default defineSchema({
  messages: defineTable({ channel: v.string(), author: v.string(), body: v.string() })
    .index("by_channel", ["channel"])
    .searchIndex("search_body", { searchField: "body", filterFields: ["channel"] }),
  counters: defineTable({ name: v.string(), n: v.number() }).index("by_name", ["name"]),
  config: defineTable({ key: v.string(), value: v.number() }).index("by_key", ["key"]),
  jobs: defineTable({ seq: v.number(), dueAt: v.number(), ranAt: v.optional(v.number()), runs: v.number() }).index(
    "by_seq",
    ["seq"],
  ),
  files: defineTable({ storageId: v.id("_storage") }),
});

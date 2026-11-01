// The app's own table, as upstream's client test app has it: what the jobs and callbacks did, by key.
import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";
import { vResult, vWorkId } from "@bunvex/workpool";

export default defineSchema({
  events: defineTable({
    key: v.string(),
    kind: v.union(v.literal("attempt"), v.literal("work"), v.literal("callback")),
    workId: v.optional(vWorkId),
    result: v.optional(vResult),
    context: v.optional(v.any()),
  }).index("key", ["key"]),
});

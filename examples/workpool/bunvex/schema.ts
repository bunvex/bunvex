// One row per job the page started: which pool runs it, how it is going, and how it ended. The pools keep their
// own state in their components' tables; this table is what the page shows.
import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";
import { vWorkId } from "@bunvex/workpool";

export default defineSchema({
  tasks: defineTable({
    pool: v.union(v.literal("big"), v.literal("small"), v.literal("serial")),
    label: v.string(),
    failRate: v.number(),
    workId: v.optional(vWorkId),
    state: v.union(
      v.literal("waiting"),
      v.literal("running"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("canceled"),
    ),
    attempts: v.number(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    error: v.optional(v.string()),
  }).index("pool", ["pool"]),
});

// The rate limiter's tables (STUDY-197 §1.1), with the fields and indexes of Convex's package:
//
// - `rateLimits`: one row per shard of a limit's name and key. No `key` is the limit's one shared value, shard 0 the
//   only shard of an unsharded limit; `value` goes negative when tokens are reserved ahead of time.
// - `pendingUpdates`: the asynchronous mode's queue, in commit order, drained by the batch worker.
import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";
import { vPendingUpdate } from "../shared";

export default defineSchema({
  rateLimits: defineTable({
    name: v.string(),
    key: v.optional(v.string()),
    shard: v.number(),
    value: v.number(),
    ts: v.number(),
  }).index("name", ["name", "key", "shard"]),

  pendingUpdates: defineTable({
    update: vPendingUpdate,
    updatedAt: v.commitTs(),
  }).index("updatedAt", ["updatedAt"]),
});

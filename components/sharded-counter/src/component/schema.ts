// The sharded counter's one table (STUDY-183 §1.1): a row per shard of a named counter, found by `[name, shard]`.
// The fields and the index match Convex's package, so a Convex export of the component's data imports unchanged.
import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";

export default defineSchema({
  counters: defineTable({
    name: v.string(),
    value: v.number(),
    shard: v.number(),
  }).index("name", ["name", "shard"]),
});

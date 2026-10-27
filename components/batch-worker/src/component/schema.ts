// The batch worker's tables (STUDY-196 §1.1), with the fields and index of Convex's package, so a Convex export of
// the component's data imports unchanged:
//
// - `workers`: one row per named worker, its two handles, its config and its run status. It changes only on
//   transitions, so `ping`, called after every insert, reads it without conflicting with the loop.
// - `workerState`: the loop's own row, written every iteration: the generation, the scheduled run, the monitor, the
//   start of the cooldown window and the cursor.
import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";
import { vConfig, vStatus } from "./shared";

export default defineSchema({
  workers: defineTable({
    name: v.string(),
    workQuery: v.string(),
    workerMutation: v.string(),
    config: vConfig.partial(),
    status: vStatus,
    stateId: v.id("workerState"),
  }).index("name", ["name"]),

  workerState: defineTable({
    generation: v.int64(),
    lastWorkTs: v.number(),
    runnerId: v.optional(v.id("_scheduled_functions")),
    monitorId: v.optional(v.id("_scheduled_functions")),
    monitorRunAtMs: v.optional(v.number()),
    cursor: v.optional(v.any()),
  }),
});

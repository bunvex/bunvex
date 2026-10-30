// The example's tables:
//
// - `events`: the work queue, each row a value to sum. `insertedAt` is `ctx.db.vars.commitTs`, an int64 in commit
//   order once the writing mutation commits, and indexed, so the worker resumes from its cursor instead of scanning
//   the deleted rows at the front of the table.
// - `totals`: one row, the running total the worker keeps.
// - `scoreEvents` and `teamTotals`: scores, never deleted, folded into per-team totals by a single writer.
// - `llmRequests`: prompts for the rate-limited worker, pending, then started, then finished. Its index leads with
//   the state, so the work query scans the pending range from its cursor.
import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";

export default defineSchema({
  events: defineTable({
    value: v.number(),
    insertedAt: v.commitTs(),
  }).index("insertedAt", ["insertedAt"]),
  totals: defineTable({
    key: v.string(),
    total: v.number(),
    count: v.number(),
  }).index("key", ["key"]),

  scoreEvents: defineTable({
    team: v.string(),
    points: v.number(),
    insertedAt: v.commitTs(),
  }).index("insertedAt", ["insertedAt"]),
  teamTotals: defineTable({ team: v.string(), total: v.number() }).index("team", ["team"]),

  llmRequests: defineTable({
    prompt: v.string(),
    inputTokens: v.number(),
    state: v.union(v.literal("pending"), v.literal("started"), v.literal("finished")),
    updatedAt: v.commitTs(),
    startedAt: v.optional(v.number()),
    response: v.optional(v.string()),
    outputTokens: v.optional(v.number()),
  }).index("state_updatedAt", ["state", "updatedAt"]),
});

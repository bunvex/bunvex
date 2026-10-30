// The pool's tables (STUDY-199 §1.4), with the fields and indexes of Convex's workpool 0.4.14, so a Convex export of
// the component's data imports unchanged:
//
// - `globals`: the pool's config, one row, written by enqueue, cancel and `config:update`;
// - `internalState`: the loop's own row, written only by `loop:run`: cursors, the last recovery, the report's
//   counters and the running jobs. `generation` is no longer used (the batch worker owns it) and is still written
//   as 0n, as Convex's is; `report.conflicted` is accepted and never written;
// - `work`: one row per job until it ends;
// - `pendingStart`, `pendingCompletion`, `pendingCancelation`: the queues the loop drains, each by segment;
// - `payload`: arguments or an `onComplete` context too large to keep on the `work` row.
import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";
import { fnType, retryBehavior, vConfig, vOnCompleteFnContext, vResult } from "./shared";

const segment = v.int64();

export default defineSchema({
  globals: defineTable(vConfig),

  internalState: defineTable({
    generation: v.optional(v.int64()),
    segmentCursors: v.object({
      incoming: segment,
      completion: segment,
      cancelation: segment,
    }),
    lastRecovery: segment,
    report: v.object({
      // Every attempt that finished, retried ones included.
      completed: v.number(),
      succeeded: v.number(),
      // Failed with no retry left.
      failed: v.number(),
      // Failed and retried.
      retries: v.number(),
      canceled: v.number(),
      conflicted: v.optional(v.number()),
      lastReportTs: v.number(),
    }),
    running: v.array(
      v.object({
        workId: v.id("work"),
        scheduledId: v.id("_scheduled_functions"),
        started: v.number(),
      }),
    ),
  }),

  work: defineTable({
    fnType,
    fnHandle: v.string(),
    fnName: v.string(),
    fnArgs: v.optional(v.any()),
    payloadId: v.optional(v.id("payload")),
    payloadSize: v.optional(v.number()),
    // Attempts that have finished.
    attempts: v.number(),
    onComplete: v.optional(vOnCompleteFnContext),
    retryBehavior: v.optional(retryBehavior),
    canceled: v.optional(v.boolean()),
  }),

  pendingStart: defineTable({
    workId: v.id("work"),
    segment,
  })
    .index("workId", ["workId"])
    .index("segment", ["segment"]),

  pendingCompletion: defineTable({
    segment,
    runResult: vResult,
    workId: v.id("work"),
    retry: v.boolean(),
  })
    .index("workId", ["workId"])
    .index("segment", ["segment"]),

  pendingCancelation: defineTable({
    segment,
    workId: v.id("work"),
  })
    .index("workId", ["workId"])
    .index("segment", ["segment"]),

  payload: defineTable({
    args: v.optional(v.record(v.string(), v.any())),
    context: v.optional(v.any()),
  }),
});

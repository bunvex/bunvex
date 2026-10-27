// The app's tables for test/batch-worker.test.ts: a queue drained by deleting (`items`, each batch logged in
// `batches`), and marks scanned by an advancing cursor and never deleted (`marks`, logged in `markBatches`).
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  items: defineTable({ value: v.number() }),
  batches: defineTable({ values: v.array(v.number()) }),
  marks: defineTable({ seq: v.int64() }).index("seq", ["seq"]),
  markBatches: defineTable({ seqs: v.array(v.int64()) }),
});

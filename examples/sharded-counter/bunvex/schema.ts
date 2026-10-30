import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";

export default defineSchema({
  users: defineTable({
    name: v.string(),
  }),
  backfillCursor: defineTable({
    creationTime: v.number(),
    id: v.string(),
    isDone: v.boolean(),
  }),
  // A million checkboxes, 4,000 to a document, one bit each.
  checkboxes: defineTable({
    idx: v.number(),
    boxes: v.bytes(),
  }).index("idx", ["idx"]),
});

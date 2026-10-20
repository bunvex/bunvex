// The schema of the backfill progress test (STUDY-174 S1): one table, no index yet. The test's second deploy adds
// `by_n`, which the backend backfills over the documents already there.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  items: defineTable({ n: v.number() }),
});

// The tables of test/helpers-stream.test.ts (STUDY-181 PR 3): items whose index keys mix every value type and a
// missing field, and groups to flatMap over.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const key = v.optional(
  v.union(
    v.null(),
    v.boolean(),
    v.int64(),
    v.number(),
    v.string(),
    v.bytes(),
    v.array(v.number()),
    v.object({ tag: v.number() }),
  ),
);

export default defineSchema({
  items: defineTable({ n: v.number(), g: v.number(), k: key }).index("k_g", ["k", "g"]).index("g_k", ["g", "k"]),
  groups: defineTable({ n: v.number(), g: v.number() }).index("g", ["g"]),
});

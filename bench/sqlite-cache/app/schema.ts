// STUDY-174 Q6's read bench: one table of ~1 KB documents, in 1 000 groups, with a compound index.
import { defineSchema, defineTable } from "bunvex/server";
import { v } from "bunvex/values";

export default defineSchema({
  items: defineTable({ group: v.number(), n: v.number(), body: v.string() }).index("by_group_n", ["group", "n"]),
});

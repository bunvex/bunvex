// The schema the push-without-schema test (STUDY-187 X3 follow-up) starts with; the test then deploys the app
// without this file, and with it again.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  items: defineTable({ n: v.number() }).index("by_n", ["n"]),
  wide: defineTable(v.any()),
});

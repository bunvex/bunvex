// The first schema of the `_schemas` rows test (STUDY-187 X3): one table. The test deploys the next ones itself.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  items: defineTable({ n: v.number() }),
});

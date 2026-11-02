// The anonymous accounts (STUDY-201 §1.8), v2's table: an id per account, no index.
import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";

export default defineSchema({
  accounts: defineTable({
    anonymousId: v.string(),
  }),
});

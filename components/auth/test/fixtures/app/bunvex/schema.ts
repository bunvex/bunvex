import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";

export default defineSchema({
  users: defineTable({ method: v.string() }),
  signIns: defineTable({ userId: v.id("users"), method: v.string() }),
});

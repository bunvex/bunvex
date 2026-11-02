import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({ method: v.string() }),
  signIns: defineTable({ userId: v.id("users"), method: v.string() }),
});

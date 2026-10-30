// The `onEmailEvent` callbacks the app received, in order.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  events: defineTable({ id: v.string(), type: v.string(), event: v.any() }),
});

// The table the subscription reads and the mutation writes.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({ messages: defineTable({ body: v.string() }) });

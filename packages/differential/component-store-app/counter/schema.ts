// A component's tables: `messages` has the root's name, `counters` is its own; numbered 10001 and 10002 in the
// component's namespace, as the root's are in its own.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  messages: defineTable({ body: v.string(), n: v.number() }).index("by_n", ["n"]),
  counters: defineTable({ name: v.string(), value: v.number() }).index("by_name", ["name"]),
});

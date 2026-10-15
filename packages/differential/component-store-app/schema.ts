// The component store app (STUDY-152 steps 1–2): the root's `messages`, the same name as a table of the `counter`
// component (counter/), which convex.config.ts mounts twice. Only Convex deploys the components; bunvex's deploy
// leaves out convex.config.ts and seed.ts (component-store.test.ts).
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  messages: defineTable({ text: v.string() }).index("by_text", ["text"]),
});

// The usernames (STUDY-201 §1.7), v2's table: the spelling the user gave and its normalized form, which the code keeps
// unique (no index enforces it).
import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";

export default defineSchema({
  usernames: defineTable({
    userId: v.string(),
    username: v.string(),
    usernameNormalized: v.string(),
  })
    .index("by_userId", ["userId"])
    .index("by_usernameNormalized", ["usernameNormalized"]),
});

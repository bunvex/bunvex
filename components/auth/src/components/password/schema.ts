// The passwords (STUDY-201 §1.6), v2's table: one per user, its hash as a PHC string
// (https://github.com/C2SP/C2SP/blob/main/phc-strings.md).
import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";

export default defineSchema({
  passwords: defineTable({
    userId: v.string(),
    passwordHashPHC: v.string(),
  }).index("by_userId", ["userId"]),
});

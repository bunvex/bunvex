// The schema of the custom functions' test app (STUDY-181 PR 2): convex-helpers' `customFunctions.test.ts` schema,
// and `calls`, where `onSuccess` callbacks leave a trace the tests read.
import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";

export default defineSchema({
  users: defineTable({ tokenIdentifier: v.string() }).index("tokenIdentifier", ["tokenIdentifier"]),
  calls: defineTable({ kind: v.string(), result: v.any() }),
});

// The anonymous accounts (STUDY-201 §1.8, STUDY-208 §1.14), v2.0.0's table: one row per anonymous user, its app user
// id. An anonymous identity is never signed in again, so nothing looks these rows up, and the table has no index.
import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";

export default defineSchema({
  accounts: defineTable({
    userId: v.string(),
  }),
});

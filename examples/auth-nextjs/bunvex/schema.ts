import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";

export default defineSchema({
  // One row per account. The auth components keep the username and the password; put the user's profile here.
  users: defineTable({ signedUpAt: v.number() }),
});

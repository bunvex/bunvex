import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";

export default defineSchema({
  // One row per anonymous user: a new one at each sign-in.
  users: defineTable({ visits: v.number() }),
});

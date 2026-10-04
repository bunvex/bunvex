import { defineSchema, defineTable } from "bunvex/server";
import { v } from "bunvex/values";

export default defineSchema({
  messages: defineTable({ body: v.string(), user: v.id("users") }),
  // One row per signed-in identity, found by the token's `tokenIdentifier` (issuer and subject).
  users: defineTable({ name: v.string(), tokenIdentifier: v.string() }).index("by_token", ["tokenIdentifier"]),
});

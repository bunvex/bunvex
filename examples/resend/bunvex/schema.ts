// The emails the page sent (the component keeps their full state; this is what the page lists) and every event
// Resend's webhook reported for them.

import { vEmailId } from "@bunvex/resend";
import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";

export default defineSchema({
  sent: defineTable({ emailId: vEmailId, to: v.string(), subject: v.string() }).index("emailId", ["emailId"]),
  events: defineTable({ emailId: vEmailId, type: v.string(), at: v.string() }).index("emailId", ["emailId"]),
});

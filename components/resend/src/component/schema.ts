// The component's tables (STUDY-200 §1.4), with the fields and indexes of Convex's resend 0.2.10, so a Convex export
// of its data imports unchanged:
//
// - `emails`: one row per email. `to` is a string only in rows older versions wrote; `segment` is the send-request
//   segment (`Infinity` for an email sent by hand); `finalizedAt` is `Number.MAX_SAFE_INTEGER` until the email is
//   final. The optional flags come from older versions; every writer sets them;
// - `content`: an email's bodies, as bytes (`filename` and `path` are never written);
// - `deliveryEvents`: one row per webhook event accepted for a known email, repeats included;
// - `lastOptions`: one row, the last sender's options (API key, retries, the `onEmailEvent` handle);
// - `nextBatchRun`: one row while the batcher runs; its `runId` is the first run of the busy period.
import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";
import { vEventType, vOptions, vStatus, vTemplate } from "./shared.ts";

const nameValue = v.object({ name: v.string(), value: v.string() });

export default defineSchema({
  content: defineTable({
    content: v.bytes(),
    mimeType: v.string(),
    filename: v.optional(v.string()),
    path: v.optional(v.string()),
  }),
  nextBatchRun: defineTable({
    runId: v.id("_scheduled_functions"),
  }),
  lastOptions: defineTable({
    options: vOptions,
  }),
  deliveryEvents: defineTable({
    emailId: v.id("emails"),
    resendId: v.string(),
    eventType: vEventType,
    createdAt: v.string(),
    message: v.optional(v.string()),
  }).index("by_emailId_eventType", ["emailId", "eventType"]),
  emails: defineTable({
    from: v.string(),
    to: v.union(v.array(v.string()), v.string()),
    cc: v.optional(v.array(v.string())),
    bcc: v.optional(v.array(v.string())),
    subject: v.optional(v.string()),
    replyTo: v.array(v.string()),
    html: v.optional(v.id("content")),
    text: v.optional(v.id("content")),
    template: v.optional(vTemplate),
    headers: v.optional(v.array(nameValue)),
    status: vStatus,
    complained: v.boolean(),
    errorMessage: v.optional(v.string()),
    opened: v.boolean(),
    bounced: v.optional(v.boolean()),
    failed: v.optional(v.boolean()),
    deliveryDelayed: v.optional(v.boolean()),
    clicked: v.optional(v.boolean()),
    resendId: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
    segment: v.number(),
    finalizedAt: v.number(),
  })
    .index("by_status_segment", ["status", "segment"])
    .index("by_resendId", ["resendId"])
    .index("by_idempotencyKey", ["idempotencyKey"])
    .index("by_finalizedAt", ["finalizedAt"]),
});

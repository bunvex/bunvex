// Sending email with the component:
// - `send` queues an email; the component sends it to Resend in a batch about a second later, within Resend's rate
//   limit, retrying what fails for a while;
// - `cancel` stops one that has not gone out yet;
// - `onEmailEvent` hears what Resend reports through the webhook (http.ts): delivered, bounced, opened, clicked…
//
// The deployment needs `RESEND_API_KEY` to send, and `RESEND_WEBHOOK_SECRET` for the webhook. In test mode (the
// default), only Resend's test addresses are accepted: delivered@resend.dev, bounced@resend.dev, complained@resend.dev.
import { Resend, vEmailId, vOnEmailEventArgs } from "@bunvex/resend";
import { v } from "@bunvex/values";
import { components, internal } from "./_generated/api.js";
import { internalMutation, mutation, query } from "./_generated/server.js";

export const resend: Resend = new Resend(components.resend, {
  onEmailEvent: internal.emails.onEmailEvent,
});

export const FROM = "bunvex example <onboarding@resend.dev>";

/** Queue an email to `to`; the component sends it in its next batch. */
export const send = mutation({
  args: { to: v.string(), subject: v.string(), text: v.string() },
  handler: async (ctx, { to, subject, text }) => {
    const emailId = await resend.sendEmail(ctx, { from: FROM, to, subject, text });
    await ctx.db.insert("sent", { emailId, to, subject });
    return emailId;
  },
});

/** Stop an email that has not gone out yet. */
export const cancel = mutation({
  args: { emailId: vEmailId },
  handler: async (ctx, { emailId }) => {
    await resend.cancelEmail(ctx, emailId);
  },
});

/**
 * Track an email your own code sent through Resend (with its SDK, say): the component records it as sent with the id
 * Resend gave it, so the webhook's events for it are heard too.
 */
export const trackSent = internalMutation({
  args: { to: v.string(), subject: v.string(), resendId: v.string() },
  handler: async (ctx, { to, subject, resendId }) => {
    const emailId = await resend.sendEmailManually(ctx, { from: FROM, to, subject }, async () => resendId);
    await ctx.db.insert("sent", { emailId, to, subject });
    return emailId;
  },
});

/** Every event Resend reports for an email, in the order they arrive. */
export const onEmailEvent = internalMutation({
  args: vOnEmailEventArgs,
  handler: async (ctx, { id, event }) => {
    await ctx.db.insert("events", { emailId: id, type: event.type, at: event.created_at });
  },
});

/** The latest emails with their status and the events heard so far. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("sent").order("desc").take(20);
    return Promise.all(
      rows.map(async (row) => {
        const status = await resend.status(ctx, row.emailId);
        const events = await ctx.db
          .query("events")
          .withIndex("emailId", (q) => q.eq("emailId", row.emailId))
          .collect();
        return {
          emailId: row.emailId,
          to: row.to,
          subject: row.subject,
          status: status?.status ?? "gone",
          errorMessage: status?.errorMessage ?? null,
          opened: status?.opened ?? false,
          events: events.map((e) => e.type),
        };
      }),
    );
  },
});

// The component keeps every email until it is cleaned up: once an hour, finished emails older than a week go, and
// so does anything older than a month.
import { cronJobs } from "@bunvex/server";
import { components, internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";

const WEEK = 7 * 24 * 60 * 60 * 1000;

export const cleanup = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, components.resend.lib.cleanupOldEmails, { olderThan: WEEK });
    await ctx.scheduler.runAfter(0, components.resend.lib.cleanupAbandonedEmails, {});
  },
});

const crons = cronJobs();
crons.interval("remove old emails", { hours: 1 }, internal.crons.cleanup);
export default crons;

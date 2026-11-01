// Manual cleanup (STUDY-199 §1.14), as Convex's workpool has it: two internal mutations to run from the dashboard or
// the CLI. Each walks its table newest first from a cutoff (a day ago by default), deletes up to 100 rows or 4 MB,
// and schedules itself for the rest. They log with the plain console, and touch neither the running jobs nor any
// `onComplete`.
import { v, valueSize } from "@bunvex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

const DEFAULT_OLDER_THAN = 1000 * 60 * 60 * 24;
const MAX_ROWS_READ = 100;
const MAX_BYTES_READ = 4_000_000;

const cutoffArgs = { olderThan: v.optional(v.number()), before: v.optional(v.number()) };
const cutoff = (args: { olderThan?: number; before?: number }) =>
  args.before ?? Date.now() - (args.olderThan ?? DEFAULT_OLDER_THAN);

export const clearPending = internalMutation({
  args: cutoffArgs,
  handler: async (ctx, args) => {
    const time = cutoff(args);
    let read = 0;
    let bytes = 0;
    let resumeAt: number | undefined;
    console.log("Clearing pending before", new Date(time).toUTCString());
    const entries = ctx.db
      .query("pendingStart")
      .withIndex("by_creation_time", (q) => q.lte("_creationTime", time))
      .order("desc");
    for await (const entry of entries) {
      read++;
      const work = await ctx.db.get("work", entry.workId);
      bytes += valueSize(entry) + valueSize(work) + (work?.payloadSize ?? 0);
      if (read > MAX_ROWS_READ || bytes > MAX_BYTES_READ) {
        resumeAt = entry._creationTime;
        console.log(`Continuing after ${read} entries, ${bytes} bytes`);
        break;
      }
      await ctx.db.delete("pendingStart", entry._id);
      if (work) {
        if (work.payloadId) await ctx.db.delete("payload", work.payloadId);
        await ctx.db.delete("work", work._id);
      }
    }
    if (resumeAt !== undefined) {
      await ctx.scheduler.runAfter(0, internal.danger.clearPending, { before: resumeAt });
    } else {
      console.log(`Done clearing pending entries. ${read} in the last batch.`);
    }
  },
});

export const clearOldWork = internalMutation({
  args: cutoffArgs,
  handler: async (ctx, args) => {
    const time = cutoff(args);
    let read = 0;
    let bytes = 0;
    let resumeAt: number | undefined;
    console.log("Clearing old work before", new Date(time).toUTCString());
    const entries = ctx.db
      .query("work")
      .withIndex("by_creation_time", (q) => q.lte("_creationTime", time))
      .order("desc");
    for await (const entry of entries) {
      read++;
      const pendingStart = await ctx.db
        .query("pendingStart")
        .withIndex("workId", (q) => q.eq("workId", entry._id))
        .unique();
      const pendingCompletion = await ctx.db
        .query("pendingCompletion")
        .withIndex("workId", (q) => q.eq("workId", entry._id))
        .unique();
      const pendingCancelation = await ctx.db
        .query("pendingCancelation")
        .withIndex("workId", (q) => q.eq("workId", entry._id))
        .unique();
      bytes +=
        valueSize(entry) +
        valueSize(pendingStart) +
        valueSize(pendingCompletion) +
        valueSize(pendingCancelation) +
        (entry.payloadSize ?? 0);
      if (read > MAX_ROWS_READ || bytes > MAX_BYTES_READ) {
        resumeAt = entry._creationTime;
        console.log(`Continuing after ${read} entries, ${bytes} bytes`);
        break;
      }
      if (pendingStart) await ctx.db.delete("pendingStart", pendingStart._id);
      if (pendingCompletion) await ctx.db.delete("pendingCompletion", pendingCompletion._id);
      if (pendingCancelation) await ctx.db.delete("pendingCancelation", pendingCancelation._id);
      if (entry.payloadId) await ctx.db.delete("payload", entry.payloadId);
      const found = Object.entries({ pendingStart, pendingCompletion, pendingCancelation })
        .filter(([, row]) => row !== null)
        .map(([name]) => name);
      console.debug(`cleared ${entry.fnName}: ${entry.fnArgs} (${found.join(", ")})`);
      await ctx.db.delete("work", entry._id);
    }
    if (resumeAt !== undefined) {
      await ctx.scheduler.runAfter(0, internal.danger.clearOldWork, { before: resumeAt });
    } else {
      console.log(`Done clearing old work. ${read} in the last batch.`);
    }
  },
});

import { v } from "bunvex/values";
import { mutation, query } from "./_generated/server";

/** Every scheduled send, with its state (pending, inProgress, success, failed, canceled): `db.system`. */
export const scheduledSends = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.system.query("_scheduled_functions").collect();
  },
});

/** Cancel a scheduled send that has not run yet. */
export const cancelSend = mutation({
  args: { job: v.id("_scheduled_functions") },
  handler: async (ctx, { job }) => {
    await ctx.scheduler.cancel(job);
  },
});

/** Every upload: its file's metadata from `_storage` (size, sha256, content type), and who uploaded it. */
export const files = query({
  args: {},
  handler: async (ctx) => {
    const uploads = await ctx.db.query("uploads").collect();
    const files = [];
    for (const upload of uploads) {
      const metadata = await ctx.db.system.get(upload.file);
      if (metadata !== null) files.push({ ...metadata, author: upload.author });
    }
    return files;
  },
});

// File storage: an upload URL, a stored file's row, its URL, and its deletion (the soak keeps none for long).
import { mutationGeneric, queryGeneric } from "bunvex/server";
import { v } from "bunvex/values";

export const uploadUrl = mutationGeneric({ args: {}, handler: async (ctx) => ctx.storage.generateUploadUrl() });

export const save = mutationGeneric({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => ctx.db.insert("files", { storageId }),
});

export const url = queryGeneric({
  args: { id: v.id("files") },
  handler: async (ctx, { id }) => {
    const f = await ctx.db.get(id);
    return f ? ctx.storage.getUrl(f.storageId) : null;
  },
});

export const remove = mutationGeneric({
  args: { id: v.id("files") },
  handler: async (ctx, { id }) => {
    const f = await ctx.db.get(id);
    if (!f) return;
    await ctx.storage.delete(f.storageId);
    await ctx.db.delete(id);
  },
});

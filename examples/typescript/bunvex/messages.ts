import { v } from "bunvex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";

/** Every message, oldest first. The return type is the table's document type, from the schema. */
export const list = query({
  args: {},
  handler: async (ctx): Promise<Doc<"messages">[]> => {
    return await ctx.db.query("messages").collect();
  },
});

/** Post a message: `args` types the handler's arguments, and the client's call. */
export const send = mutation({
  args: { body: v.string(), author: v.string() },
  handler: async (ctx, { body, author }): Promise<Id<"messages">> => {
    const message: Omit<Doc<"messages">, "_id" | "_creationTime"> = { body, author };
    return await ctx.db.insert("messages", message);
  },
});

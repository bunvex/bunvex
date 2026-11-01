import { BunvexError, v } from "@bunvex/values";
import { action, mutation } from "./_generated/server";

/** Post a message; an empty one is refused with an error the client can show. */
export const send = mutation({
  args: { body: v.string(), author: v.string() },
  handler: async (ctx, message) => {
    if (message.body.trim() === "") throw new BunvexError("A message needs some text");
    await ctx.db.insert("messages", message);
  },
});

/** Ask an assistant: the service's address comes from the deployment's `ASSISTANT_URL` variable. */
export const ask = action({
  args: { prompt: v.string() },
  handler: async (_ctx, { prompt }): Promise<string> => {
    const url = process.env.ASSISTANT_URL;
    if (!url) throw new Error("Set ASSISTANT_URL to the assistant's address");
    const response = await fetch(url, { method: "POST", body: prompt });
    return await response.text();
  },
});

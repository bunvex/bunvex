import { BunvexError, v } from "bunvex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, mutation, query } from "./_generated/server";

/** Every message, oldest first: text, or a GIF's embed URL. */
export const list = query({
  args: {},
  handler: async (ctx) => await ctx.db.query("messages").collect(),
});

/** Post a text message. */
export const send = mutation({
  args: { body: v.string(), author: v.string() },
  handler: async (ctx, { body, author }) => {
    await ctx.db.insert("messages", { body, author, format: "text" });
  },
});

// Giphy's API; GIPHY_BASE_URL points elsewhere (the end-to-end test's stand-in).
const giphyApi = () => process.env.GIPHY_BASE_URL ?? "https://api.giphy.com";

/** A deployment variable the example needs: missing, a message saying how to set it (shown in the page). */
function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new BunvexError(
      `${name} is not set: run \`bunx bunvex env set ${name} <value>\` in this example's directory.`,
    );
  return value;
}

/**
 * Post the GIF Giphy picks for `queryString`. An action, since it calls another service (queries and
 * mutations cannot); it then posts the message through an internal mutation.
 */
export const sendGif = action({
  args: { queryString: v.string(), author: v.string() },
  handler: async (ctx, { queryString, author }) => {
    const url = new URL("/v1/gifs/translate", giphyApi());
    url.searchParams.set("api_key", required("GIPHY_KEY"));
    url.searchParams.set("s", queryString);
    const response = await fetch(url);
    const json = (await response.json()) as { data?: { embed_url?: string } };
    if (!response.ok || !json.data?.embed_url) throw new Error(`Giphy failed: ${JSON.stringify(json)}`);
    await ctx.runMutation(internal.messages.sendGifMessage, { body: json.data.embed_url, author });
  },
});

/** The GIF message itself: internal, so only `sendGif` posts one. */
export const sendGifMessage = internalMutation({
  args: { body: v.string(), author: v.string() },
  handler: async (ctx, { body, author }) => {
    await ctx.db.insert("messages", { body, author, format: "giphy" });
  },
});

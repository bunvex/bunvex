import { v } from "bunvex/values";
import { api } from "./_generated/api";
import { type ActionCtx, httpAction, mutation, query } from "./_generated/server";

/** Every message, oldest first. */
export const list = query({
  args: {},
  handler: async (ctx) => await ctx.db.query("messages").collect(),
});

/** Post a message. */
export const send = mutation({
  args: { body: v.string(), author: v.string() },
  handler: async (ctx, { body, author }) => {
    await ctx.db.insert("messages", { body, author });
  },
});

/** `POST /postMessage` with a JSON body `{ author, body }`: posts it, marked as coming over HTTP. */
export const postMessage = httpAction(async (ctx, request) => {
  const { author, body } = (await request.json()) as { author: string; body: string };
  await ctx.runMutation(api.messages.send, { body: `Sent over HTTP: ${body}`, author });
  return new Response(null, { status: 200 });
});

/** The messages of `User <n>`, as JSON. */
async function messagesOf(ctx: ActionCtx, n: string): Promise<Response> {
  const messages = await ctx.runQuery(api.messages.list, {});
  const theirs = messages.filter((m) => m.author === `User ${n}`).map(({ body, author }) => ({ body, author }));
  return Response.json(theirs);
}

/** `GET /getMessagesByAuthor?authorNumber=<n>` (or an `authorNumber` header). */
export const getByAuthor = httpAction(async (ctx, request) => {
  const n = new URL(request.url).searchParams.get("authorNumber") ?? request.headers.get("authorNumber");
  if (n === null) return new Response("Give authorNumber as a query parameter or a header", { status: 400 });
  return await messagesOf(ctx, n);
});

/** `GET /getAuthorMessages/<n>`: the author's number is the path's last segment. */
export const getByAuthorPathSuffix = httpAction(async (ctx, request) => {
  const n = new URL(request.url).pathname.split("/").at(-1);
  if (!n) return new Response("The path must be /getAuthorMessages/<authorNumber>", { status: 400 });
  return await messagesOf(ctx, n);
});

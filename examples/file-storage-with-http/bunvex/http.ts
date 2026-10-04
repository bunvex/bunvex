import { httpRouter } from "bunvex/server";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction } from "./_generated/server";

// The website allowed to call these routes from a browser (CORS): the deployment's CLIENT_ORIGIN variable,
// e.g. `bunvex env set CLIENT_ORIGIN http://localhost:5173`.
const clientOrigin = () => process.env.CLIENT_ORIGIN ?? "";

const http = httpRouter();

// `POST /sendImage?author=<name>` with the image as the body: store the file, then post it as a message.
http.route({
  path: "/sendImage",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const author = new URL(request.url).searchParams.get("author");
    if (author === null) return new Response("The author query parameter is required", { status: 400 });
    const storageId = await ctx.storage.store(await request.blob());
    await ctx.runMutation(api.messages.sendImage, { storageId, author });
    return new Response(null, {
      status: 200,
      headers: { "Access-Control-Allow-Origin": clientOrigin(), Vary: "origin" },
    });
  }),
});

// `GET /getImage?storageId=<id>`: the stored file's bytes.
http.route({
  path: "/getImage",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const storageId = new URL(request.url).searchParams.get("storageId") as Id<"_storage">;
    const blob = await ctx.storage.get(storageId);
    if (blob === null) return new Response("Image not found", { status: 404 });
    return new Response(blob);
  }),
});

// The browser's preflight for `POST /sendImage` from another origin.
http.route({
  path: "/sendImage",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => {
    const h = request.headers;
    const isPreflight =
      h.get("Origin") !== null &&
      h.get("Access-Control-Request-Method") !== null &&
      h.get("Access-Control-Request-Headers") !== null;
    if (!isPreflight) return new Response();
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": clientOrigin(),
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type, Digest",
        "Access-Control-Max-Age": "86400",
      },
    });
  }),
});

export default http;

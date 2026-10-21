// What an HTTP action leaves when its response's body ends (owner, 2026-10-21): Convex's isolate runs until the body's
// stream ends, then shuts its tasks down (environment/action/mod.rs `run_inner`), so a timer still pending, an
// interval and an operation's continuation write nothing after it, while what the body's own code does as it streams
// works.
import { httpActionGeneric, httpRouter, makeFunctionReference } from "convex/server";

const insRef = makeFunctionReference<"mutation">("ends:ins");
const rowsRef = makeFunctionReference<"query">("ends:rows");

const tagOf = (req: Request) => new URL(req.url).searchParams.get("tag")!;
const http = httpRouter();

/** A timer still pending when the handler answers with a whole body. */
http.route({
  path: "/leftTimer",
  method: "GET",
  handler: httpActionGeneric(async (ctx, req) => {
    const tag = tagOf(req);
    setTimeout(() => void ctx.runMutation(insRef, { tag }).catch(() => {}), 100);
    return new Response("answered");
  }),
});

/** An interval that writes while the handler runs, left running when it answers. */
http.route({
  path: "/interval",
  method: "GET",
  handler: httpActionGeneric(async (ctx, req) => {
    const tag = tagOf(req);
    setInterval(() => void ctx.runMutation(insRef, { tag }).catch(() => {}), 40);
    await new Promise((r) => setTimeout(r, 150));
    return new Response("answered");
  }),
});

/** An operation's continuation, after the handler answered. */
http.route({
  path: "/continuation",
  method: "GET",
  handler: httpActionGeneric(async (ctx, req) => {
    const tag = tagOf(req);
    void ctx
      .runQuery(rowsRef, { tag, nonce: Math.random() })
      .then(() => new Promise((r) => setTimeout(r, 50)))
      .then(() => ctx.runMutation(insRef, { tag }))
      .catch(() => {});
    return new Response("answered");
  }),
});

/**
 * A streamed body whose pulls wait on a timer and write before each chunk (the body's code runs after the handler
 * returned), and whose last pull leaves a timer as it closes the stream.
 */
http.route({
  path: "/stream",
  method: "GET",
  handler: httpActionGeneric(async (ctx, req) => {
    const tag = tagOf(req);
    let n = 0;
    return new Response(
      new ReadableStream({
        async pull(c) {
          await new Promise((r) => setTimeout(r, 20));
          if (n++ === 2) {
            setTimeout(() => void ctx.runMutation(insRef, { tag }).catch(() => {}), 100);
            c.close();
            return;
          }
          await ctx.runMutation(insRef, { tag });
          c.enqueue(new TextEncoder().encode("x"));
        },
      }),
    );
  }),
});

export default http;

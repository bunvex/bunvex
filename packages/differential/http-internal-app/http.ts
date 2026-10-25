// HTTP routes for the internal-error test (STUDY-171 §14.6 Q-PR6-3), each logging a line first:
// - `system`: a system error in the HTTP action itself. On Convex's backend, its runtime's op called with no name
//   (`op(op_name, ...) takes at least one argument`: an `anyhow` error with no `ErrorMetadata`, which terminates the
//   isolate as a system error). bunvex's runtime has no such global; there the same nested query as `nested` fails
//   the run with its system error (DV-209), which reaches the server as the executor's failures do.
// - `nested`: the query that fails with a system error, called and not caught.
// - `caught`: the same, caught, its message answered.
// - `thrown`: the app's own error, for contrast.
import { httpActionGeneric, httpRouter, makeFunctionReference } from "convex/server";

const emptyPage = makeFunctionReference<"query">("ops:emptyPage");

// biome-ignore lint/suspicious/noExplicitAny: the handler's ctx
const routes: Record<string, (ctx: any) => Promise<Response>> = {
  system: async (ctx) => {
    // biome-ignore lint/suspicious/noExplicitAny: Convex's runtime global, absent on bunvex
    const runtime = (globalThis as any).Convex;
    if (runtime) runtime.op();
    else await ctx.runQuery(emptyPage, {});
    return new Response("unreachable");
  },
  nested: async (ctx) => {
    await ctx.runQuery(emptyPage, {});
    return new Response("unreachable");
  },
  caught: async (ctx) => {
    try {
      await ctx.runQuery(emptyPage, {});
      return new Response("not thrown");
    } catch (e) {
      return new Response(`caught: ${(e as Error).message}`);
    }
  },
  thrown: async () => {
    throw new Error("the app's own");
  },
};

const http = httpRouter();
http.route({
  pathPrefix: "/internal/",
  method: "GET",
  handler: httpActionGeneric(async (ctx, req) => {
    const kind = new URL(req.url).pathname.slice("/internal/".length);
    console.log(`running ${kind}`);
    return routes[kind]!(ctx);
  }),
});
export default http;

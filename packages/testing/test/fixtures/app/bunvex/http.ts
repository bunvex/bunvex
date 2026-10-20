import { httpAction, httpRouter, makeFunctionReference } from "@bunvex/server";

const http = httpRouter();
http.route({
  path: "/count",
  method: "GET",
  handler: httpAction(async (ctx) => {
    const list = (await ctx.runQuery(makeFunctionReference<"query">("messages:list"), {})) as string[];
    return new Response(String(list.length));
  }),
});
http.route({
  path: "/whoami",
  method: "GET",
  handler: httpAction(async (ctx) => new Response(JSON.stringify((await ctx.auth.getUserIdentity())?.name ?? null))),
});
export default http;

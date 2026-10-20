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
export default http;

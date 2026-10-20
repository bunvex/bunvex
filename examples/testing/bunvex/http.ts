import { httpRouter } from "bunvex/server";
import { httpAction } from "./_generated/server";

const http = httpRouter();
http.route({
  path: "/hello",
  method: "POST",
  handler: httpAction(async (ctx) => {
    const user = await ctx.auth.getUserIdentity();
    return new Response(`Hello, ${user?.name ?? "stranger"}!`);
  }),
});
export default http;

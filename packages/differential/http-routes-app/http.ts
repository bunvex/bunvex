// HTTP routes for the log identity test (STUDY-31 §7): an exact route, prefix routes (two methods on one
// prefix, a longer prefix inside another), and prefix routes that fail: a throw, a throw after an await, a
// run past the action timeout. Every handler logs a line first, so its Progress entries show.
import { httpActionGeneric, httpRouter } from "convex/server";

const http = httpRouter();
const answer = (word: string) =>
  httpActionGeneric(async (_ctx, req) => {
    console.log(`${word} ${new URL(req.url).pathname}`);
    return new Response(word);
  });
http.route({ path: "/hello", method: "GET", handler: answer("hello") });
http.route({ pathPrefix: "/files/", method: "GET", handler: answer("get") });
http.route({ pathPrefix: "/files/", method: "POST", handler: answer("post") });
http.route({ pathPrefix: "/files/deep/", method: "GET", handler: answer("deep") });
http.route({
  pathPrefix: "/fail/",
  method: "GET",
  handler: httpActionGeneric(async () => {
    console.log("about to fail");
    throw new Error("boom");
  }),
});
http.route({
  pathPrefix: "/late/",
  method: "GET",
  handler: httpActionGeneric(async () => {
    console.log("about to fail later");
    await new Promise((r) => setTimeout(r, 10));
    throw new Error("late boom");
  }),
});
http.route({
  pathPrefix: "/slow/",
  method: "GET",
  handler: httpActionGeneric(async () => {
    console.log("sleeping");
    await new Promise((r) => setTimeout(r, 10_000));
    return new Response("too late");
  }),
});
export default http;

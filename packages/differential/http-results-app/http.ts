// HTTP routes for the non-Response test (STUDY-31 §9): a handler that returns something other than a Response —
// an object, `undefined`, `null`, a string, a number, an object shaped like a Response — and one that returns a
// Response. Each logs a line first, so its Progress entry shows.
import { httpActionGeneric, httpRouter } from "convex/server";

const results: Record<string, () => unknown> = {
  object: () => ({ status: 200 }),
  undefined: () => undefined,
  null: () => null,
  string: () => "text",
  number: () => 42,
  like: () => ({ status: 200, headers: new Headers(), body: null, ok: true }),
  response: () => new Response("fine"),
};

const http = httpRouter();
http.route({
  pathPrefix: "/result/",
  method: "GET",
  handler: httpActionGeneric(async (_ctx, req) => {
    const kind = new URL(req.url).pathname.slice("/result/".length);
    console.log(`returning ${kind}`);
    return results[kind]!() as Response;
  }),
});
export default http;

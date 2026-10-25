// A proxy route (owner, 2026-10-21): an HTTP action that returns the response of its `fetch` as it came, its status,
// headers and body sent on by the backend. `?url=` names the target.
import { httpActionGeneric, httpRouter } from "convex/server";

const http = httpRouter();
http.route({
  path: "/proxy",
  method: "GET",
  handler: httpActionGeneric(async (_ctx, req) => fetch(new URL(req.url).searchParams.get("url")!)),
});
export default http;

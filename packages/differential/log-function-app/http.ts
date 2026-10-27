// An HTTP action that logs a line: its path is its route.
import { httpActionGeneric, httpRouter } from "convex/server";

const http = httpRouter();
http.route({
  path: "/hello",
  method: "GET",
  handler: httpActionGeneric(async () => {
    console.log("http");
    return new Response("hi");
  }),
});
export default http;

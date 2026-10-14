// HTTP routes: the module list names them `<METHOD> <path>` beside the functions.
import { httpActionGeneric, httpRouter } from "convex/server";

const http = httpRouter();
http.route({ path: "/hello", method: "GET", handler: httpActionGeneric(async () => new Response("hi")) });
http.route({ pathPrefix: "/files/", method: "POST", handler: httpActionGeneric(async () => new Response("ok")) });
export default http;

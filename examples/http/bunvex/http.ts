import { httpRouter } from "bunvex/server";
import { getByAuthor, getByAuthorPathSuffix, postMessage } from "./messages";

// The HTTP actions' routes, served on the deployment's site origin. The router is the default export of
// `bunvex/http.ts`.
const http = httpRouter();

http.route({ path: "/postMessage", method: "POST", handler: postMessage });
http.route({ path: "/getMessagesByAuthor", method: "GET", handler: getByAuthor });
// Every path under /getAuthorMessages/, e.g. /getAuthorMessages/123.
http.route({ pathPrefix: "/getAuthorMessages/", method: "GET", handler: getByAuthorPathSuffix });

export default http;

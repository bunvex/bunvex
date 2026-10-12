// HTTP actions that leave an operation unawaited (STUDY-143): a multipart `formData()`, a `runQuery`.
import { httpActionGeneric, httpRouter, makeFunctionReference } from "convex/server";

const qRef = makeFunctionReference<"query">("ops:q");

const http = httpRouter();
http.route({
  path: "/form",
  method: "POST",
  handler: httpActionGeneric(async (_ctx, req) => {
    void req.formData().catch(() => {});
    return new Response("ok");
  }),
});
http.route({
  path: "/query",
  method: "GET",
  handler: httpActionGeneric(async (ctx) => {
    void ctx.runQuery(qRef, {}).catch(() => {});
    return new Response("ok");
  }),
});
http.route({
  path: "/stream",
  method: "GET",
  handler: httpActionGeneric(async (ctx) => {
    void ctx.runQuery(qRef, {}).catch(() => {});
    let n = 0;
    const body = new ReadableStream({
      async pull(c) {
        await new Promise((r) => setTimeout(r, 50));
        if (n++ === 5) c.close();
        else c.enqueue(new TextEncoder().encode("x"));
      },
    });
    return new Response(body);
  }),
});
export default http;

// Serving HTTP actions (STUDY-31 §3.2), as Convex's crates/local_backend/src/http_actions.rs and the action
// environment's HTTP path:
// - the router's lookup on the path (the `/http` prefix already stripped on the API port);
// - the `Request` the handler gets: the URL rebuilt from Host / X-Forwarded-Proto / Forwarded, no body for
//   GET, HEAD and OPTIONS, a `bunvex-request-id` header added when missing (H2), the client's abort signal;
// - auth from `Authorization` that never rejects up front: a failure is thrown by `getUserIdentity()`;
// - the answer: the handler's response streamed (HEAD without its body, cut past 20 MiB), or Convex's 404,
//   405, 408 (no response head within 300 s) and 500 (`{code, trace?, data?}`) answers.
import type { Caller } from "@bunvex/core";
import { TooManyConcurrentRequestsError } from "./action-permits.ts";
import { describeUncaught, newRequestId } from "./errors.ts";
import type { Functions } from "./functions.ts";
import { type HttpRouter, ROUTABLE_HTTP_METHODS, type RoutableMethod } from "./router.ts";

/** Convex's HTTP_ACTION_BODY_LIMIT, for responses. */
export const HTTP_ACTION_RESPONSE_LIMIT = 20 << 20;
/** Convex's HTTP_SERVER_TIMEOUT_DURATION: no response head by then answers 408. */
export const HTTP_ACTION_HEAD_TIMEOUT_MS = 300_000;
export const REQUEST_ID_HEADER = "bunvex-request-id";

export type HttpActionOptions = {
  functions: Functions;
  router: HttpRouter | undefined;
  /** The caller from `Authorization`, or the error its verification gave. */
  identify: (req: Request) => Promise<{ caller: Caller; error: Error | null }>;
  redact: boolean;
  headTimeoutMs?: number;
};

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/** The URL the handler sees: the client's scheme and host, and the path as routed. */
function requestUrl(req: Request, pathAndQuery: string): string {
  const h = req.headers;
  const forwarded = /(?:^|[;,\s])proto=([^;,\s]+)/i.exec(h.get("forwarded") ?? "")?.[1];
  const scheme = h.get("x-forwarded-proto") ?? forwarded ?? "http";
  const host = h.get("host") ?? new URL(req.url).host;
  return `${scheme}://${host}${pathAndQuery}`;
}

/** The response body, cut once it would pass 20 MiB (Convex drops the rest and logs it; the status stays). */
function limited(body: ReadableStream<Uint8Array>, route: string): ReadableStream<Uint8Array> {
  let sent = 0;
  let over = false;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (over) return;
        if (sent + chunk.byteLength > HTTP_ACTION_RESPONSE_LIMIT) {
          over = true;
          console.error(`${route}: HttpResponseTooLarge: HTTP actions support responses up to 20 MiB`);
          controller.terminate();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }),
  );
}

export function httpActionServer(o: HttpActionOptions) {
  const headTimeoutMs = o.headTimeoutMs ?? HTTP_ACTION_HEAD_TIMEOUT_MS;

  /** Convex's 500 for an error before the response head: a fresh request id, the message, maybe data. */
  const errorResponse = (e: unknown) => {
    const u = describeUncaught(e);
    const full = u.message.replace(/\n$/, "");
    const head = full.split("\n")[0];
    const body: Record<string, unknown> = {
      code: `[Request ID: ${newRequestId()}] ${o.redact ? "Server Error" : `Server Error: ${head}`}`,
    };
    if (!o.redact) body.trace = full;
    if (u.data !== undefined) body.data = u.data;
    return new Response(JSON.stringify(body), { status: 500, headers: { "content-type": "application/json" } });
  };

  /** Answer one request; `path` is what the router sees (the `/http` prefix stripped), `search` its query. */
  return async function serve(req: Request, path: string, search: string): Promise<Response> {
    if (!o.router) return text(404, "This bunvex deployment does not have HTTP actions enabled.");
    const method = req.method.toUpperCase();
    if (method !== "HEAD" && !ROUTABLE_HTTP_METHODS.includes(method as RoutableMethod))
      return new Response(null, { status: 405 });
    const match = o.router.lookup(path, method as RoutableMethod | "HEAD");
    if (!match) return text(404, "No matching routes found");
    const [handler, routedMethod, routePath] = match;
    const route = `${routedMethod} ${routePath}`;

    const headers = new Headers(req.headers);
    if (!headers.has(REQUEST_ID_HEADER)) headers.set(REQUEST_ID_HEADER, newRequestId());
    const hasBody = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    const request = new Request(requestUrl(req, `${path}${search}`), {
      method,
      headers,
      body: hasBody ? req.body : null,
      signal: req.signal,
      ...(hasBody ? { duplex: "half" } : {}),
    } as RequestInit);

    const { caller, error } = await o.identify(req);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), headTimeoutMs);
    });
    // The handler keeps running after a 408, as Convex's does.
    const run = o.functions.runHttpAction(handler._handler, request, caller, error).then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    const outcome = await Promise.race([run, timedOut]);
    clearTimeout(timer);
    if (outcome === "timeout") return new Response(null, { status: 408 });
    if (!outcome.ok) {
      if (outcome.e instanceof TooManyConcurrentRequestsError)
        return new Response(JSON.stringify({ code: outcome.e.code, message: outcome.e.message }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      return errorResponse(outcome.e);
    }
    const res = outcome.r;
    if (!(res instanceof Response)) return errorResponse(new Error("HTTP actions must return a Response"));
    // HEAD answers GET's head without its body (Bun also drops a HEAD response's body, as axum does).
    if (method === "HEAD")
      return new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });
    if (!res.body) return res;
    return new Response(limited(res.body, route), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}

// Serving HTTP actions (STUDY-31 §3.2), as Convex's crates/local_backend/src/http_actions.rs and the action
// environment's HTTP path:
// - the router's lookup on the path (the `/http` prefix already stripped on the API port);
// - the `Request` the handler gets: the URL rebuilt from Host / X-Forwarded-Proto / Forwarded, no body for
//   GET, HEAD and OPTIONS, a `bunvex-request-id` header added when missing (H2), the client's abort signal;
// - auth from `Authorization` that never rejects up front: a failure is thrown by `getUserIdentity()`;
// - the answer: the handler's response streamed (HEAD without its body, cut past 100 MiB), or Convex's 404
//   (a request no route matches, logged as Convex logs it; STUDY-31 §7), 405 and 500 (`{code, trace?, data?}`)
//   answers; the 408 past 300 s is the server's, for every route (`request-timeout.ts`).
// - Components' routers (STUDY-157 PR 4): the request is routed from the app as Convex's `route_http_action`
//   (crates/application/src/application_function_runner/http_routing.rs) — the app's `http.js` after its own
//   `httpPrefix`, an exact route first, else the longest prefix among its prefix routes and its mounts, a mount
//   descending into its child with the rest of the path — and the handler runs in the component it reached, with the
//   original request.
import type { Caller } from "@bunvex/core";
import { TooManyConcurrentRequestsError } from "./action-permits.ts";
import { describeUncaught, newRequestId } from "./errors.ts";
import type { ComponentRuntime, Functions } from "./functions.ts";
import { type HttpRouter, ROUTABLE_HTTP_METHODS, type RoutableMethod } from "./router.ts";
import { SpecBlob } from "./web-blob.ts";

export { HTTP_ACTION_RESPONSE_LIMIT } from "./http-body.ts";
export const REQUEST_ID_HEADER = "bunvex-request-id";

/** A component's HTTP routing (what Convex's `route_http_action` reads of each): its router and its mounts. */
export type HttpNode = {
  router: HttpRouter | undefined;
  /** Its definition's mounts, by mount path in key order (`/c/`): the child instance each names. */
  mounts: [string, string][];
  /** Its children's nodes (installed and active), by instance name. */
  children: Map<string, HttpNode>;
  /** The component its handlers run in; absent for the app. */
  component?: ComponentRuntime;
};

/** The app's routing beside its router: its `httpPrefix`, its mounts and its children's nodes. */
export type AppRouting = { prefix: string | null } & Omit<HttpNode, "router" | "component">;

export const NO_ROUTING: AppRouting = { prefix: null, mounts: [], children: new Map() };

/**
 * The component and the path a request reaches (Convex's `route_http_action`), with the route its router matched
 * there (null: its 404), or null when none can answer (no
 * router and no mounts where it stands, a prefix that does not match): Convex's "does not have HTTP actions" 404.
 */
export function routeHttp(
  app: HttpNode & { prefix: string | null },
  path: string,
  method: RoutableMethod | "HEAD",
): { node: HttpNode; path: string; match: ReturnType<HttpRouter["lookup"]> } | null {
  const m = method === "HEAD" ? "GET" : method;
  let node: HttpNode = app;
  let routed = path;
  for (let atApp = true; ; atApp = false) {
    if (!node.router && node.mounts.length === 0) return null;
    // The app's `http.js` is matched after its own prefix is stripped; mounts always match the path as routed.
    const prefix = atApp ? app.prefix : null;
    const httpJs = prefix === null ? routed : routed.startsWith(prefix) ? `/${routed.slice(prefix.length)}` : null;
    const hit = httpJs !== null && node.router ? node.router.lookup(httpJs, m) : null;
    // An exact route of `http.js` is the most specific match.
    if (hit && !hit[2].endsWith("*")) return { node, path: httpJs!, match: hit };
    // Else the longest prefix among its prefix routes and its mounts, compared as Convex compares them: a match's
    // suffix with its leading `/` against a new one's without, a tie going to the later.
    let best: { suffix: string; child?: string } | null = hit
      ? { suffix: `/${httpJs!.slice(hit[2].length - 1)}` }
      : null;
    for (const [mount, child] of node.mounts) {
      if (!routed.startsWith(mount)) continue;
      const rest = routed.slice(mount.length);
      if (best && best.suffix.length < rest.length) continue;
      best = { suffix: `/${rest}`, child };
    }
    // No match: the current `http.js` answers its own 404, if there is one.
    if (!best) return httpJs !== null && node.router ? { node, path: httpJs, match: null } : null;
    if (best.child === undefined) return { node, path: httpJs!, match: hit };
    const next = node.children.get(best.child);
    if (!next) return null;
    node = next;
    routed = best.suffix;
  }
}

export type HttpActionOptions = {
  functions: Functions;
  router: HttpRouter | undefined;
  /** The app's prefix, mounts and children (STUDY-157); set once the components' code is installed. */
  routing: AppRouting;
  /** The caller from `Authorization`, or the error its verification gave. */
  identify: (req: Request) => Promise<{ caller: Caller; error: Error | null }>;
  redact: boolean;
};

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/** What a request no route matches runs: Convex's 404. */
const notFound = () => text(404, "No matching routes found");

/** The URL the handler sees: the client's scheme and host, and the path as routed. */
function requestUrl(req: Request, pathAndQuery: string): string {
  const h = req.headers;
  const forwarded = /(?:^|[;,\s])proto=([^;,\s]+)/i.exec(h.get("forwarded") ?? "")?.[1];
  const scheme = h.get("x-forwarded-proto") ?? forwarded ?? "http";
  const host = h.get("host") ?? new URL(req.url).host;
  return `${scheme}://${host}${pathAndQuery}`;
}

/**
 * `request.blob()` typed by the request's Content-Type, as the Fetch standard's `blob()` (and Convex's runtime)
 * gives it. Bun's server-side requests return a Blob with an empty type, so `ctx.storage.store(await
 * request.blob())` would lose the file's content type; for a type its MIME table knows, Bun's own Blob gives
 * that table's form (`text/plain;charset=utf-8`).
 */
function typedBlob(request: Request): void {
  const blob = request.blob.bind(request);
  Object.defineProperty(request, "blob", {
    value: async () => {
      // The header lower-cased (Convex's `Blob.fromStream`), not Bun's MIME table's form (DV-441).
      return new SpecBlob([await blob()], { type: request.headers.get("content-type") ?? "" });
    },
  });
}

/** The newline after an uncaught error's message, and the frames after it (`describeUncaught`'s text). */
const FRAMES_AT_END = /\n(?: {4}at [^\n]*\n)*$/;

export function httpActionServer(o: HttpActionOptions) {
  /**
   * Convex's 500 for an error before the response head: a fresh request id, the message, maybe data. The `trace` is
   * the error as logged, ending with its newline (after the last frame, or after the message when there is none).
   */
  const errorResponse = (e: unknown) => {
    const u = describeUncaught(e);
    // Convex's `code` is the error's message, whole: what its trace has before the frames and their newline.
    const head = u.message.replace(FRAMES_AT_END, "");
    const body: Record<string, unknown> = {
      code: `[Request ID: ${newRequestId()}] ${o.redact ? "Server Error" : `Server Error: ${head}`}`,
    };
    if (!o.redact) body.trace = u.message;
    if (u.data !== undefined) body.data = u.data;
    return new Response(JSON.stringify(body), { status: 500, headers: { "content-type": "application/json" } });
  };

  /** Answer one request; `path` is what the router sees (the `/http` prefix stripped), `search` its query. */
  return async function serve(req: Request, path: string, search: string): Promise<Response> {
    const disabled = () => text(404, "This bunvex deployment does not have HTTP actions enabled.");
    if (!o.router && o.routing.mounts.length === 0) return disabled();
    const method = req.method.toUpperCase();
    if (method !== "HEAD" && !ROUTABLE_HTTP_METHODS.includes(method as RoutableMethod))
      return new Response(null, { status: 405 });
    const routed = routeHttp({ router: o.router, ...o.routing }, path, method as RoutableMethod | "HEAD");
    if (!routed) return disabled();
    // No route still runs (Convex runs its isolate to look the route up): logged under the request's path,
    // answered 404. The router looks up the path as routed; the handler gets the original request.
    const match = routed.match;

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
    typedBlob(request);

    const { caller, error } = await o.identify(req);
    // No response head within the server's request timeout answers 408 (`request-timeout.ts`); the handler
    // keeps running then, as Convex's does.
    const outcome = await o.functions
      .runHttpAction(
        match ? match[0]._handler : notFound,
        request,
        caller,
        error,
        match && { method: match[1], path: match[2] },
        routed.node.component,
      )
      .then(
        (r) => ({ ok: true as const, r }),
        (e: unknown) => ({ ok: false as const, e }),
      );
    if (!outcome.ok) {
      if (outcome.e instanceof TooManyConcurrentRequestsError)
        return new Response(JSON.stringify({ code: outcome.e.code, message: outcome.e.message }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      return errorResponse(outcome.e);
    }
    const res = outcome.r;
    // The headers before the body: Bun adds a Blob body's Content-Type (`new Response(blob)`) only if they are
    // read first; reading `body` first drops it.
    const resHeaders = res.headers;
    const init = { status: res.status, statusText: res.statusText, headers: resHeaders };
    // HEAD answers GET's head without its body (Bun also drops a HEAD response's body, as axum does).
    if (method === "HEAD") {
      void res.body?.cancel().catch(() => {});
      return new Response(null, init);
    }
    // Already metered by `runHttpAction` (100 MiB at most, the run logged once it is sent).
    return res;
  };
}

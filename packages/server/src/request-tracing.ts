// A trace per HTTP request (STUDY-131 AD-26): the root span of everything the request runs, named after its
// route, as Convex's `stats_middleware` names its root span (crates/common/src/http/mod.rs). A W3C
// `traceparent` header continues the caller's trace; Convex does so only behind its
// PROPAGATE_UPSTREAM_TRACES knob, bunvex always, the way an OpenTelemetry SDK does.
import { parseTraceparent, SPAN_KIND, type Tracer } from "@bunvex/core";

/** Routes whose path holds a value: the span is named by the route, so names stay few. */
const ROUTES: [RegExp, string][] = [
  [/^\/api\/run\//, "/api/run/{path}"],
  [/^\/api\/storage\/upload$/, "/api/storage/upload"],
  [/^\/api\/storage\//, "/api/storage/{id}"],
  [/^\/api\/[^/]+\/sync$/, "/api/{version}/sync"],
  [/^\/api\/export\//, "/api/export/*"],
  [/^\/api\/import\//, "/api/import/*"],
  [/^\/api\/deploy2\//, "/api/deploy2/*"],
  [/^\/http(\/|$)/, "/http/*"],
];

/** A segment that looks like an id or a token (20+ characters of letters, digits, `-`, `_`). */
const ID_SEGMENT = /\/[A-Za-z0-9_-]{20,}(?=\/|$)/g;

/** The route a path is served by, for the span's name and `http.route`. */
export function httpRoute(path: string): string {
  for (const [re, route] of ROUTES) if (re.test(path)) return route;
  return path.replace(ID_SEGMENT, "/{id}");
}

type Fetch<D> = (req: Request, srv: Bun.Server<D>) => Response | undefined | Promise<Response | undefined>;

/**
 * `options` with each request traced: a server span from the request until its handler answers (a streamed
 * body may still be sending), its status, and the request's work under it. `site`: the site port, whose
 * every path is an HTTP action. Tracing off, `options` as they are.
 */
export function withRequestTracing<D>(
  tracer: Tracer,
  options: Bun.Serve.Options<D, never>,
  site = false,
): Bun.Serve.Options<D, never> {
  if (!tracer.on) return options;
  const inner: Fetch<D> = (options as unknown as { fetch: Fetch<D> }).fetch.bind(options);
  const fetch: Fetch<D> = async (req, srv) => {
    const parent = parseTraceparent(req.headers.get("traceparent"), req.headers.get("tracestate"));
    const span = tracer.root(req.method, SPAN_KIND.server, parent);
    if (!span) return tracer.within(null, () => inner(req, srv));
    const url = new URL(req.url);
    const route = site ? "{http action}" : httpRoute(url.pathname);
    span.name = `${req.method} ${route}`;
    span
      .set("http.request.method", req.method)
      .set("http.route", route)
      .set("url.path", url.pathname)
      .set("url.scheme", url.protocol.slice(0, -1))
      .set("server.port", Number(url.port) || undefined)
      .set("user_agent.original", req.headers.get("user-agent"))
      .set("bunvex.client", req.headers.get("bunvex-client"));
    try {
      const res = await tracer.within(span, () => inner(req, srv));
      // An upgraded WebSocket answers nothing: its status is 101.
      const status = res?.status ?? 101;
      span.set("http.response.status_code", status);
      // A server span fails on a 5xx only (OpenTelemetry's HTTP conventions); a 4xx is the client's.
      if (status >= 500) span.fail(`HTTP ${status}`);
      return res;
    } catch (e) {
      span.fail(e);
      throw e;
    } finally {
      span.finish();
    }
  };
  return { ...options, fetch } as Bun.Serve.Options<D, never>;
}

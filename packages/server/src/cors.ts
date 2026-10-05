// Convex's CORS layer for its API (`crates/local_backend/src/router.rs` `cors()`, tower-http's `CorsLayer`):
// every route under `/api` and the health routes; never HTTP actions (`/http/`, the site), which answer CORS
// themselves (STUDY-31), nor the sync socket's upgrade. STUDY-67 H2.

const VARY = "origin, access-control-request-method, access-control-request-headers";
const METHODS = "GET,POST,OPTIONS,PATCH,DELETE,PUT";

/** The health routes (`health_check_routes`), which have the layer too; the meta `/version` does not. */
const HEALTH = new Set(["/instance_name", "/instance_version", "/", "/echo"]);

/** Whether Convex's layer wraps this path: `/api/*` (but the sync upgrade) and the health routes. */
export const hasApiCors = (pathname: string) =>
  (pathname.startsWith("/api/") && !/^\/api\/[^/]+\/sync$/.test(pathname)) || HEALTH.has(pathname);

/**
 * Any `OPTIONS` request (tower-http answers it as a preflight before the route): 200, no body, every method,
 * a day's max age, the asked headers and the origin mirrored, credentials allowed.
 */
export function preflight(req: Request): Response {
  const h = new Headers({
    "access-control-allow-credentials": "true",
    vary: VARY,
    "access-control-allow-methods": METHODS,
    "access-control-max-age": "86400",
  });
  const asked = req.headers.get("access-control-request-headers");
  if (asked !== null) h.set("access-control-allow-headers", asked);
  const origin = req.headers.get("origin");
  if (origin !== null) h.set("access-control-allow-origin", origin);
  return new Response(null, { status: 200, headers: h });
}

/** A response with Convex's CORS headers: credentials always, the origin mirrored when there is one. */
export function withCors(req: Request, res: Response): Response {
  const origin = req.headers.get("origin");
  const set = (h: Headers) => {
    h.set("vary", VARY);
    h.set("access-control-allow-credentials", "true");
    if (origin !== null) h.set("access-control-allow-origin", origin);
  };
  try {
    set(res.headers);
    return res;
  } catch {
    // Immutable headers (a response from `fetch`, e.g. a blob store's): a copy.
    const h = new Headers(res.headers);
    set(h);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }
}

/** A request URL's path, without parsing the whole URL (this runs on every request). */
function pathOf(url: string): string {
  const start = url.indexOf("/", url.indexOf("//") + 2);
  if (start < 0) return "/";
  const end = url.search(/[?#]/);
  return url.slice(start, end < 0 ? undefined : end);
}

/** A server's `fetch` behind Convex's layer: preflights answered, every other answer given the headers. */
export function apiCors<S, R extends Response | undefined>(
  fetch: (req: Request, srv: S) => R | Promise<R>,
): (req: Request, srv: S) => Promise<R> {
  return async (req, srv) => {
    const path = pathOf(req.url);
    if (!hasApiCors(path)) return fetch(req, srv);
    if (req.method === "OPTIONS") return preflight(req) as R;
    const res = await fetch(req, srv);
    return (res === undefined ? res : withCors(req, res)) as R;
  };
}

/** Bun server options whose `fetch` is behind Convex's layer (`apiCors`). */
export function withApiCors<D>(options: Bun.Serve.Options<D, never>): Bun.Serve.Options<D, never> {
  const o = options as Bun.Serve.Options<D, never> & {
    fetch: (req: Request, srv: Bun.Server<D>) => Response | undefined | Promise<Response | undefined>;
  };
  return { ...o, fetch: apiCors(o.fetch.bind(o)) } as Bun.Serve.Options<D, never>;
}

// HTTP actions (STUDY-31): `httpRouter()` and `httpAction()`, as Convex's
// npm-packages/convex/src/server/router.ts and `httpActionGeneric` (impl/registration_impl.ts): exact paths
// and path prefixes per method, the longest prefix winning, HEAD routed as GET, `/.files` reserved; the
// checks and their messages are Convex's. The server serves the router (H1: `createServer({ http })`).
import type { ActionCtx } from "./functions.ts";

export const ROUTABLE_HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"] as const;
export type RoutableMethod = (typeof ROUTABLE_HTTP_METHODS)[number];

/** HEAD runs the GET route (the server drops the body from the response). */
export function normalizeMethod(method: RoutableMethod | "HEAD"): RoutableMethod {
  return method === "HEAD" ? "GET" : method;
}

/** What an HTTP action's handler gets: an action's context (no `db`), and the request. */
export type HttpActionCtx = ActionCtx;
export type HttpActionHandler = (ctx: HttpActionCtx, request: Request) => Promise<Response> | Response;

/** An HTTP action, as Convex's `PublicHttpAction`: callable (it warns), marked, with its handler. */
export type PublicHttpAction = ((ctx: HttpActionCtx, request: Request) => Promise<Response> | Response) & {
  isHttp: true;
  _handler: HttpActionHandler;
};

/** `httpAction(async (ctx, request) => new Response(...))`. It takes no args validator. */
export function httpActionGeneric(handler: HttpActionHandler): PublicHttpAction {
  const f = ((ctx: HttpActionCtx, request: Request) => {
    console.warn(
      "bunvex functions should not directly call other bunvex functions. Consider calling a helper function instead. " +
        "e.g. `export const foo = httpAction(...); await foo(ctx);` is not supported.",
    );
    return handler(ctx, request);
  }) as PublicHttpAction;
  f.isHttp = true;
  f._handler = handler;
  return f;
}
/** The same builder, for apps without codegen (`_generated/server` re-exports it as `httpAction`). */
export const httpAction = httpActionGeneric;

export type RouteSpec =
  | { path: string; method: RoutableMethod; handler: PublicHttpAction }
  | { pathPrefix: string; method: RoutableMethod; handler: PublicHttpAction };

export const httpRouter = () => new HttpRouter();

export class HttpRouter {
  exactRoutes: Map<string, Map<RoutableMethod, PublicHttpAction>> = new Map();
  prefixRoutes: Map<RoutableMethod, Map<string, PublicHttpAction>> = new Map();
  isRouter = true as const;

  route = (spec: RouteSpec) => {
    if (!spec.handler) throw new Error("route requires handler");
    if (!spec.method) throw new Error("route requires method");
    const { method, handler } = spec;
    if (!ROUTABLE_HTTP_METHODS.includes(method))
      throw new Error(`'${method}' is not an allowed HTTP method (like GET, POST, PUT etc.)`);
    if ("path" in spec) {
      if ("pathPrefix" in spec)
        throw new Error("Invalid httpRouter route: cannot contain both 'path' and 'pathPrefix'");
      if (!spec.path.startsWith("/")) throw new Error(`path '${spec.path}' does not start with a /`);
      if (spec.path.startsWith("/.files/") || spec.path === "/.files")
        throw new Error(`path '${spec.path}' is reserved`);
      const methods = this.exactRoutes.get(spec.path) ?? new Map<RoutableMethod, PublicHttpAction>();
      if (methods.has(method)) throw new Error(`Path '${spec.path}' for method ${method} already in use`);
      methods.set(method, handler);
      this.exactRoutes.set(spec.path, methods);
    } else if ("pathPrefix" in spec) {
      const p = spec.pathPrefix;
      if (!p.startsWith("/")) throw new Error(`pathPrefix '${p}' does not start with a /`);
      if (!p.endsWith("/")) throw new Error(`pathPrefix ${p} must end with a /`);
      if (p.startsWith("/.files/")) throw new Error(`pathPrefix '${p}' is reserved`);
      const prefixes = this.prefixRoutes.get(method) ?? new Map<string, PublicHttpAction>();
      if (prefixes.has(p)) throw new Error(`${method} pathPrefix ${p} is already defined`);
      prefixes.set(p, handler);
      this.prefixRoutes.set(method, prefixes);
    } else {
      throw new Error("Invalid httpRouter route entry: must contain either field 'path' or 'pathPrefix'");
    }
  };

  /** Every route: exact ones by path then method, then prefixes (as `prefix*`) by method then prefix. */
  getRoutes = (): Readonly<[string, RoutableMethod, PublicHttpAction]>[] => {
    const exact = [...this.exactRoutes.keys()].sort().flatMap((path) => {
      const methods = this.exactRoutes.get(path)!;
      return [...methods.keys()].sort().map((m) => [path, m, methods.get(m)!] as const);
    });
    const prefixes = [...this.prefixRoutes.keys()].sort().flatMap((m) => {
      const byPrefix = this.prefixRoutes.get(m)!;
      return [...byPrefix.keys()].sort().map((p) => [`${p}*`, m, byPrefix.get(p)!] as const);
    });
    return [...exact, ...prefixes];
  };

  /** The route for `path`: the exact one, else the longest prefix; `[handler, method, routePath]` or null. */
  lookup = (
    path: string,
    method: RoutableMethod | "HEAD",
  ): Readonly<[PublicHttpAction, RoutableMethod, string]> | null => {
    const m = normalizeMethod(method);
    const exact = this.exactRoutes.get(path)?.get(m);
    if (exact) return [exact, m, path];
    const prefixes = [...(this.prefixRoutes.get(m) ?? new Map<string, PublicHttpAction>()).entries()].sort(
      ([a], [b]) => b.length - a.length,
    );
    for (const [prefix, handler] of prefixes) if (path.startsWith(prefix)) return [handler, m, `${prefix}*`];
    return null;
  };
}

/**
 * The checks Convex makes of `http.js`'s default export at push (crates/isolate/src/environment/analyze.rs),
 * made at start (H1).
 */
export function checkRouter(router: unknown): HttpRouter {
  if (router === undefined || router === null)
    throw new Error("`bunvex/http.js` must have a default export of a Router.");
  if (typeof router !== "object" || (router as { isRouter?: unknown }).isRouter !== true)
    throw new Error("The default export of `bunvex/http.js` is not a Router.");
  const getRoutes = (router as { getRoutes?: unknown }).getRoutes;
  if (getRoutes === undefined) throw new Error(".getRoutes property on Router not found");
  if (typeof getRoutes !== "function") throw new Error(".get_routes of Router is not a function");
  const shape = (detail: string) =>
    new Error(
      `The \`getRoutes()\` method of Router did not return the expected type. \`getRoutes()\` should be a function returning an array of entries of the form [path: string, method: string, handler: HttpAction] (${detail})`,
    );
  const routes = getRoutes.call(router);
  if (!Array.isArray(routes)) throw shape("return value is not an array");
  routes.forEach((r: unknown[], i) => {
    if (typeof r?.[0] !== "string") throw shape(`arr[${i}][0] is not a string`);
    if (!ROUTABLE_HTTP_METHODS.includes(r[1] as RoutableMethod))
      throw shape(`'${String(r[1])}' is not not a routable method (one of GET, POST, PUT, DELETE, PATCH, OPTIONS)`);
    const h = r[2] as { isHttp?: unknown; _handler?: unknown } | undefined;
    if (!h || h.isHttp !== true) throw new Error(`arr[${i}][2] is not an HttpAction`);
    if (typeof h._handler !== "function") throw new Error(`arr[${i}][2].handler is not a function`);
  });
  return router as HttpRouter;
}

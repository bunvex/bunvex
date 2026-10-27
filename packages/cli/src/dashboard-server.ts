// The dashboard's own HTTP server (STUDY-149 PR 7): the built app (apps/dashboard, a static Vite build) served
// by Bun, where Convex serves its dashboard with a Next.js server in the `convex-dashboard` image and with
// `serve-handler` in the CLI's local dashboard (npm-packages/convex/src/cli/lib/localDeployment/dashboard.ts,
// serve.ts). The same server backs both here: `bunvex dashboard serve` (the image's command, DV-475) and the
// local dashboard `bunvex dev` runs beside a local deployment.
//
// - Every file of the build, by its path; any other page the browser navigates to (`Accept: text/html`) is the
//   app's index.html, whose router takes the path from there. Hashed `/assets/` are cached for good.
// - index.html carries what the server was started with to prefill the sign-in page: Convex's image reads
//   NEXT_PUBLIC_DEPLOYMENT_URL / NEXT_PUBLIC_ADMIN_KEY when the page is served (`_app.tsx` `getInitialProps`);
//   bunvex writes them into `<meta name="bunvex-deployment-url">` / `<meta name="bunvex-admin-key">`.
// - `GET /api/current_deployment` answers `{ name, url, adminKey }` for the deployment the local dashboard
//   was started for (Convex's local dashboard, `:66-77`), on a loopback address only, and only to a request whose
//   `Host` is `127.0.0.1:<port>` or `localhost:<port>` (DV-476): a page that rebinds its own name to 127.0.0.1
//   cannot read the admin key. Without a deployment it is a 404, as Convex's image answers it.
// - The local dashboard answers nothing else to such a request either: every path is an empty 403 for a `Host` other
//   than those two, as Convex's CLI since `6b0fa75` (`isLoopbackHost`; DV-476 resolved, STUDY-186 Q3). The image's
//   server (`bunvex dashboard serve`) serves any `Host`, as Convex's image.
// - With `securityHeaders` (`bunvex dashboard serve`, the image's server), every response carries the headers
//   Convex's image sends on every path (`dashboard-self-hosted/next.config.js` `headers()`, `source: "/:path*"`).
//   Framing is same-origin only (`X-Frame-Options: SAMEORIGIN`, `frame-ancestors 'self'`) unless the build allows
//   embedding parents (`<meta name="bunvex-embed-origins">`, DV-319): then, as Convex's embedding build
//   (`EMBEDDED_CORS_HEADERS`), no `X-Frame-Options` (it cannot name an origin) and Convex's CORP / COEP, but
//   `frame-ancestors` keeps to `'self'` and those origins where Convex's lets any page frame it (DV-488). The local
//   dashboard sends none, as Convex's CLI's (`serve-handler` without headers).
import { statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** What `/api/current_deployment` hands out: Convex's shape. */
export type CurrentDeployment = { name: string; url: string; adminKey: string };

export type DashboardServerOptions = {
  /** The built dashboard: index.html and its assets. */
  dir: string;
  /** 0 picks a free port. */
  port: number;
  /** Default 127.0.0.1, as Convex's local dashboard; the image listens on 0.0.0.0. */
  hostname?: string;
  /** The local deployment the dashboard signs in to by itself; only on a loopback address. */
  currentDeployment?: CurrentDeployment | null;
  /** Prefills the sign-in page (the image's BUNVEX_DEPLOYMENT_URL / BUNVEX_ADMIN_KEY). */
  prefill?: { deploymentUrl?: string | null; adminKey?: string | null };
  /** Convex's image headers on every response (`bunvex dashboard serve`); the local dashboard sends none. */
  securityHeaders?: boolean;
  /**
   * Answer only a request whose `Host` is `127.0.0.1:<port>` or `localhost:<port>`, any other an empty 403, before
   * anything else: Convex's local dashboard (`handleDashboard`, `isLoopbackHost`, `6b0fa75`; DV-476 resolved).
   */
  loopbackHostOnly?: boolean;
};

export type DashboardServer = { url: string; port: number; stop: () => Promise<void> };

export const CURRENT_DEPLOYMENT_PATH = "/api/current_deployment";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export const isLoopback = (hostname: string) => LOOPBACK.has(hostname.toLowerCase());

/** Convex's `normalizeUrl` (`_app.tsx`): a URL without its trailing slash, or null when it is not one. */
export function normalizeDeploymentUrl(url: string): string | null {
  try {
    return new URL(url).href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

const escapeAttribute = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** index.html with the prefill's `<meta>` tags at the end of its head (nothing added for an unset value). */
export function withPrefill(html: string, prefill: DashboardServerOptions["prefill"]): string {
  const tags: string[] = [];
  const url = prefill?.deploymentUrl ? normalizeDeploymentUrl(prefill.deploymentUrl) : null;
  if (url) tags.push(`<meta name="bunvex-deployment-url" content="${escapeAttribute(url)}">`);
  if (prefill?.adminKey) tags.push(`<meta name="bunvex-admin-key" content="${escapeAttribute(prefill.adminKey)}">`);
  if (tags.length === 0) return html;
  const at = html.indexOf("</head>");
  return at === -1 ? `${tags.join("")}${html}` : `${html.slice(0, at)}${tags.join("")}${html.slice(at)}`;
}

/** The `<meta name>` in index.html that lists the parents allowed to embed the dashboard (the app's, DV-319). */
export const EMBED_ORIGINS_META = "bunvex-embed-origins";

/**
 * The allowed embedding parents in a built index.html, read as the app reads them (`src/login/embedded.ts`
 * `parseAllowedOrigins`): the first `<meta name="bunvex-embed-origins">`'s origins, separated by commas or spaces,
 * each reduced to scheme, host and port; anything not an http(s) URL dropped (`*` included).
 */
export function embedOrigins(html: string): string[] {
  let raw: string | null = null;
  new HTMLRewriter()
    .on(`meta[name="${EMBED_ORIGINS_META}"]`, {
      element(e) {
        raw ??= e.getAttribute("content") ?? "";
      },
    })
    .transform(html);
  const origins = new Set<string>();
  for (const entry of (raw ?? "").split(/[\s,]+/)) {
    if (!entry) continue;
    try {
      const u = new URL(entry);
      if (u.protocol === "http:" || u.protocol === "https:") origins.add(u.origin);
    } catch {
      // not a URL: ignored
    }
  }
  return [...origins];
}

/**
 * The headers Convex's image sends on every path (`next.config.js:1-65`), with the embedding parents (DV-319) in
 * `frame-ancestors`. HSTS is sent as Convex sends it, over plain HTTP too, where browsers ignore it (RFC 6797 §8.1).
 */
export function dashboardHeaders(embedOrigins: readonly string[]): [string, string][] {
  const common: [string, string][] = [
    ["x-dns-prefetch-control", "on"],
    ["strict-transport-security", "max-age=63072000; includeSubDomains; preload"],
    ["x-xss-protection", "1; mode=block"],
    ["referrer-policy", "origin-when-cross-origin"],
  ];
  if (embedOrigins.length === 0)
    return [...common, ["x-frame-options", "SAMEORIGIN"], ["content-security-policy", "frame-ancestors 'self'"]];
  return [
    ...common,
    ["cross-origin-resource-policy", "cross-origin"],
    ["cross-origin-embedder-policy", "require-corp"],
    ["content-security-policy", `frame-ancestors 'self' ${embedOrigins.join(" ")}`],
  ];
}

/** The file under `root` a URL path names, or null (outside it, not a file, or not a valid path). */
function fileFor(root: string, pathname: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (path.includes("\0")) return null;
  const file = resolve(join(root, path));
  if (file !== root && !file.startsWith(root + sep)) return null;
  try {
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/** Start the server; resolves once it listens. */
export async function serveDashboard(o: DashboardServerOptions): Promise<DashboardServer> {
  const root = resolve(o.dir);
  const indexFile = join(root, "index.html");
  let built: string;
  try {
    built = await Bun.file(indexFile).text();
  } catch {
    throw new Error(`${root} is not a built dashboard: it has no index.html`);
  }
  const indexHtml = withPrefill(built, o.prefill);
  const headers = o.securityHeaders ? dashboardHeaders(embedOrigins(built)) : [];
  const hostname = o.hostname ?? "127.0.0.1";
  const current = o.currentDeployment && isLoopback(hostname) ? o.currentDeployment : null;
  let allowedHosts = new Set<string>();
  const index = (head: boolean) =>
    new Response(head ? null : indexHtml, {
      headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache" },
    });
  const respond = (req: Request): Response => {
    if (o.loopbackHostOnly && !allowedHosts.has((req.headers.get("host") ?? "").toLowerCase()))
      return new Response(null, { status: 403 });
    if (req.method !== "GET" && req.method !== "HEAD")
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    const { pathname } = new URL(req.url);
    if (pathname === CURRENT_DEPLOYMENT_PATH && current) {
      if (!allowedHosts.has((req.headers.get("host") ?? "").toLowerCase()))
        return new Response("Forbidden: open the dashboard at 127.0.0.1 or localhost", { status: 403 });
      return Response.json(current, { headers: { "cache-control": "no-store" } });
    }
    if (pathname === "/" || pathname === "/index.html") return index(req.method === "HEAD");
    const file = fileFor(root, pathname);
    if (file)
      return new Response(Bun.file(file), {
        headers: {
          "cache-control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        },
      });
    // a page of the app (its router reads the path); a missing script or image stays a 404
    if ((req.headers.get("accept") ?? "").includes("text/html")) return index(req.method === "HEAD");
    return new Response("Not Found", { status: 404 });
  };
  const server = Bun.serve({
    hostname,
    port: o.port,
    fetch(req) {
      const res = respond(req);
      for (const [name, value] of headers) res.headers.set(name, value);
      return res;
    },
  });
  const port = server.port ?? o.port;
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const shown = hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname;
  return {
    url: `http://${shown.includes(":") ? `[${shown}]` : shown}:${port}/`,
    port,
    stop: () => server.stop(true),
  };
}

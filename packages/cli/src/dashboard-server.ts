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
  let indexHtml: string;
  try {
    indexHtml = withPrefill(await Bun.file(indexFile).text(), o.prefill);
  } catch {
    throw new Error(`${root} is not a built dashboard: it has no index.html`);
  }
  const hostname = o.hostname ?? "127.0.0.1";
  const current = o.currentDeployment && isLoopback(hostname) ? o.currentDeployment : null;
  let allowedHosts = new Set<string>();
  const index = (head: boolean) =>
    new Response(head ? null : indexHtml, {
      headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache" },
    });
  const server = Bun.serve({
    hostname,
    port: o.port,
    fetch(req) {
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

// `bunvex dashboard serve` (STUDY-149 PR 7): the dashboard app on its own HTTP server (dashboard-server.ts). It is
// what the dashboard image runs (DV-475; Convex's image runs `node server.js`, its Next.js server), and what an
// operator runs to serve the dashboard without Docker. Convex's CLI has no such command: it serves the app only
// inside `npx convex dev` (local-dashboard.ts has bunvex's).
//
// - The app: `--dir`, a built dashboard; else the release's `dashboard.zip`, downloaded once and cached as `dev`
//   does (the latest release's, or `--version`'s).
// - `--deployment-url` / `--admin-key` (or BUNVEX_DEPLOYMENT_URL / BUNVEX_ADMIN_KEY, the image's Convex
//   NEXT_PUBLIC_DEPLOYMENT_URL / NEXT_PUBLIC_ADMIN_KEY) prefill the sign-in page.
// - In a project whose deployment is local (`BUNVEX_DEPLOYMENT=local:…`), on a loopback address, it answers
//   `/api/current_deployment` with that deployment, as `dev`'s local dashboard does: a build made for it
//   (`dashboard.zip`) signs in by itself.
// - Every response carries the frame and security headers of Convex's image (dashboard-server.ts
//   `dashboardHeaders`): framing same-origin only, or by the parents the build allows (DV-319, DV-488).
import { argumentError, invalidArgument, missingArgument, unknownOption } from "./args.ts";
import { type CurrentDeployment, isLoopback, normalizeDeploymentUrl, serveDashboard } from "./dashboard-server.ts";
import type { Io } from "./io.ts";
import { DEFAULT_LOCAL_DASHBOARD_PORT, dashboardVersion, ensureDashboardDownloaded } from "./local-dashboard.ts";
import { configuredDeployment, readLocalConfig } from "./local-deployment.ts";

export const DASHBOARD_SERVE_USAGE = `Usage: bunvex dashboard serve [options]

Serve the dashboard app over HTTP

Options:
  --port <port>            the port to listen on (default: ${DEFAULT_LOCAL_DASHBOARD_PORT})
  --hostname <address>     the address to listen on (default: 127.0.0.1)
  --dir <path>             a built dashboard (default: the release's dashboard.zip, downloaded once)
  --version <version>      the release to take dashboard.zip from (default: the latest)
  --deployment-url <url>   prefill the sign-in page's deployment URL (default: BUNVEX_DEPLOYMENT_URL)
  --admin-key <key>        prefill the sign-in page's admin key (default: BUNVEX_ADMIN_KEY)`;

const VALUE_OPTIONS = ["--port", "--hostname", "--dir", "--version", "--deployment-url", "--admin-key"] as const;
type ServeFlags = Partial<Record<(typeof VALUE_OPTIONS)[number], string>>;

function parseServeFlags(args: string[]): ServeFlags | string {
  const flags: ServeFlags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf("=");
    const name = (a.startsWith("--") && eq !== -1 ? a.slice(0, eq) : a) as (typeof VALUE_OPTIONS)[number];
    if (!VALUE_OPTIONS.includes(name)) return unknownOption(a, [...VALUE_OPTIONS, "--help"]);
    const value = eq !== -1 && a.startsWith("--") ? a.slice(eq + 1) : args[++i];
    if (value === undefined) return missingArgument(`${name} <value>`);
    flags[name] = value;
  }
  return flags;
}

/** The project's local deployment, when it is the configured one and has been created. */
function localDeployment(io: Io): CurrentDeployment | null {
  try {
    if (configuredDeployment(io)?.type !== "local") return null;
  } catch {
    return null;
  }
  const c = readLocalConfig(io.cwd);
  return c ? { name: c.deploymentName, url: `http://127.0.0.1:${c.ports.cloud}`, adminKey: c.adminKey } : null;
}

export async function dashboardServeCommand(
  args: string[],
  io: Io,
  opts: { signal?: AbortSignal } = {},
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(DASHBOARD_SERVE_USAGE);
    return 0;
  }
  const flags = parseServeFlags(args);
  if (typeof flags === "string") return argumentError(io, flags, DASHBOARD_SERVE_USAGE);
  const port = Number(flags["--port"] ?? DEFAULT_LOCAL_DASHBOARD_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    return argumentError(io, invalidArgument("--port <port>", flags["--port"]!, "Not a port number."));
  const deploymentUrl = flags["--deployment-url"] ?? io.env.BUNVEX_DEPLOYMENT_URL;
  if (deploymentUrl && !normalizeDeploymentUrl(deploymentUrl))
    return argumentError(io, invalidArgument("--deployment-url <url>", deploymentUrl, "Not a URL."));
  const hostname = flags["--hostname"] ?? "127.0.0.1";
  let server: Awaited<ReturnType<typeof serveDashboard>>;
  try {
    const dir = flags["--dir"] ?? (await ensureDashboardDownloaded(io, await dashboardVersion(io, flags["--version"])));
    server = await serveDashboard({
      dir,
      port,
      hostname,
      currentDeployment: isLoopback(hostname) ? localDeployment(io) : null,
      prefill: { deploymentUrl, adminKey: flags["--admin-key"] ?? io.env.BUNVEX_ADMIN_KEY },
      securityHeaders: true,
    });
  } catch (e) {
    const message = (e as { code?: string }).code === "EADDRINUSE" ? `port ${port} is in use` : (e as Error).message;
    io.err(`bunvex dashboard serve: ${message}`);
    return 1;
  }
  io.err(`Serving the dashboard at ${server.url}`);
  await new Promise<void>((done) => {
    if (opts.signal) {
      if (opts.signal.aborted) done();
      else opts.signal.addEventListener("abort", () => done(), { once: true });
    } else for (const s of ["SIGINT", "SIGTERM"] as const) process.once(s, () => done());
  });
  await server.stop();
  return 0;
}

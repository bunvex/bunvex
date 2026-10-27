// The local dashboard (STUDY-149 PR 7, closes DV-202), as Convex's `npx convex dev` runs one beside an anonymous
// local deployment (npm-packages/convex/src/cli/lib/localDeployment/dashboard.ts, download.ts, filePaths.ts):
//
// - the app is the release's `dashboard.zip` (the static build made with VITE_BUNVEX_USE_CURRENT_DEPLOYMENT=1),
//   downloaded once per version into `~/.cache/bunvex/dashboard/out/`; `dashboard/config.json` records which
//   version is there, and another version replaces it (Convex's `ensureDashboardDownloaded`);
// - the version is `--local-backend-version`'s, else the latest release's (Convex's `handleDashboard`);
// - it is served on the first free port from 6790 (a port taken between the probe and the bind moves on to the next),
//   saved per deployment in `.bunvex/local/default/dashboard.json`
//   (`{ port }`, Convex's `ProjectDashboardConfig`), with `/api/current_deployment` naming the deployment
//   (dashboard-server.ts, with its `Host` check, DV-476);
// - unlike Convex, which stops `dev` when the dashboard cannot be had, a version that cannot be resolved or
//   downloaded (offline) is a warning: the dashboard already in the cache is served, or with none `dev` runs
//   without one and `dashboard.json` says why (DV-486);
// - `bunvex dashboard` opens `http://127.0.0.1:<saved port>/` once its `/api/current_deployment` names the
//   project's deployment (Convex's `isAnonymousDashboardRunning`).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { type CurrentDeployment, type DashboardServer, serveDashboard } from "./dashboard-server.ts";
import type { Io } from "./io.ts";
import {
  assertValidBackendVersion,
  cacheDir,
  choosePort,
  latestVersion,
  releaseUrls,
  stateDir,
  zipEntries,
} from "./local-deployment.ts";

export const DEFAULT_LOCAL_DASHBOARD_PORT = 6790;
export const DASHBOARD_ZIP = "dashboard.zip";

/** `~/.cache/bunvex/dashboard`: `config.json` ({ version }) and `out/`, the app. */
export const dashboardDir = (env: Io["env"]) => join(cacheDir(env), "dashboard");
export const dashboardOutDir = (env: Io["env"]) => join(dashboardDir(env), "out");

/** The deployment's dashboard config, next to its config.json. */
const projectConfigPath = (cwd: string) => join(stateDir(cwd), "dashboard.json");

export function readDashboardPort(cwd: string): number | null {
  try {
    const port = (JSON.parse(readFileSync(projectConfigPath(cwd), "utf8")) as { port?: unknown }).port;
    return typeof port === "number" ? port : null;
  } catch {
    return null;
  }
}

function saveDashboardConfig(cwd: string, config: { port: number } | { unavailable: string }) {
  mkdirSync(stateDir(cwd), { recursive: true });
  writeFileSync(projectConfigPath(cwd), JSON.stringify(config));
}

/** Why `dev` runs without the local dashboard (DV-486), when it does. */
export function readDashboardUnavailable(cwd: string): string | null {
  try {
    const why = (JSON.parse(readFileSync(projectConfigPath(cwd), "utf8")) as { unavailable?: unknown }).unavailable;
    return typeof why === "string" ? why : null;
  } catch {
    return null;
  }
}

function cachedVersion(env: Io["env"]): string | null {
  try {
    const v = (JSON.parse(readFileSync(join(dashboardDir(env), "config.json"), "utf8")) as { version?: unknown })
      .version;
    return typeof v === "string" && existsSync(join(dashboardOutDir(env), "index.html")) ? v : null;
  } catch {
    return null;
  }
}

/** Every file of `zip` written under `dir`; an entry that would land outside it fails the whole archive. */
export function extractZip(zip: Uint8Array, dir: string) {
  const root = resolve(dir);
  for (const entry of zipEntries(zip)) {
    const file = resolve(root, normalize(entry.name));
    if (!file.startsWith(root + sep)) throw new Error(`${entry.name}: a path outside the archive`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, entry.data());
  }
}

/** The app of `version`: cached, else its release's `dashboard.zip` downloaded and unzipped. Returns its directory. */
export async function ensureDashboardDownloaded(io: Io, version: string): Promise<string> {
  assertValidBackendVersion(version);
  const out = dashboardOutDir(io.env);
  if (cachedVersion(io.env) === version) return out;
  const url = releaseUrls(io.env).download(version, DASHBOARD_ZIP);
  io.err(`Downloading the bunvex dashboard ${version}...`);
  let r: Response;
  try {
    r = await fetch(url);
  } catch (e) {
    throw new Error(`could not download ${url}: ${(e as Error).message}`);
  }
  if (r.status !== 200) throw new Error(`File not found at ${url}.`);
  const zip = new Uint8Array(await r.arrayBuffer());
  const dir = dashboardDir(io.env);
  const tmp = join(dir, `out.${process.pid}.tmp`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    extractZip(zip, tmp);
    if (!existsSync(join(tmp, "index.html"))) throw new Error(`${url} is not a dashboard: it has no index.html`);
    rmSync(out, { recursive: true, force: true });
    renameSync(tmp, out);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  writeFileSync(join(dir, "config.json"), JSON.stringify({ version }));
  io.err("Downloaded the bunvex dashboard.");
  return out;
}

/** The version `dev` and `dashboard serve` take the app from: the one asked for, else the latest release's. */
export async function dashboardVersion(io: Io, requested: string | undefined): Promise<string> {
  if (requested !== undefined) return requested;
  const latest = await latestVersion(io.env);
  if ("error" in latest) throw new Error(latest.error);
  return latest.version;
}

/**
 * `dev`'s local dashboard (Convex's `handleDashboard`): the app downloaded if needed, served on the first free
 * port from 6790 for `deployment`, the port saved for `bunvex dashboard`. When the app's version cannot be
 * resolved or downloaded, the cached app is served, or none (`server` null) — a warning either way (DV-486).
 */
export async function startLocalDashboard(
  io: Io,
  deployment: CurrentDeployment,
  opts: { backendVersion?: string; avoid?: number[]; from?: number } = {},
): Promise<{ server: DashboardServer | null; stop: () => Promise<void> }> {
  let dir: string;
  try {
    dir = await ensureDashboardDownloaded(io, await dashboardVersion(io, opts.backendVersion));
  } catch (e) {
    const why = (e as Error).message;
    const cached = cachedVersion(io.env);
    io.err(`⚠️ Could not get the bunvex dashboard: ${why}`);
    if (cached === null) {
      io.err("Running without the local dashboard; `bunvex dev` serves it once it can be downloaded.");
      saveDashboardConfig(io.cwd, { unavailable: why });
      return { server: null, stop: async () => rmSync(projectConfigPath(io.cwd), { force: true }) };
    }
    io.err(`Serving the dashboard already downloaded (${cached}).`);
    dir = dashboardOutDir(io.env);
  }
  const server = await serveOnFirstFreePort(opts.from ?? DEFAULT_LOCAL_DASHBOARD_PORT, opts.avoid ?? [], (port) =>
    serveDashboard({ dir, port, currentDeployment: deployment }),
  );
  saveDashboardConfig(io.cwd, { port: server.port });
  return { server, stop: server.stop };
}

/** How many ports taken between the probe and the bind `serveOnFirstFreePort` moves past before it gives up. */
const BIND_RETRIES = 20;

/**
 * Serve on the first free port from `from` (Convex's `choosePorts`, then `startServer`). A port another process
 * binds between the probe and the bind — two `bunvex dev` starting at once, or parallel tests — is skipped for
 * the next free one, where Convex's `listen` only logs the error and never resolves (`dev` hangs).
 */
export async function serveOnFirstFreePort<T>(
  from: number,
  avoid: number[],
  serve: (port: number) => Promise<T>,
): Promise<T> {
  for (let next = from, retries = 0; ; retries++) {
    const port = await choosePort(undefined, undefined, next, avoid);
    try {
      return await serve(port);
    } catch (e) {
      if ((e as { code?: string }).code !== "EADDRINUSE" || retries >= BIND_RETRIES) throw e;
      next = port + 1;
    }
  }
}

/** `http://127.0.0.1:<port>/` of the project's local dashboard, if one is saved. */
export function localDashboardUrl(cwd: string): string | null {
  const port = readDashboardPort(cwd);
  return port === null ? null : `http://127.0.0.1:${port}/`;
}

/** Whether the dashboard at `url` is serving `deploymentName` (the port may since be another session's). */
export async function isLocalDashboardRunning(url: string, deploymentName: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}api/current_deployment`, { signal: AbortSignal.timeout(2000) });
    if (r.status !== 200) return false;
    return ((await r.json()) as { name?: unknown }).name === deploymentName;
  } catch {
    return false;
  }
}

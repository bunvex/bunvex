// The local dashboard (STUDY-149 PR 7, closes DV-202), as Convex's `npx convex dev` runs one beside an anonymous
// local deployment (npm-packages/convex/src/cli/lib/localDeployment/dashboard.ts, download.ts, filePaths.ts):
//
// - the app is the release's `dashboard.zip` (the static build made with VITE_BUNVEX_USE_CURRENT_DEPLOYMENT=1),
//   downloaded once per version into `~/.cache/bunvex/dashboard/out/`; `dashboard/config.json` records which
//   version is there, and another version replaces it (Convex's `ensureDashboardDownloaded`);
// - the version is `--local-backend-version`'s, else the latest release's (Convex's `handleDashboard`);
// - it is served on the first free port from 6790, saved per deployment in `.bunvex/local/default/dashboard.json`
//   (`{ port }`, Convex's `ProjectDashboardConfig`), with `/api/current_deployment` naming the deployment
//   (dashboard-server.ts, with its `Host` check, DV-476);
// - `bunvex dashboard` opens `http://127.0.0.1:<saved port>/` once its `/api/current_deployment` names the
//   project's deployment (Convex's `isAnonymousDashboardRunning`).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { type CurrentDeployment, type DashboardServer, serveDashboard } from "./dashboard-server.ts";
import type { Io } from "./io.ts";
import { cacheDir, choosePort, latestVersion, releaseUrls, stateDir, zipEntries } from "./local-deployment.ts";

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

function saveDashboardPort(cwd: string, port: number) {
  mkdirSync(stateDir(cwd), { recursive: true });
  writeFileSync(projectConfigPath(cwd), JSON.stringify({ port }));
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
 * port from 6790 for `deployment`, the port saved for `bunvex dashboard`.
 */
export async function startLocalDashboard(
  io: Io,
  deployment: CurrentDeployment,
  opts: { backendVersion?: string; avoid?: number[] } = {},
): Promise<DashboardServer> {
  const dir = await ensureDashboardDownloaded(io, await dashboardVersion(io, opts.backendVersion));
  const port = await choosePort(undefined, undefined, DEFAULT_LOCAL_DASHBOARD_PORT, opts.avoid ?? []);
  const server = await serveDashboard({ dir, port, currentDeployment: deployment });
  saveDashboardPort(io.cwd, server.port);
  return server;
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

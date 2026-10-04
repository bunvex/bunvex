// Local deployments (STUDY-40 L3–L5), as Convex's `npx convex dev` runs them
// (npm-packages/convex/src/cli/lib/localDeployment/*):
//
// - the deployment lives in the project, `.bunvex/local/default/` (`.bunvex/.gitignore` is `/*`):
//   `config.json` ({ ports, backendVersion, adminKey, instanceSecret, deploymentName }),
//   `bunvex_local_storage/`, `bunvex_local_backend.sqlite3`;
// - it runs `bunvex-local-backend`, downloaded once per version from the latest `precompiled-*` release
//   (GitHub's releases API, L4) into `~/.cache/bunvex/binaries/<version>/`, or the executable that
//   BUNVEX_LOCAL_BACKEND_BINARY names (L5);
// - as a child of the command (SIGTERM when it ends), on the saved ports or the first free ones from 3210,
//   ready once `/instance_name` answers its name (500 ms polls, 30 s or
//   BUNVEX_LOCAL_BACKEND_STARTUP_TIMEOUT_SECS);
// - its admin key from the executable's `keygen admin-key`, its secret 32 random bytes;
// - `.env.local` names it (`BUNVEX_DEPLOYMENT=local:<name>`) and gives the client its URL.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { Io } from "./io.ts";
import { deploymentVariables, resolveTarget, type Target, type TargetFlags } from "./target.ts";

export const EXE = process.platform === "win32" ? "bunvex-local-backend.exe" : "bunvex-local-backend";
const REPO = "bunvex/bunvex";

export type LocalConfig = {
  ports: { cloud: number; site: number };
  backendVersion: string;
  adminKey: string;
  instanceSecret: string;
  deploymentName: string;
};

export const stateDir = (cwd: string) => join(cwd, ".bunvex", "local", "default");

export function readLocalConfig(cwd: string): LocalConfig | null {
  const p = join(stateDir(cwd), "config.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as LocalConfig) : null;
}

function saveLocalConfig(cwd: string, c: LocalConfig) {
  const dir = stateDir(cwd);
  mkdirSync(dir, { recursive: true });
  const ignore = join(cwd, ".bunvex", ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "/*\n");
  writeFileSync(join(dir, "config.json"), JSON.stringify(c));
}

/** Convex's cache directory, for bunvex: `~/.cache/bunvex`, or `%LOCALAPPDATA%\bunvex` on Windows. */
export function cacheDir(env: Io["env"]): string {
  if (process.platform === "win32")
    return join(env.LOCALAPPDATA ?? join(env.USERPROFILE ?? homedir(), "AppData", "Local"), "bunvex");
  return join(env.HOME ?? homedir(), ".cache", "bunvex");
}

/** The release asset for this machine (Convex's names). */
export function assetName(): string {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "darwin") return `bunvex-local-backend-${arch}-apple-darwin.zip`;
  if (process.platform === "win32") return "bunvex-local-backend-x86_64-pc-windows-msvc.zip";
  return `bunvex-local-backend-${arch}-unknown-linux-gnu.zip`;
}

/** Where releases come from; BUNVEX_RELEASES_URL serves both paths in tests. */
function releaseUrls(env: Io["env"]) {
  const base = env.BUNVEX_RELEASES_URL?.replace(/\/$/, "");
  return {
    latest: base ? `${base}/releases/latest` : `https://api.github.com/repos/${REPO}/releases/latest`,
    download: (version: string) =>
      `${base ?? `https://github.com/${REPO}`}/releases/download/${version}/${assetName()}`,
  };
}

let cachedLatestVersion: string | null = null;

/**
 * The latest release's version (a `precompiled-*` tag), or why it could not be found, as Convex's
 * `findLatestVersionWithBinary` (cli/lib/localDeployment/download.ts) reports it: the host's status and
 * answer, a response without a version, or a failed fetch. A version found is kept for the process, as Convex.
 */
export async function latestVersion(env: Io["env"]): Promise<{ version: string } | { error: string }> {
  if (cachedLatestVersion !== null) return { version: cachedLatestVersion };
  const url = releaseUrls(env).latest;
  try {
    const r = await fetch(url, { headers: { accept: "application/vnd.github+json" } });
    if (!r.ok) return { error: `${new URL(url).host} returned ${r.status}: ${await r.text()}` };
    const tag = ((await r.json()) as { tag_name?: unknown }).tag_name;
    if (typeof tag !== "string" || !tag.startsWith("precompiled-"))
      return { error: "Invalid response missing version field" };
    cachedLatestVersion = tag;
    return { version: tag };
  } catch {
    return { error: "Failed to fetch latest backend version" };
  }
}

/** Forget the latest version found (tests). */
export function forgetLatestVersion() {
  cachedLatestVersion = null;
}

/** One file of a zip archive (stored or deflated), as the release zips are made (`zip -j`). */
export function unzipOne(zip: Uint8Array, name: string): Uint8Array {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.length - 22;
  while (eocd >= 0 && v.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip archive");
  let p = v.getUint32(eocd + 16, true);
  const entries = v.getUint16(eocd + 10, true);
  for (let i = 0; i < entries; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("a corrupt zip archive");
    const method = v.getUint16(p + 10, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const entry = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    if (entry === name) {
      const dataAt = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const data = zip.subarray(dataAt, dataAt + size);
      if (method === 0) return data.slice();
      if (method === 8) return new Uint8Array(inflateRawSync(data));
      throw new Error(`unsupported zip compression method ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${name} is not in the archive`);
}

/** The executable of `version`: cached, else downloaded and unzipped (Convex's `ensureBackendBinaryDownloaded`). */
export async function ensureBinary(io: Io, version: string): Promise<string> {
  const custom = io.env.BUNVEX_LOCAL_BACKEND_BINARY;
  if (custom) return custom;
  const path = join(cacheDir(io.env), "binaries", version, EXE);
  if (existsSync(path)) {
    if (process.platform !== "win32") chmodSync(path, 0o755);
    return path;
  }
  const url = releaseUrls(io.env).download(version);
  io.err(`Downloading the bunvex local backend ${version}...`);
  let r: Response;
  try {
    r = await fetch(url);
  } catch (e) {
    throw new Error(`could not download ${url}: ${(e as Error).message}`);
  }
  if (r.status !== 200) throw new Error(`File not found at ${url}.`);
  const exe = unzipOne(new Uint8Array(await r.arrayBuffer()), EXE);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, exe);
  if (process.platform !== "win32") chmodSync(tmp, 0o755);
  renameSync(tmp, path);
  io.err("Downloaded the bunvex local backend.");
  return path;
}

/** The version a custom executable reports (`--version`), for config.json. */
async function customVersion(bin: string): Promise<string> {
  const p = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(p.stdout).text()).trim();
  await p.exited;
  return out.replace(/^bunvex-local-backend /, "") || "custom";
}

async function portFree(port: number): Promise<boolean> {
  try {
    const s = Bun.listen({ hostname: "0.0.0.0", port, socket: { data() {} } });
    s.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** Convex's port choice: a requested port must be free; else the saved one if free; else the next free from `from`. */
async function choosePort(requested: number | undefined, saved: number | undefined, from: number, avoid: number[]) {
  if (requested !== undefined) {
    if (!(await portFree(requested))) throw new Error(`Requested port ${requested} is not available`);
    return requested;
  }
  if (saved !== undefined && !avoid.includes(saved) && (await portFree(saved))) return saved;
  for (let p = from; p < from + 1000; p++) if (!avoid.includes(p) && (await portFree(p))) return p;
  throw new Error(`no free port from ${from}`);
}

async function instanceNameAt(port: number): Promise<string | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/instance_name`, { signal: AbortSignal.timeout(1000) });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}

export type LocalOptions = {
  backendVersion?: string;
  forceUpgrade?: boolean;
  cloudPort?: number;
  sitePort?: number;
};

export type RunningLocal = { target: Target; config: LocalConfig; stop: () => Promise<void> };

/** The name a new local deployment takes (L3): `local-<directory>`. */
export const newDeploymentName = (cwd: string) => `local-${basename(cwd).replace(/[^A-Za-z0-9_-]/g, "_")}`;

/**
 * Start the project's local deployment (creating it on first use), as Convex's `handleLocalDeployment`:
 * choose the executable (and ask before upgrading), check it is not already running, choose the ports,
 * start it as a child, wait for it, save config.json.
 */
export async function startLocalDeployment(io: Io, opts: LocalOptions = {}): Promise<RunningLocal> {
  const existing = readLocalConfig(io.cwd);
  const name = existing?.deploymentName ?? newDeploymentName(io.cwd);
  // The executable's version.
  let version: string;
  let bin: string;
  if (io.env.BUNVEX_LOCAL_BACKEND_BINARY) {
    bin = io.env.BUNVEX_LOCAL_BACKEND_BINARY;
    version = await customVersion(bin);
  } else {
    let chosen = opts.backendVersion;
    if (chosen === undefined) {
      const latest = await latestVersion(io.env);
      if ("version" in latest) chosen = latest.version;
      else {
        // As Convex: without a downloaded version this stops; with one, the reason and a warning, and it is used.
        if (!existing) throw new Error(latest.error);
        io.err(latest.error);
        io.err(`Failed to get latest version from GitHub, using downloaded version ${existing.backendVersion}`);
        chosen = existing.backendVersion;
      }
    }
    if (existing && existing.backendVersion !== chosen && !opts.backendVersion) {
      const upgrade =
        opts.forceUpgrade ||
        !io.prompt ||
        /^(y|yes|)$/i.test(
          (
            io.prompt("This deployment is using an older version of the bunvex backend. Upgrade now? (Y/n)") ?? "y"
          ).trim(),
        );
      if (!upgrade) chosen = existing.backendVersion;
    }
    version = chosen;
    bin = await ensureBinary(io, version);
  }
  // Convex's `ensureBackendStopped`: the same deployment still answering on its port is an error.
  if (existing) {
    for (let i = 0; i < 10 && (await instanceNameAt(existing.ports.cloud)) === name; i++) await Bun.sleep(500);
    if ((await instanceNameAt(existing.ports.cloud)) === name)
      throw new Error(
        `A local backend is still running on port ${existing.ports.cloud}. Please stop it and run this command again.`,
      );
  }
  const cloud = await choosePort(opts.cloudPort, existing?.ports.cloud, 3210, []);
  const site = await choosePort(opts.sitePort, existing?.ports.site, cloud + 1, [cloud]);
  const instanceSecret = existing?.instanceSecret ?? randomBytes(32).toString("hex");
  let adminKey = existing?.adminKey;
  if (!adminKey) {
    const k = Bun.spawn([bin, "keygen", "admin-key", "--instance-name", name, "--instance-secret", instanceSecret], {
      stdout: "pipe",
      stderr: "pipe",
    });
    adminKey = (await new Response(k.stdout).text()).trim();
    if ((await k.exited) !== 0 || !adminKey) throw new Error(`${bin} keygen admin-key failed`);
  }
  const dir = stateDir(io.cwd);
  mkdirSync(dir, { recursive: true });
  const child = Bun.spawn(
    [
      bin,
      "--port",
      String(cloud),
      "--site-proxy-port",
      String(site),
      "--instance-name",
      name,
      "--instance-secret",
      instanceSecret,
      "--local-storage",
      join(dir, "bunvex_local_storage"),
      join(dir, "bunvex_local_backend.sqlite3"),
    ],
    { cwd: dir, stdout: "ignore", stderr: "ignore" },
  );
  const stop = async () => {
    child.kill("SIGTERM");
    await child.exited;
  };
  const exitedEarly = child.exited.then(() => true);
  const timeoutMs = Number(io.env.BUNVEX_LOCAL_BACKEND_STARTUP_TIMEOUT_SECS ?? 30) * 1000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answer = await instanceNameAt(cloud);
    if (answer === name) break;
    if (answer !== null) {
      await stop();
      throw new Error(`A different local backend ${answer} is running on selected port ${cloud}`);
    }
    if (await Promise.race([exitedEarly, Bun.sleep(500).then(() => false)])) {
      throw new Error(`the local backend exited before it was ready (exit code ${child.exitCode})`);
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`the local backend did not start in ${timeoutMs / 1000}s`);
    }
  }
  const config: LocalConfig = {
    ports: { cloud, site },
    backendVersion: version,
    adminKey,
    instanceSecret,
    deploymentName: name,
  };
  saveLocalConfig(io.cwd, config);
  return { target: { url: `http://127.0.0.1:${cloud}`, adminKey }, config, stop };
}

/**
 * `BUNVEX_DEPLOYMENT` as Convex reads CONVEX_DEPLOYMENT: from `--env-file` alone when given, else the
 * environment, `.env.local` or `.env` (`deploymentVariables`).
 */
export function configuredDeployment(io: Io, flags: TargetFlags = {}): { type: string; name: string } | null {
  const v = deploymentVariables(flags, io)("BUNVEX_DEPLOYMENT");
  if (!v) return null;
  const i = v.indexOf(":");
  return i === -1 ? null : { type: v.slice(0, i), name: v.slice(v.lastIndexOf(":") + 1) };
}

/** The client's URL variables by the framework `package.json` uses (Convex's `envvars.ts`, bunvex's names). */
export function urlVariables(cwd: string): { url: string; site: string } {
  let deps: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as Record<string, Record<string, unknown>>;
    deps = { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    // no package.json: the plain names
  }
  const prefix = deps["react-scripts"]
    ? "REACT_APP_"
    : deps.next
      ? "NEXT_PUBLIC_"
      : deps.expo
        ? "EXPO_PUBLIC_"
        : deps["@sveltejs/kit"]
          ? "PUBLIC_"
          : deps["@tanstack/react-start"] || deps.vite
            ? "VITE_"
            : "";
  return { url: `${prefix}BUNVEX_URL`, site: `${prefix}BUNVEX_SITE_URL` };
}

/**
 * A dotenv file with `name` set to `value`, as Convex's `changedEnvVarFile` (cli/lib/envvars.ts), or null when
 * it already says so: a new file is the comment and the line; a variable already there (as dotenv reads the
 * file) has its line replaced, Convex's way (the first line starting with the name); otherwise the line goes at
 * the end after a blank line, below the comment.
 */
export function changedEnvVarFile(
  existing: string | null,
  name: string,
  value: string,
  commentOnPreviousLine: string | null,
): string | null {
  const line = `${name}=${value}`;
  const comment = commentOnPreviousLine === null ? "" : `${commentOnPreviousLine}\n`;
  if (existing === null) return `${comment}${line}\n`;
  const current = parseEnvFile(existing)[name];
  if (current === value) return null;
  if (current !== undefined) return existing.replace(new RegExp(`^${name}.*$`, "m"), line);
  return `${existing}${existing.endsWith("\n") ? "\n" : "\n\n"}${comment}${line}\n`;
}

/**
 * `.gitignore` with `.env.local` added, as Convex's `changesToGitIgnore` (cli/lib/deployment.ts), or null when
 * a line already covers it: `.env.local`, `.env.*`, `.env*`, `.env*.local` or any line ending in `.local`
 * (comments and negations do not count; trailing whitespace and `\r` are ignored).
 */
export function changesToGitIgnore(existing: string | null): string | null {
  if (existing === null) return ".env.local\n";
  const covers = [/^\.env\.local$/, /^\.env\.\*$/, /^\.env\*$/, /^.*\.local$/, /^\.env\*\.local$/];
  const ignored = existing
    .split("\n")
    .some((l) => !l.startsWith("#") && !l.startsWith("!") && covers.some((p) => p.test(l.trimEnd())));
  return ignored ? null : `${existing}\n.env.local\n`;
}

/**
 * Write the deployment into `.env.local` (Convex's `writeDeploymentEnvVar` and `writeUrlsToEnvFile`): each
 * variable through `changedEnvVarFile`, then `.env.local` added to `.gitignore` unless a line there covers it.
 */
export function writeEnvLocal(cwd: string, deploymentName: string, cloud: number, site: number) {
  const path = join(cwd, ".env.local");
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  let text = before;
  const set = (name: string, value: string, comment: string | null = null) => {
    text = changedEnvVarFile(text, name, value, comment) ?? text;
  };
  set("BUNVEX_DEPLOYMENT", `local:${deploymentName}`, "# Deployment used by `bunvex dev`");
  const vars = urlVariables(cwd);
  set(vars.url, `http://127.0.0.1:${cloud}`);
  set(vars.site, `http://127.0.0.1:${site}`);
  if (text !== null && text !== before) writeFileSync(path, text);
  const gitignore = join(cwd, ".gitignore");
  const ignore = changesToGitIgnore(existsSync(gitignore) ? readFileSync(gitignore, "utf8") : null);
  if (ignore !== null) writeFileSync(gitignore, ignore);
}

/** Forget the local deployment's state directory (tests; there is no command, as in Convex). */
export function removeLocalDeployment(cwd: string) {
  rmSync(join(cwd, ".bunvex"), { recursive: true, force: true });
}

/**
 * The deployment a one-off command (`deploy`, `run`, `env`) talks to: the flags' or BUNVEX_SELF_HOSTED_*'s,
 * else the project's local deployment (`BUNVEX_DEPLOYMENT=local:…`), started for the command when it is not
 * running and stopped after (Convex's `withRunningBackend`). Null when there is none.
 */
export async function acquireTarget(
  flags: TargetFlags,
  io: Io,
): Promise<{ target: Target; release: () => Promise<void> } | null> {
  const t = resolveTarget(flags, io);
  if (t) return { target: t, release: async () => {} };
  if (configuredDeployment(io, flags)?.type !== "local") return null;
  const c = readLocalConfig(io.cwd);
  if (!c) return null;
  if ((await instanceNameAt(c.ports.cloud)) === c.deploymentName)
    return { target: { url: `http://127.0.0.1:${c.ports.cloud}`, adminKey: c.adminKey }, release: async () => {} };
  const r = await startLocalDeployment(io, { backendVersion: c.backendVersion });
  return { target: r.target, release: r.stop };
}

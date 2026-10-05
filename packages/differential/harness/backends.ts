// The two backends of a differential run (STUDY-103): Convex's local backend (the oracle) and bunvex's,
// each fresh, each with the app of ../app deployed by its own CLI, as a user would. Calls go over the HTTP
// function API both serve (`/api/query`, `/api/mutation`), so both answer the same requests.
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE = resolve(import.meta.dir, "..");
const ROOT = resolve(PACKAGE, "../..");
const APP = join(PACKAGE, "app");
const BUNVEX_BACKEND = join(ROOT, "packages/bunvex/bin/local-backend.ts");
const BUNVEX_CLI = join(ROOT, "packages/bunvex/bin/bunvex.ts");

/** Where Convex's backend binary is: CONVEX_BACKEND_BIN, else what scripts/download-convex-backend.sh fetched. */
export const ORACLE_BIN = process.env.CONVEX_BACKEND_BIN ?? join(PACKAGE, ".cache/convex-local-backend");

export type Answer = { ok: true; status: number; body: unknown } | { ok: false; status: number; body: unknown };

export type Backend = {
  name: "convex" | "bunvex";
  url: string;
  /** Call a function of the app over HTTP: its JSON answer, whatever its status. */
  call: (kind: "query" | "mutation", path: string, args: unknown) => Promise<Answer>;
  stop: () => Promise<void>;
};

async function run(cmd: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")} failed (in ${cwd}):\n${out}\n${err}`);
  return out;
}

function freePorts(): [number, number] {
  const bindable = (port: number) => {
    try {
      Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
      return true;
    } catch {
      return false;
    }
  };
  for (;;) {
    const p = 20_000 + Math.floor(Math.random() * 12_000);
    if (bindable(p) && bindable(p + 1)) return [p, p + 1];
  }
}

async function waitFor(url: string, proc: ReturnType<typeof Bun.spawn>, what: string) {
  for (let i = 0; ; i++) {
    const ok = await fetch(url)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return;
    if (proc.exitCode !== null || i > 300) throw new Error(`${what} did not start`);
    await Bun.sleep(100);
  }
}

function caller(url: string): Backend["call"] {
  return async (kind, path, args) => {
    const r = await fetch(`${url}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" }),
    });
    const text = await r.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    const ok = r.ok && (body as { status?: string })?.status === "success";
    return { ok, status: r.status, body } as Answer;
  };
}

/** The app in a fresh project directory for one backend: `dir` is `convex` or `bunvex`, imports rewritten. */
function project(state: string, dir: "convex" | "bunvex"): string {
  const proj = join(state, "project");
  const functions = join(proj, dir);
  mkdirSync(functions, { recursive: true });
  for (const name of readdirSync(APP)) {
    if (!name.endsWith(".ts")) continue;
    let source = readFileSync(join(APP, name), "utf8");
    if (dir === "bunvex")
      source = source.replaceAll('"convex/server"', '"bunvex/server"').replaceAll('"convex/values"', '"bunvex/values"');
    writeFileSync(join(functions, name), source);
  }
  // Each CLI wants its package declared, as in a user's project.
  const dependencies = dir === "convex" ? { convex: "*" } : { bunvex: "*" };
  writeFileSync(
    join(proj, "package.json"),
    JSON.stringify({ name: "differential-app", private: true, type: "module", dependencies }),
  );
  // The CLI and the packages the app imports: this package's own node_modules.
  symlinkSync(join(PACKAGE, "node_modules"), join(proj, "node_modules"));
  return proj;
}

/** Convex's local backend on SQLite, with the app deployed by Convex's CLI. Never without --disable-beacon. */
export async function startConvex(): Promise<Backend> {
  if (!existsSync(ORACLE_BIN))
    throw new Error(
      `no Convex backend at ${ORACLE_BIN}: run scripts/download-convex-backend.sh or set CONVEX_BACKEND_BIN`,
    );
  const state = mkdtempSync(join(tmpdir(), "differential-convex-"));
  const [port, sitePort] = freePorts();
  const name = "differential";
  const secret = randomBytes(32).toString("hex");
  const url = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn(
    [
      ORACLE_BIN,
      join(state, "convex.sqlite3"),
      "--instance-name",
      name,
      "--instance-secret",
      secret,
      "--port",
      String(port),
      "--site-proxy-port",
      String(sitePort),
      "--local-storage",
      join(state, "storage"),
      "--disable-beacon",
    ],
    { cwd: state, stdout: "ignore", stderr: "ignore", env: { ...process.env, RUST_LOG: "warn" } },
  );
  const stop = async () => {
    proc.kill("SIGTERM");
    await proc.exited;
    rmSync(state, { recursive: true, force: true });
  };
  try {
    await waitFor(`${url}/version`, proc, "Convex's backend");
    const adminKey = (
      await run([ORACLE_BIN, "keygen", "admin-key", "--instance-name", name, "--instance-secret", secret], state)
    ).trim();
    const proj = project(state, "convex");
    await run([join(proj, "node_modules/.bin/convex"), "deploy", "--yes", "--typecheck=disable"], proj, {
      CONVEX_SELF_HOSTED_URL: url,
      CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
    });
    return { name: "convex", url, call: caller(url), stop };
  } catch (e) {
    await stop();
    throw e;
  }
}

/** bunvex's local backend, with the app deployed by bunvex's CLI. */
export async function startBunvex(): Promise<Backend> {
  const state = mkdtempSync(join(tmpdir(), "differential-bunvex-"));
  const [port, sitePort] = freePorts();
  const name = "differential";
  const secret = randomBytes(32).toString("hex");
  const url = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn(
    [
      process.execPath,
      BUNVEX_BACKEND,
      "--port",
      String(port),
      "--site-proxy-port",
      String(sitePort),
      "--instance-name",
      name,
      "--instance-secret",
      secret,
      "--local-storage",
      join(state, "storage"),
      join(state, "backend.sqlite3"),
    ],
    { cwd: state, stdout: "ignore", stderr: "ignore" },
  );
  const stop = async () => {
    proc.kill("SIGTERM");
    await proc.exited;
    rmSync(state, { recursive: true, force: true });
  };
  try {
    await waitFor(`${url}/instance_name`, proc, "bunvex's backend");
    const adminKey = (
      await run(
        [process.execPath, BUNVEX_BACKEND, "keygen", "admin-key", "--instance-name", name, "--instance-secret", secret],
        state,
      )
    ).trim();
    const proj = project(state, "bunvex");
    const envFile = join(state, "deployment.env");
    writeFileSync(envFile, `BUNVEX_SELF_HOSTED_URL=${url}\nBUNVEX_SELF_HOSTED_ADMIN_KEY=${adminKey}\n`);
    await run([process.execPath, BUNVEX_CLI, "deploy", "--typecheck=disable", "--env-file", envFile], proj);
    return { name: "bunvex", url, call: caller(url), stop };
  } catch (e) {
    await stop();
    throw e;
  }
}

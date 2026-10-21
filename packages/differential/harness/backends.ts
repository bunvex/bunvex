// The two backends of a differential run (STUDY-122): Convex's local backend (the oracle) and bunvex's,
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
  call: (kind: "query" | "mutation" | "action", path: string, args: unknown) => Promise<Answer>;
  /** Run the backend's own CLI (`convex` or `bunvex`) in the app's project, aimed at this backend: its output. */
  cli: (args: string[]) => Promise<string>;
  stop: () => Promise<void>;
  /** An admin key of the deployment (the admin API's tests, e.g. streaming import). */
  adminKey: string;
};

async function run(cmd: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")} failed (in ${cwd}):\n${out}\n${err}`);
  return out;
}

/** Two free ports in a row (an API port and its site port), as far as a bind can tell right now. */
export function freePorts(): [number, number] {
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

/** How a backend is started on two ports: its process, and what it wrote to stderr so far. */
type Launched = { proc: ReturnType<typeof Bun.spawn>; stderr: () => string };

/** Every backend process this harness launched that has not exited yet, by its own handle. */
const running = new Set<ReturnType<typeof Bun.spawn>>();

/** The PIDs of the backends this harness launched that are still running. */
export const runningBackends = (): number[] => [...running].map((p) => p.pid);

/**
 * Stop every backend this harness launched that is still running, by its own handle (SIGTERM, then SIGKILL after
 * `graceMs`), and wait for each to exit. The backstop of a run (`preload.ts`): a test that fails between a start
 * and its `stop` leaves nothing behind once the run ends.
 */
export async function stopEveryBackend(graceMs = 10_000): Promise<void> {
  await Promise.all(
    [...running].map(async (proc) => {
      proc.kill("SIGTERM");
      const killer = setTimeout(() => proc.kill("SIGKILL"), graceMs);
      await proc.exited;
      clearTimeout(killer);
    }),
  );
}

/**
 * Start backends together, as `Promise.all` would, except that a start that fails does not leave the others
 * running: every start is waited for, those that came up are stopped, and the first failure is thrown. With
 * `Promise.all`, a Convex start that failed at once left bunvex's backend starting, with no handle to stop it by.
 */
export async function startAll<const T extends readonly Promise<Backend>[]>(
  starts: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const settled = await Promise.allSettled(starts);
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (!failed) return settled.map((s) => (s as PromiseFulfilledResult<Backend>).value) as never;
  await Promise.all(settled.map((s) => (s.status === "fulfilled" ? s.value.stop() : null)));
  throw failed.reason;
}

function launch(cmd: string[], cwd: string, env: Record<string, string> = {}): Launched {
  const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "ignore", stderr: "pipe" });
  running.add(proc);
  void proc.exited.then(() => running.delete(proc));
  let err = "";
  (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>)
      err = (err + decoder.decode(chunk)).slice(-4000);
  })().catch(() => {});
  return { proc, stderr: () => err };
}

/** The backend did not come up on its ports (they were taken, or it failed): another pair may do. */
class NotStarted extends Error {}

/**
 * Wait until the backend answers as itself: `/instance_name` is its own (unique) name while its process is
 * alive. A port another process holds, answering anything, is never taken for it.
 */
async function waitUntilUp(url: string, name: string, l: Launched, what: string) {
  for (let i = 0; i < 300; i++) {
    if (l.proc.exitCode !== null) throw new NotStarted(`${what} exited at start:\n${l.stderr().trim()}`);
    const answer = await fetch(`${url}/instance_name`)
      .then((r) => (r.ok ? r.text() : null))
      .catch(() => null);
    if (answer === name && l.proc.exitCode === null) return;
    await Bun.sleep(100);
  }
  throw new NotStarted(`${what} did not answer as ${name} within 30 s:\n${l.stderr().trim()}`);
}

export type StartOptions = {
  /** The ports to try (tests): `freePorts` by default. */
  pickPorts?: () => [number, number];
  /**
   * A store kept across backends (the cross-open tests, STUDY-133 Q11): its directory (`store.sqlite3` and
   * `storage/` in it), the instance's name and secret. It outlives `stop`, so the other binary can open it.
   */
  store?: { dir: string; name: string; secret: string };
  /** The app to deploy: a directory of function files written for Convex (`app/` by default). */
  app?: string;
  /** Environment variables for the backend's process (a knob such as `V8_ACTION_USER_TIMEOUT_SECS`). */
  env?: Record<string, string>;
  /** Change the project before its CLI deploys it (packages, `package.json`, the config file; STUDY-148). */
  prepare?: (project: string, dir: "convex" | "bunvex") => void;
};

/** A store a backend can be started on, then the other one (the cross-open tests). */
export function newStore(): { dir: string; name: string; secret: string } {
  return {
    dir: mkdtempSync(join(tmpdir(), "cross-open-")),
    name: `cross-open-${randomBytes(4).toString("hex")}`,
    secret: randomBytes(32).toString("hex"),
  };
}

/** Where a backend keeps its data: the kept store, or a fresh directory for this attempt. */
const storeFiles = (state: string, opts: StartOptions, file: string) => {
  const dir = opts.store?.dir ?? mkdtempSync(join(state, "attempt-"));
  return { db: join(dir, opts.store ? "store.sqlite3" : file), storage: join(dir, "storage") };
};

/**
 * Start a backend on free ports, as itself: a pair taken between the check and the start, or held by another
 * server, is given up for another, five times at most (the last failure says why).
 */
async function startOnFreePorts(
  what: string,
  opts: StartOptions,
  start: (ports: [number, number], name: string) => Launched,
): Promise<{ url: string; name: string; launched: Launched; ports: [number, number] }> {
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const ports = (opts.pickPorts ?? freePorts)();
    const name = opts.store?.name ?? `differential-${randomBytes(4).toString("hex")}`;
    const url = `http://127.0.0.1:${ports[0]}`;
    const launched = start(ports, name);
    try {
      await waitUntilUp(url, name, launched, what);
      return { url, name, launched, ports };
    } catch (e) {
      launched.proc.kill("SIGKILL");
      await launched.proc.exited;
      if (!(e instanceof NotStarted)) throw e;
      last = e;
    }
  }
  throw last;
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
function project(state: string, dir: "convex" | "bunvex", app = APP, prepare?: StartOptions["prepare"]): string {
  const proj = join(state, "project");
  const functions = join(proj, dir);
  mkdirSync(functions, { recursive: true });
  for (const name of readdirSync(app)) {
    if (!name.endsWith(".ts")) continue;
    let source = readFileSync(join(app, name), "utf8");
    if (dir === "bunvex")
      source = source
        .replaceAll('"convex/server"', '"bunvex/server"')
        .replaceAll('"convex/values"', '"bunvex/values"')
        // bunvex's name for Convex's application error class (DV-03).
        .replaceAll("ConvexError", "BunvexError");
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
  prepare?.(proj, dir);
  return proj;
}

/** Convex's local backend on SQLite, with the app deployed by Convex's CLI. Never without --disable-beacon. */
export async function startConvex(opts: StartOptions = {}): Promise<Backend> {
  if (!existsSync(ORACLE_BIN))
    throw new Error(
      `no Convex backend at ${ORACLE_BIN}: run scripts/download-convex-backend.sh or set CONVEX_BACKEND_BIN`,
    );
  const state = mkdtempSync(join(tmpdir(), "differential-convex-"));
  const secret = opts.store?.secret ?? randomBytes(32).toString("hex");
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  const stop = async () => {
    proc?.kill("SIGTERM");
    await proc?.exited;
    rmSync(state, { recursive: true, force: true });
  };
  try {
    const up = await startOnFreePorts("Convex's backend", opts, ([port, sitePort], name) => {
      // Each attempt on a store of its own (a failed one leaves nothing for the next), unless one is kept.
      const files = storeFiles(state, opts, "convex.sqlite3");
      return launch(
        [
          ORACLE_BIN,
          files.db,
          "--instance-name",
          name,
          "--instance-secret",
          secret,
          "--port",
          String(port),
          "--site-proxy-port",
          String(sitePort),
          "--local-storage",
          files.storage,
          "--disable-beacon",
        ],
        state,
        { RUST_LOG: "warn", ...opts.env },
      );
    });
    proc = up.launched.proc;
    const adminKey = (
      await run([ORACLE_BIN, "keygen", "admin-key", "--instance-name", up.name, "--instance-secret", secret], state)
    ).trim();
    const proj = project(state, "convex", opts.app, opts.prepare);
    const cli = (args: string[]) =>
      run([join(proj, "node_modules/.bin/convex"), ...args], proj, {
        CONVEX_SELF_HOSTED_URL: up.url,
        CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
      });
    await cli(["deploy", "--yes", "--typecheck=disable"]);
    return { name: "convex", url: up.url, call: caller(up.url), cli, stop, adminKey };
  } catch (e) {
    await stop();
    throw e;
  }
}

/** bunvex's local backend, with the app deployed by bunvex's CLI. */
export async function startBunvex(opts: StartOptions = {}): Promise<Backend> {
  const state = mkdtempSync(join(tmpdir(), "differential-bunvex-"));
  const secret = opts.store?.secret ?? randomBytes(32).toString("hex");
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  const stop = async () => {
    proc?.kill("SIGTERM");
    await proc?.exited;
    rmSync(state, { recursive: true, force: true });
  };
  try {
    const up = await startOnFreePorts("bunvex's backend", opts, ([port, sitePort], name) => {
      // Each attempt on a store of its own (a failed one leaves nothing for the next), unless one is kept.
      const files = storeFiles(state, opts, "backend.sqlite3");
      return launch(
        [
          process.execPath,
          BUNVEX_BACKEND,
          "--port",
          String(port),
          "--site-proxy-port",
          String(sitePort),
          "--instance-name",
          name,
          "--local-storage",
          files.storage,
          files.db,
        ],
        state,
        // The secret in the environment, as `bunvex dev` gives it (DV-525); Convex's binary takes the flag only.
        { ...opts.env, INSTANCE_SECRET: secret },
      );
    });
    proc = up.launched.proc;
    const adminKey = (
      await run([process.execPath, BUNVEX_BACKEND, "keygen", "admin-key", "--instance-name", up.name], state, {
        INSTANCE_SECRET: secret,
      })
    ).trim();
    const proj = project(state, "bunvex", opts.app, opts.prepare);
    const envFile = join(state, "deployment.env");
    writeFileSync(envFile, `BUNVEX_SELF_HOSTED_URL=${up.url}\nBUNVEX_SELF_HOSTED_ADMIN_KEY=${adminKey}\n`);
    const cli = (args: string[]) => run([process.execPath, BUNVEX_CLI, ...args, "--env-file", envFile], proj);
    await cli(["deploy", "--typecheck=disable"]);
    return { name: "bunvex", url: up.url, call: caller(up.url), cli, stop, adminKey };
  } catch (e) {
    await stop();
    throw e;
  }
}

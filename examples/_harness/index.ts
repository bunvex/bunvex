// The examples' end-to-end helper (STUDY-90). `deploy(dir)` runs the backend as `bunvex-local-backend`
// (the same program the release compiles, run by Bun), takes an admin key from its `keygen`, and runs
// `bunvex deploy` in the example, as a self-hosted user would; `build(dir)` typechecks and builds its front
// end. Every step goes through the CLI and the public client, never the server's internals.
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BunvexClient, BunvexHttpClient } from "bunvex/browser";

const ROOT = resolve(import.meta.dir, "../..");
const BACKEND = join(ROOT, "packages/bunvex/bin/local-backend.ts");
const CLI = join(ROOT, "packages/bunvex/bin/bunvex.ts");

/** Run a command; its output is returned, and thrown with it when it fails. */
async function run(cmd: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")} failed (in ${cwd}):\n${out}\n${err}`);
  return out;
}

const bindable = (port: number) => {
  try {
    Bun.listen({ hostname: "0.0.0.0", port, socket: { data() {} } }).stop(true);
    return true;
  } catch {
    return false;
  }
};
/** Two free ports in a row, below the OS's ephemeral range (whose ports other connections may take). */
function freePorts(): [number, number] {
  for (;;) {
    const p = 20_000 + Math.floor(Math.random() * 12_000);
    if (bindable(p) && bindable(p + 1)) return [p, p + 1];
  }
}

/** Every file under `dir`, as path → content. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) for (const [k, v] of snapshot(p)) out.set(join(name, k), v);
    else out.set(name, readFileSync(p, "utf8"));
  }
  return out;
}

export type Deployment = {
  url: string;
  siteUrl: string;
  adminKey: string;
  /** Calls over HTTP. */
  http: BunvexHttpClient;
  /** A sync client (subscriptions); closed by `stop`. */
  client: () => BunvexClient;
  /** Run a CLI command in the example against this deployment. */
  cli: (...args: string[]) => Promise<string>;
  stop: () => Promise<void>;
};

/**
 * Deploy the example at `dir` to a fresh backend. The example's committed `bunvex/_generated/` must be what
 * the deploy's codegen writes: an example never ships stale generated code.
 */
export async function deploy(dir: string): Promise<Deployment> {
  const state = mkdtempSync(join(tmpdir(), "bunvex-example-"));
  const [port, sitePort] = freePorts();
  const name = "bunvex-example";
  const secret = randomBytes(32).toString("hex");
  const backend = Bun.spawn(
    [
      process.execPath,
      BACKEND,
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
    { cwd: state, stdout: "ignore", stderr: "pipe" },
  );
  const clients: BunvexClient[] = [];
  const stop = async () => {
    for (const c of clients) await c.close();
    backend.kill("SIGTERM");
    await backend.exited;
    rmSync(state, { recursive: true, force: true });
  };
  try {
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; ; i++) {
      const answer = await fetch(`${url}/instance_name`)
        .then((r) => r.text())
        .catch(() => null);
      if (answer === name) break;
      if (backend.exitCode !== null || i > 300)
        throw new Error(`the backend did not start:\n${await new Response(backend.stderr).text()}`);
      await Bun.sleep(100);
    }
    const adminKey = (
      await run(
        [process.execPath, BACKEND, "keygen", "admin-key", "--instance-name", name, "--instance-secret", secret],
        state,
      )
    ).trim();
    const env = { BUNVEX_SELF_HOSTED_URL: url, BUNVEX_SELF_HOSTED_ADMIN_KEY: adminKey };
    const cli = (...args: string[]) => run([process.execPath, CLI, ...args], dir, env);
    const generated = join(dir, "bunvex/_generated");
    const before = snapshot(generated);
    await cli("deploy", "--typecheck=enable");
    const after = snapshot(generated);
    if (JSON.stringify([...before].sort()) !== JSON.stringify([...after].sort()))
      throw new Error(`${generated} was stale: the deploy's codegen rewrote it. Commit the regenerated files.`);
    return {
      url,
      siteUrl: `http://127.0.0.1:${sitePort}`,
      adminKey,
      http: new BunvexHttpClient(url, { logger: false }),
      client: () => {
        const c = new BunvexClient(url, { logger: false });
        clients.push(c);
        return c;
      },
      cli,
      stop,
    };
  } catch (e) {
    await stop();
    throw e;
  }
}

/** Run the example's `build` script: its front end typechecked, then bundled. */
export async function build(dir: string): Promise<void> {
  await run([process.execPath, "run", "build"], dir);
}

/** Wait until `f` returns something truthy (polled every 10 ms, for up to 10 s). */
export async function until<T>(f: () => T | undefined | null | false, what = "condition"): Promise<T> {
  for (let i = 0; i < 1000; i++) {
    const x = f();
    if (x) return x;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

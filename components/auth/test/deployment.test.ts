// The core on a deployed server (STUDY-208 §3.1, beyond upstream's suite): the local backend on a SQLite file, its
// functions on execution workers (`MAX_ISOLATE_WORKERS`), and `bunvex deploy` pushing the fixture apps, each run as its
// own process, as a self-hosted user runs them (a component's tests import neither the server's internals nor the CLI,
// rule 1). It checks what `@bunvex/testing` cannot show:
//
// - `BUNVEX_CLOUD_URL` read inside the core, on a worker, is the origin `signJwt` signs with, also with a canonical
//   cloud URL: otherwise the mount check would find no component path in the issuer and let any mount through;
// - a sign-out's tokens are erased by the scheduled `sessions:deleteSessionTokens`, on the real scheduler;
// - an invalid `setupAuth` configuration fails `bunvex deploy` with its message.
// biome-ignore-all lint/suspicious/noExplicitAny: the functions' values are untyped over HTTP
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const BACKEND = join(ROOT, "apps/local-backend/local-backend.ts");
const CLI = join(ROOT, "packages/cli/bin/bunvex.ts");
const FIXTURES = join(import.meta.dir, "fixtures");
const PASSWORD = "correct horse battery staple";
const MOUNT_ERROR =
  'The auth component is mounted at "myAuth", but it must be mounted at "auth". Use `app.use(auth)` in ' +
  "bunvex.config.ts, without a `name` option.";

// A backend starts, then a push bundles the app and its components.
setDefaultTimeout(120_000);
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

/** A command's exit code and output (stdout, then stderr). */
async function run(cmd: string[], cwd: string, env: Record<string, string> = {}) {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, output: `${out}\n${err}` };
}

/** Two free ports in a row, below the OS's ephemeral range. */
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

/** The local backend on a SQLite file of its own, with two execution workers. */
async function backend() {
  const state = mkdtempSync(join(tmpdir(), "bunvex-auth-deployment-"));
  const [port, sitePort] = freePorts();
  const name = "bunvex-auth-test";
  const secret = randomBytes(32).toString("hex");
  const env = { INSTANCE_SECRET: secret, MAX_ISOLATE_WORKERS: "2" };
  const p = Bun.spawn(
    [
      process.execPath,
      BACKEND,
      "--port",
      String(port),
      "--site-proxy-port",
      String(sitePort),
      "--instance-name",
      name,
      "--local-storage",
      join(state, "storage"),
      join(state, "backend.sqlite3"),
    ],
    { cwd: state, env: { ...process.env, ...env }, stdout: "ignore", stderr: "pipe" },
  );
  stops.push(async () => {
    p.kill("SIGTERM");
    await p.exited;
    rmSync(state, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    const answer = await fetch(`${url}/instance_name`)
      .then((r) => r.text())
      .catch(() => null);
    if (answer === name) break;
    if (p.exitCode !== null || i > 300)
      throw new Error(`the backend did not start:\n${await new Response(p.stderr).text()}`);
    await Bun.sleep(100);
  }
  const keygen = await run([process.execPath, BACKEND, "keygen", "admin-key", "--instance-name", name], state, env);
  if (keygen.code !== 0) throw new Error(keygen.output);
  const adminKey = keygen.output.trim();
  const cli = (dir: string, ...args: string[]) =>
    run([process.execPath, CLI, ...args, "--url", url, "--admin-key", adminKey], dir);
  const deploy = (fixture: string) =>
    cli(join(FIXTURES, fixture), "deploy", "--typecheck=disable", "--codegen=disable");
  /** A client's call, as the HTTP client sends it: the value, or the error's message. */
  const call = async (kind: "query" | "mutation", path: string, args: object, token?: string) => {
    const r = await fetch(`${url}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ path, args, format: "json" }),
    });
    return (await r.json()) as { status: "success"; value: any } | { status: "error"; errorMessage: string };
  };
  const setCanonicalCloudUrl = async (canonical: string) => {
    const r = await fetch(`${url}/api/v1/update_canonical_url`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bunvex ${adminKey}` },
      body: JSON.stringify({ requestDestination: "bunvexCloud", url: canonical }),
    });
    if (!r.ok) throw new Error(`update_canonical_url: ${r.status} ${await r.text()}`);
  };
  return { url, cli, deploy, call, setCanonicalCloudUrl };
}

/** A JWT's payload, unverified. */
const claimsOf = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { iss: string; sub: string };

describe("the core on a SQLite store with execution workers", () => {
  test("a sign-up's token names the core at `auth`, and a sign-out's tokens are erased by the scheduled job", async () => {
    const b = await backend();
    const deployed = await b.deploy("app");
    expect(deployed.code, deployed.output).toBe(0);

    const up = await b.call("mutation", "auth:signUpWithUsernamePassword", { username: "alice", password: PASSWORD });
    if (up.status !== "success") throw new Error(up.errorMessage);
    const tokens = up.value.tokens as { accessToken: string; refreshToken: string; userId: string };
    // The issuer the mount check read its component path from: the core's, under the server's origin.
    expect(claimsOf(tokens.accessToken).iss).toBe(`${b.url}/components/auth`);
    // The provider of `auth.config.ts` accepts it, and the session names the user.
    expect(await b.call("query", "auth:me", {}, tokens.accessToken)).toEqual({
      status: "success",
      value: tokens.userId,
    });

    expect((await b.call("mutation", "auth:signOut", { refreshToken: tokens.refreshToken })).status).toBe("success");
    expect(await b.call("query", "auth:me", {}, tokens.accessToken)).toEqual({ status: "success", value: null });
    // The session's row went with the sign-out; its token's row goes with the job, run as soon as it is due.
    let jobs = "";
    for (let i = 0; i < 100; i++) {
      jobs = (await b.cli(FIXTURES, "data", "--component", "auth", "_scheduled_functions")).output;
      if (jobs.includes('"kind": "success"')) break;
      await Bun.sleep(100);
    }
    expect(jobs).toMatch(/sessions(\.js)?:deleteSessionTokens/);
    expect(jobs).toContain('{ "kind": "success" }');
    expect((await b.cli(FIXTURES, "data", "--component", "auth", "refreshTokens")).output).toContain(
      "There are no documents in this table.",
    );
    // The session's own row went at the sign-out.
    expect((await b.cli(FIXTURES, "data", "--component", "auth", "sessions")).output).toContain(
      "There are no documents in this table.",
    );
  });

  test("a core mounted under another name fails the sign-up, also with a canonical cloud URL", async () => {
    const b = await backend();
    const deployed = await b.deploy("misnamed-app");
    expect(deployed.code, deployed.output).toBe(0);

    const signUp = () =>
      b.call("mutation", "auth:signUpWithUsernamePassword", { username: "alice", password: PASSWORD });
    // Had the core read another origin than the one `signJwt` signs with, it would find no component path in the
    // issuer, and the sign-up would go through.
    expect(await signUp()).toMatchObject({ status: "error", errorMessage: expect.stringContaining(MOUNT_ERROR) });
    // The canonical URL replaces both: the core reads it, and `signJwt` signs with it.
    await b.setCanonicalCloudUrl("https://auth.bunvex.example");
    expect(await signUp()).toMatchObject({ status: "error", errorMessage: expect.stringContaining(MOUNT_ERROR) });
  });

  test("an invalid setupAuth configuration fails `bunvex deploy` with its message", async () => {
    const b = await backend();
    const deployed = await b.deploy("bad-ttl-app");
    expect(deployed.code).not.toBe(0);
    expect(deployed.output).toContain("Refresh inactivity timeout must be at most the session max lifetime.");
  });
});

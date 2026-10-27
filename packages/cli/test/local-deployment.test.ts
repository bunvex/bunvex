// Local deployments (STUDY-40 L3–L5), as Convex's `npx convex dev` runs them: `bunvex dev` with nothing
// configured creates the project's deployment (state in .bunvex/local/default/, .env.local), runs
// bunvex-local-backend as a child and stops it after; the next run resumes it; one-off commands start it for
// themselves; the executable is downloaded from the latest release (here a local server) and upgraded on ask.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { devCommand } from "../src/dev.ts";
import { type Io, main } from "../src/index.ts";
import { ensureDashboardDownloaded } from "../src/local-dashboard.ts";
import {
  acquireTarget,
  assetName,
  backendLogPath,
  changedEnvVarFile,
  changesToGitIgnore,
  EXE,
  forgetLatestVersion,
  isValidBackendVersion,
  latestVersion,
  readLocalConfig,
  startLocalDeployment,
  unzipOne,
  urlVariables,
  writeEnvLocal,
} from "../src/local-deployment.ts";

const ENTRY = resolve(import.meta.dir, "../../bunvex/bin/local-backend.ts");
const SERVER = ["bunvex", "server"].join("/");
const dirs: string[] = [];
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-local-"));
  dirs.push(d);
  return d;
};
/** A stand-in for the released executable: the same program, run by Bun. */
/**
 * `zip -q -j <args>`, run to its end. Async: on a loaded CI runner other tests' `Bun.spawnSync` once sat until
 * the test timeout killed a child that had done its work ("killed 1 dangling process").
 */
async function zip(...args: string[]) {
  const code = await Bun.spawn(["zip", "-q", "-j", ...args], { stdin: "ignore", stdout: "ignore", stderr: "inherit" })
    .exited;
  if (code !== 0) throw new Error(`zip ${args.join(" ")} exited ${code}`);
}

function shim(dir: string, version = "test-1") {
  const p = join(dir, EXE);
  writeFileSync(
    p,
    `#!/bin/sh\n[ "$1" = --version ] && echo "bunvex-local-backend ${version}" && exit 0\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(ENTRY)} "$@"\n`,
  );
  chmodSync(p, 0o755);
  return p;
}
const bindable = (port: number) => {
  try {
    Bun.listen({ hostname: "0.0.0.0", port, socket: { data() {} } }).stop(true);
    return true;
  } catch {
    return false;
  }
};
/**
 * A free port whose next one (the site port) is free too, below the OS's ephemeral range: a port from
 * `port: 0` comes from that range, where outgoing connections from any process can take it, or the next one,
 * before the backend binds.
 */
const freePort = () => {
  for (;;) {
    const p = 20_000 + Math.floor(Math.random() * 12_000);
    if (bindable(p) && bindable(p + 1)) return p;
  }
};
const portBusy = async (port: number) => {
  try {
    await fetch(`http://127.0.0.1:${port}/instance_name`, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
};
function io(cwd: string, env: Record<string, string | undefined>) {
  const out: string[] = [];
  const err: string[] = [];
  const it: Io = { env, cwd, out: (l) => out.push(l), err: (l) => err.push(l) };
  return { it, out, err };
}
function app(files: Record<string, string> = {}) {
  const d = tmp();
  mkdirSync(join(d, "bunvex"));
  writeFileSync(
    join(d, "bunvex/items.ts"),
    `import { mutation, query } from ${JSON.stringify(SERVER)};
export const add = mutation(async ({ db }, { n }) => { await db.insert("items", { n }); });
export const all = query(async ({ db }) => (await db.query("items").collect()).map((d) => d.n));`,
  );
  for (const [p, t] of Object.entries(files)) writeFileSync(join(d, p), t);
  return d;
}

describe("bunvex dev with a local deployment", () => {
  test("first run: the deployment is created, pushed to, and stopped; the next run resumes it", async () => {
    const dir = app({ "package.json": JSON.stringify({ devDependencies: { vite: "^7" } }) });
    const env = { BUNVEX_LOCAL_BACKEND_BINARY: shim(tmp()), HOME: tmp() };
    const cloud = freePort();
    const r = io(dir, env);
    expect(await devCommand(["--once", "--typecheck=disable", "--local-cloud-port", String(cloud)], r.it)).toBe(0);
    expect(r.err.join("\n")).toContain(
      [
        "Setting up a new project...",
        `✔ Configured a local deployment for http://127.0.0.1:${cloud} and saved its:\n    name as BUNVEX_DEPLOYMENT\n    client URL as VITE_BUNVEX_URL\n    HTTP actions URL as VITE_BUNVEX_SITE_URL\n to .env.local\n  Added ".env.local" to .gitignore`,
        "\nWrite your bunvex functions in bunvex/\nGive us feedback at https://github.com/bunvex/bunvex/issues\n",
      ].join("\n"),
    );
    const name = `local-${dir
      .split("/")
      .at(-1)!
      .replace(/[^A-Za-z0-9_-]/g, "_")}`;
    const config = readLocalConfig(dir)!;
    expect(config).toMatchObject({ ports: { cloud }, backendVersion: "test-1", deploymentName: name });
    expect(config.instanceSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(config.adminKey).toStartWith(`${name}|`);
    expect(readFileSync(join(dir, ".bunvex/.gitignore"), "utf8")).toBe("/*\n");
    expect(existsSync(join(dir, ".bunvex/local/default/bunvex_local_backend.sqlite3"))).toBe(true);
    expect(readFileSync(join(dir, ".env.local"), "utf8")).toBe(
      // As Convex's: each variable added after a blank line.
      `# Deployment used by \`bunvex dev\`\nBUNVEX_DEPLOYMENT=local:${name}\n\nVITE_BUNVEX_URL=http://127.0.0.1:${cloud}\n\nVITE_BUNVEX_SITE_URL=http://127.0.0.1:${config.ports.site}\n`,
    );
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".env.local\n");
    // The backend stopped with dev.
    expect(await portBusy(cloud)).toBe(false);
    // A one-off command starts it for itself (Convex's withRunningBackend), and stops it after.
    expect(await main(["run", "items:add", "{ n: 7 }"], io(dir, env).it)).toBe(0);
    expect(await portBusy(cloud)).toBe(false);
    // The next dev resumes the same deployment: same ports, same data, .env.local unchanged.
    const again = io(dir, env);
    expect(await devCommand(["--once", "--typecheck=disable", "--run", "items:all"], again.it)).toBe(0);
    expect(again.out).toEqual(["[\n  7\n]"]);
    expect(readLocalConfig(dir)!.ports).toEqual(config.ports);
  }, 60_000);

  test("first run on a terminal: Convex's introduction and Continue?; no stops with Exiting", async () => {
    const dir = app();
    const env = { BUNVEX_LOCAL_BACKEND_BINARY: shim(tmp()), HOME: tmp() };
    const asked: string[] = [];
    const no = io(dir, env);
    no.it.prompt = (q) => {
      asked.push(q);
      return "n";
    };
    expect(await devCommand(["--once", "--typecheck=disable", "--local-cloud-port", String(freePort())], no.it)).toBe(
      1,
    );
    expect(no.err).toEqual([
      "Setting up a new project...",
      "This command, `bunvex dev`, will run your bunvex backend locally and update it with the function you write in the `bunvex/` directory.",
      "Use `bunvex dashboard` to view and interact with your project from a web UI.",
      "Use `bunvex docs` to read the docs and `bunvex help` to see other commands.",
      "Exiting",
    ]);
    expect(asked).toEqual(["Continue? (Y/n)"]);
    expect(readLocalConfig(dir)).toBeNull();
    // yes (Enter): it goes on; the next run asks nothing and says nothing of the configuration
    const yes = io(dir, env);
    yes.it.prompt = () => "";
    expect(await devCommand(["--once", "--typecheck=disable", "--local-cloud-port", String(freePort())], yes.it)).toBe(
      0,
    );
    expect(yes.err.join("\n")).toContain("✔ Configured a local deployment for ");
    const again = io(dir, env);
    again.it.prompt = () => {
      throw new Error("asked again");
    };
    expect(await devCommand(["--once", "--typecheck=disable"], again.it)).toBe(0);
    expect(again.err.some((l) => /Setting up|Configured|Write your/.test(l))).toBe(false);
    expect(again.err.join("\n")).toContain(
      `▌ Developing against deployment:\n▌ [Local] Port ${readLocalConfig(dir)!.ports.cloud}\n▌ └─ http://127.0.0.1:`,
    );
  }, 60_000);

  test("still running, a busy requested port, --local-* with a self-hosted deployment", async () => {
    const dir = app();
    const env = { BUNVEX_LOCAL_BACKEND_BINARY: shim(tmp()), HOME: tmp() };
    const running = await startLocalDeployment(io(dir, env).it, { cloudPort: freePort() });
    stops.push(running.stop);
    await expect(startLocalDeployment(io(dir, env).it)).rejects.toThrow(
      `A local backend is still running on port ${running.config.ports.cloud}. Please stop it and run this command again.`,
    );
    // While dev (or anything) runs it, one-off commands use it as it is.
    const acquired = await acquireTarget(
      {},
      io(dir, { ...env, BUNVEX_DEPLOYMENT: `local:${running.config.deploymentName}` }).it,
    );
    expect(acquired?.target.url).toBe(running.target.url);
    await acquired!.release();
    expect(await portBusy(running.config.ports.cloud)).toBe(true);
    await expect(startLocalDeployment(io(app(), env).it, { cloudPort: running.config.ports.cloud })).rejects.toThrow(
      `Requested port ${running.config.ports.cloud} is not available`,
    );
    const selfHosted = io(dir, { BUNVEX_SELF_HOSTED_URL: "http://127.0.0.1:1", BUNVEX_SELF_HOSTED_ADMIN_KEY: "k" });
    expect(await devCommand(["--once", "--local-cloud-port", "4000"], selfHosted.it)).toBe(1);
    expect(selfHosted.err[0]).toBe("bunvex dev: the --local-* options are only for a local deployment");
  }, 60_000);
});

describe("the local backend's log (DV-340)", () => {
  test("its output is appended to .bunvex/local/default/backend.log, one marked run after another", async () => {
    const dir = app();
    const env = { BUNVEX_LOCAL_BACKEND_BINARY: shim(tmp()), HOME: tmp() };
    for (let run = 0; run < 2; run++) {
      const running = await startLocalDeployment(io(dir, env).it, { cloudPort: run === 0 ? freePort() : undefined });
      await running.stop();
    }
    const log = readFileSync(backendLogPath(dir), "utf8");
    expect(backendLogPath(dir)).toBe(join(dir, ".bunvex/local/default/backend.log"));
    expect(log.match(/^--- \S+ bunvex-local-backend test-1 ---$/gm)).toHaveLength(2);
    // The backend's own startup line, which `bunvex dev` used to discard.
    expect(log).toContain(`instance ${readLocalConfig(dir)!.deploymentName}`);
  }, 60_000);

  test("the secret reaches keygen and the backend in INSTANCE_SECRET, never on a command line (DV-525)", async () => {
    // The stand-in records each run's arguments and INSTANCE_SECRET but `--help`'s (the probe for the variable),
    // and the backend's pid (exec keeps it).
    const rec = tmp();
    const recorder = (help: string) => {
      const p = join(tmp(), EXE);
      writeFileSync(
        p,
        `#!/bin/sh
[ "$1" = --version ] && echo "bunvex-local-backend test-1" && exit 0
${help}
[ "$1" = --help ] && exec ${JSON.stringify(process.execPath)} ${JSON.stringify(ENTRY)} --help
printf '%s\\n' "$*" >>${JSON.stringify(join(rec, "argv"))}
printf '%s\\n' "\${INSTANCE_SECRET:-}" >>${JSON.stringify(join(rec, "env"))}
[ "$1" = keygen ] || echo $$ >${JSON.stringify(join(rec, "pid"))}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(ENTRY)} "$@"
`,
      );
      chmodSync(p, 0o755);
      return p;
    };
    const dir = app();
    // A stray INSTANCE_SECRET in the user's shell is not the deployment's.
    process.env.INSTANCE_SECRET = "ef".repeat(32);
    let running: Awaited<ReturnType<typeof startLocalDeployment>>;
    try {
      running = await startLocalDeployment(io(dir, { BUNVEX_LOCAL_BACKEND_BINARY: recorder(""), HOME: tmp() }).it, {
        cloudPort: freePort(),
      });
    } finally {
      delete process.env.INSTANCE_SECRET;
    }
    stops.push(running.stop);
    const secret = running.config.instanceSecret;
    const lines = (f: string) => readFileSync(join(rec, f), "utf8").trimEnd().split("\n");
    // keygen, then the backend: both given the secret in their environment, neither on the command line.
    expect(lines("argv")).toHaveLength(2);
    expect(lines("argv")[0]).toStartWith("keygen admin-key --instance-name ");
    for (const l of lines("argv")) expect(l).not.toContain(secret);
    expect(lines("env")).toEqual([secret, secret]);
    // The running backend's command line, as any user of the machine reads it.
    const pid = readFileSync(join(rec, "pid"), "utf8").trim();
    const ps = Bun.spawn(["ps", "-o", "args=", "-p", pid], { stdout: "pipe", stderr: "ignore" });
    const args = (await new Response(ps.stdout).text()).trim();
    expect(args).toContain("--instance-name");
    expect(args).not.toContain(secret);
    // The key keygen made opens the backend: the secret it read is the backend's.
    const ok = await fetch(`${running.target.url}/api/check_admin_key`, {
      headers: { authorization: `Bunvex ${running.config.adminKey}` },
    });
    expect(ok.status).toBe(200);
    await running.stop();
    stops.pop();

    // An executable from before the variable (its --help does not name it) still gets the flag.
    for (const f of ["argv", "env"]) rmSync(join(rec, f));
    rmSync(join(dir, ".bunvex/local/default/config.json"));
    const old = recorder(`[ "$1" = --help ] && echo "Usage: bunvex-local-backend [options]" && exit 0`);
    const again = await startLocalDeployment(io(dir, { BUNVEX_LOCAL_BACKEND_BINARY: old, HOME: tmp() }).it, {
      cloudPort: running.config.ports.cloud,
    });
    stops.push(again.stop);
    expect(lines("argv").map((l) => l.includes(`--instance-secret ${again.config.instanceSecret}`))).toEqual([
      true,
      true,
    ]);
  }, 60_000);

  test("a TZ in the user's shell does not stop the backend: it is started in UTC (DV-537)", async () => {
    // The stand-in records the TZ it was started with, then runs the backend, which refuses any TZ but UTC.
    const rec = join(tmp(), "tz");
    const bin = join(tmp(), EXE);
    writeFileSync(
      bin,
      `#!/bin/sh
[ "$1" = --version ] && echo "bunvex-local-backend test-1" && exit 0
[ "$1" = --help ] || [ "$1" = keygen ] || printf '%s\\n' "\${TZ-unset}" >>${JSON.stringify(rec)}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(ENTRY)} "$@"
`,
    );
    chmodSync(bin, 0o755);
    const before = process.env.TZ;
    process.env.TZ = "America/Sao_Paulo";
    let running: Awaited<ReturnType<typeof startLocalDeployment>>;
    try {
      running = await startLocalDeployment(io(app(), { BUNVEX_LOCAL_BACKEND_BINARY: bin, HOME: tmp() }).it, {
        cloudPort: freePort(),
      });
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
    stops.push(running.stop);
    expect(readFileSync(rec, "utf8")).toBe("UTC\n");
    expect(await portBusy(running.config.ports.cloud)).toBe(true);
  }, 60_000);

  test("a backend that exits before it is ready: the error names the log and shows its end", async () => {
    const dir = app();
    const bin = join(tmp(), EXE);
    writeFileSync(
      bin,
      `#!/bin/sh\n[ "$1" = --version ] && echo "bunvex-local-backend test-1" && exit 0\n[ "$1" = keygen ] && echo "k|x" && exit 0\necho "starting"\necho "error: the store is locked" >&2\nexit 3\n`,
    );
    chmodSync(bin, 0o755);
    const env = { BUNVEX_LOCAL_BACKEND_BINARY: bin, HOME: tmp() };
    const err = (await startLocalDeployment(io(dir, env).it, { cloudPort: freePort() }).catch((e) => e)) as Error;
    expect(err.message).toBe(
      `the local backend exited before it was ready (exit code 3); its log, ${backendLogPath(dir)}, ends with:\n` +
        `${readFileSync(backendLogPath(dir), "utf8").split("\n")[0]}\nstarting\nerror: the store is locked`,
    );
  }, 30_000);
});

describe("the executable: download, cache, upgrade", () => {
  test("downloaded from the latest release once, then cached; an upgrade asks first", async () => {
    const work = tmp();
    const zips: Record<string, Uint8Array> = {};
    for (const v of ["precompiled-2026-10-01-aaaaaaa", "precompiled-2026-10-02-bbbbbbb"]) {
      const d = join(work, v);
      mkdirSync(d);
      shim(d, v);
      const z = join(work, `${v}.zip`);
      await zip(z, join(d, EXE));
      zips[v] = new Uint8Array(readFileSync(z));
    }
    let latest = "precompiled-2026-10-01-aaaaaaa";
    // Each run below stands for a new CLI process, which looks the latest version up again.
    forgetLatestVersion();
    const downloads: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/releases/latest") return Response.json({ tag_name: latest });
        const m = /^\/releases\/download\/([^/]+)\/(.+)$/.exec(path);
        if (m && m[2] === assetName() && zips[m[1]!]) {
          downloads.push(m[1]!);
          return new Response(zips[m[1]!]);
        }
        return new Response("no", { status: 404 });
      },
    });
    stops.push(() => server.stop(true));
    const home = tmp();
    const dir = app();
    const env = { BUNVEX_RELEASES_URL: `http://127.0.0.1:${server.port}`, HOME: home };
    const first = await startLocalDeployment(io(dir, env).it, { cloudPort: freePort() });
    await first.stop();
    expect(first.config.backendVersion).toBe(latest);
    expect(existsSync(join(home, ".cache/bunvex/binaries", latest, EXE))).toBe(true);
    const cached = await startLocalDeployment(io(dir, env).it);
    await cached.stop();
    expect(downloads).toEqual(["precompiled-2026-10-01-aaaaaaa"]); // cached
    // A newer release: declining keeps the old one, accepting upgrades.
    latest = "precompiled-2026-10-02-bbbbbbb";
    forgetLatestVersion();
    const asked: string[] = [];
    const no = io(dir, env);
    no.it.prompt = (q) => {
      asked.push(q);
      return "n";
    };
    const kept = await startLocalDeployment(no.it);
    await kept.stop();
    expect(asked).toEqual(["This deployment is using an older version of the bunvex backend. Upgrade now? (Y/n)"]);
    expect(kept.config.backendVersion).toBe("precompiled-2026-10-01-aaaaaaa");
    const upgraded = await startLocalDeployment(io(dir, env).it, { forceUpgrade: true });
    await upgraded.stop();
    expect(upgraded.config.backendVersion).toBe(latest);
    expect(downloads).toEqual(["precompiled-2026-10-01-aaaaaaa", "precompiled-2026-10-02-bbbbbbb"]);
    // A missing release: Convex's message.
    await expect(
      startLocalDeployment(io(app(), env).it, { backendVersion: "precompiled-2020-01-01-0000000" }),
    ).rejects.toThrow(/^File not found at http/);
  }, 60_000);

  test("a version that is not a release's name stops before it reaches a path or a URL (Convex's 6a287a3)", async () => {
    expect(
      [
        "precompiled-2026-10-26-04d2f3b",
        "precompiled-2026-10-26-a.b-c_d",
        "precompiled-2026-10-26-..",
        "precompiled-2026-10-26-",
        "precompiled-2026-10-26-a/b",
        "precompiled-26-10-26-abc",
        "../../../etc",
        "precompiled-2026-10-26-abc\n",
        "0.1.0",
        "",
      ].map(isValidBackendVersion),
    ).toEqual([true, true, true, false, false, false, false, false, false, false]);
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        requests.push(new URL(req.url).pathname);
        return new Response("no", { status: 404 });
      },
    });
    stops.push(() => server.stop(true));
    const home = tmp();
    const env = { BUNVEX_RELEASES_URL: `http://127.0.0.1:${server.port}`, HOME: home };
    for (const v of ["../../../tmp/x", "precompiled-2026-10-26-a/../../b", "latest"]) {
      await expect(startLocalDeployment(io(app(), env).it, { backendVersion: v })).rejects.toThrow(
        /^Invalid local backend version$/,
      );
      await expect(ensureDashboardDownloaded(io(app(), env).it, v)).rejects.toThrow(/^Invalid local backend version$/);
    }
    expect(requests).toEqual([]);
    expect(existsSync(join(home, ".cache"))).toBe(false);
    // A version in config.json is checked too: here the one kept when the latest cannot be found.
    const dir = app();
    mkdirSync(join(dir, ".bunvex/local/default"), { recursive: true });
    writeFileSync(
      join(dir, ".bunvex/local/default/config.json"),
      JSON.stringify({
        ports: { cloud: freePort(), site: freePort() },
        backendVersion: "../x",
        adminKey: "k",
        instanceSecret: "0".repeat(64),
        deploymentName: "local-x",
      }),
    );
    forgetLatestVersion();
    await expect(startLocalDeployment(io(dir, env).it)).rejects.toThrow(/^Invalid local backend version$/);
    expect(requests).toEqual(["/releases/latest"]);
    expect(existsSync(join(home, ".cache"))).toBe(false);
    // `dev` prints it and exits 1.
    const r = io(app(), env);
    expect(await devCommand(["--once", "--typecheck=disable", "--local-backend-version", "../x"], r.it)).toBe(1);
    expect(r.err.at(-1)).toBe("bunvex dev: Invalid local backend version");
  });

  test("the latest version: each failure reported as Convex's findLatestVersionWithBinary reports it (G-L6)", async () => {
    let answer: () => Response = () => Response.json({ tag_name: "precompiled-2026-10-01-aaaaaaa" });
    const server = Bun.serve({ port: 0, fetch: () => answer() });
    stops.push(() => server.stop(true));
    const env = { BUNVEX_RELEASES_URL: `http://127.0.0.1:${server.port}` };
    const lookup = () => {
      forgetLatestVersion();
      return latestVersion(env);
    };
    expect(await lookup()).toEqual({ version: "precompiled-2026-10-01-aaaaaaa" });
    answer = () => new Response("Internal Server Error", { status: 500 });
    expect(await lookup()).toEqual({ error: `127.0.0.1:${server.port} returned 500: Internal Server Error` });
    answer = () => Response.json({});
    expect(await lookup()).toEqual({ error: "Invalid response missing version field" });
    const closed = freePort();
    forgetLatestVersion();
    expect(await latestVersion({ BUNVEX_RELEASES_URL: `http://127.0.0.1:${closed}` })).toEqual({
      error: "Failed to fetch latest backend version",
    });
    // A version found is kept for the process, as Convex's: the next lookup does not ask again.
    answer = () => Response.json({ tag_name: "precompiled-2026-10-02-bbbbbbb" });
    expect(await lookup()).toEqual({ version: "precompiled-2026-10-02-bbbbbbb" });
    answer = () => new Response("down", { status: 503 });
    expect(await latestVersion(env)).toEqual({ version: "precompiled-2026-10-02-bbbbbbb" });
    forgetLatestVersion();
  });

  test("unzip: deflated and stored entries", async () => {
    const d = tmp();
    writeFileSync(join(d, "f.txt"), "hello ".repeat(200));
    for (const level of ["-6", "-0"]) {
      await zip(level, join(d, `z${level}.zip`), join(d, "f.txt"));
      const out = unzipOne(new Uint8Array(readFileSync(join(d, `z${level}.zip`))), "f.txt");
      expect(new TextDecoder().decode(out)).toBe("hello ".repeat(200));
    }
    expect(() => unzipOne(new Uint8Array(readFileSync(join(d, "z-6.zip"))), "nope")).toThrow(
      "nope is not in the archive",
    );
  });
});

describe(".env.local", () => {
  // Convex's `cli/lib/deployment.test.ts` cases, with bunvex's variable and comment.
  test("a variable written as Convex's changedEnvVarFile writes it", () => {
    const set = (existing: string | null) =>
      changedEnvVarFile(existing, "BUNVEX_DEPLOYMENT", "local:tall-bar", "# Deployment used by `bunvex dev`");
    expect(set(null)).toBe("# Deployment used by `bunvex dev`\nBUNVEX_DEPLOYMENT=local:tall-bar\n");
    expect(set("BUNVEX_DEPLOYMENT=")).toBe("BUNVEX_DEPLOYMENT=local:tall-bar");
    expect(set("BUNVEX_DEPLOYMENT=foo")).toBe("BUNVEX_DEPLOYMENT=local:tall-bar");
    expect(set("RAD_DEPLOYMENT=foo")).toBe(
      "RAD_DEPLOYMENT=foo\n\n# Deployment used by `bunvex dev`\nBUNVEX_DEPLOYMENT=local:tall-bar\n",
    );
    expect(set("RAD_DEPLOYMENT=foo\nBUNVEX_DEPLOYMENT=foo")).toBe(
      "RAD_DEPLOYMENT=foo\nBUNVEX_DEPLOYMENT=local:tall-bar",
    );
    expect(set("BUNVEX_DEPLOYMENT=\nRAD_DEPLOYMENT=foo")).toBe("BUNVEX_DEPLOYMENT=local:tall-bar\nRAD_DEPLOYMENT=foo");
    // Unchanged: nothing to write. An `export` line is read as set, and left as it is (Convex's regex).
    expect(set("BUNVEX_DEPLOYMENT=local:tall-bar\n")).toBeNull();
    expect(set("export BUNVEX_DEPLOYMENT=other\n")).toBe("export BUNVEX_DEPLOYMENT=other\n");
  });

  test(".gitignore as Convex's changesToGitIgnore", () => {
    expect(changesToGitIgnore(null)).toBe(".env.local\n");
    expect(changesToGitIgnore("")).toBe("\n.env.local\n");
    expect(changesToGitIgnore(".env")).toBe(".env\n.env.local\n");
    expect(changesToGitIgnore("# .env.local")).toBe("# .env.local\n.env.local\n");
    for (const covered of [
      ".env.local",
      ".env.*",
      ".env*",
      ".env*.local",
      "*.local",
      "# bunvex env\n.env.local",
      ".env.local\r",
      "foo\r\n.env.local",
      "foo\r\n.env.local\r\n",
      "foo\r\n.env.local\r\nbar",
      " .env.local ",
    ])
      expect(changesToGitIgnore(covered)).toBeNull();
    // Negated: added anyway, to show the problem.
    expect(changesToGitIgnore("!.env.local")).toBe("!.env.local\n.env.local\n");
  });

  test("variables by framework, lines replaced, .gitignore left alone when it covers .env.local", () => {
    const dir = tmp();
    expect(urlVariables(dir)).toEqual({ url: "BUNVEX_URL", site: "BUNVEX_SITE_URL" });
    for (const [dep, prefix] of [
      ["next", "NEXT_PUBLIC_"],
      ["react-scripts", "REACT_APP_"],
      ["expo", "EXPO_PUBLIC_"],
      ["@sveltejs/kit", "PUBLIC_"],
      ["vite", "VITE_"],
    ] as const) {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { [dep]: "1" } }));
      expect(urlVariables(dir).url).toBe(`${prefix}BUNVEX_URL`);
    }
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, ".env.local"), "OTHER=1\nBUNVEX_URL=http://old\n");
    writeFileSync(join(dir, ".gitignore"), "node_modules\n.env*.local\n");
    writeEnvLocal(dir, "local-x", 3210, 3211);
    expect(readFileSync(join(dir, ".env.local"), "utf8")).toBe(
      "OTHER=1\nBUNVEX_URL=http://127.0.0.1:3210\n\n# Deployment used by `bunvex dev`\nBUNVEX_DEPLOYMENT=local:local-x\n\nBUNVEX_SITE_URL=http://127.0.0.1:3211\n",
    );
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules\n.env*.local\n");
  });
});

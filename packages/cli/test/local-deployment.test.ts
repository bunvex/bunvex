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
import {
  acquireTarget,
  assetName,
  EXE,
  forgetLatestVersion,
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
      `✔ Started running a deployment locally at http://127.0.0.1:${cloud} and saved its:\n    name as BUNVEX_DEPLOYMENT to .env.local\n    URLs as VITE_BUNVEX_URL and VITE_BUNVEX_SITE_URL to .env.local`,
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
      `# Deployment used by \`bunvex dev\`\nBUNVEX_DEPLOYMENT=local:${name}\nVITE_BUNVEX_URL=http://127.0.0.1:${cloud}\nVITE_BUNVEX_SITE_URL=http://127.0.0.1:${config.ports.site}\n`,
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
    expect(await devCommand(["--once", "--local-cloud-port", "4000"], selfHosted.it)).toBe(2);
    expect(selfHosted.err[0]).toBe("bunvex dev: the --local-* options are only for a local deployment");
  }, 60_000);
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
      Bun.spawnSync(["zip", "-q", "-j", z, join(d, EXE)]);
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

  test("unzip: deflated and stored entries", () => {
    const d = tmp();
    writeFileSync(join(d, "f.txt"), "hello ".repeat(200));
    for (const level of ["-6", "-0"]) {
      Bun.spawnSync(["zip", "-q", "-j", level, join(d, `z${level}.zip`), join(d, "f.txt")]);
      const out = unzipOne(new Uint8Array(readFileSync(join(d, `z${level}.zip`))), "f.txt");
      expect(new TextDecoder().decode(out)).toBe("hello ".repeat(200));
    }
    expect(() => unzipOne(new Uint8Array(readFileSync(join(d, "z-6.zip"))), "nope")).toThrow(
      "nope is not in the archive",
    );
  });
});

describe(".env.local", () => {
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
      "OTHER=1\nBUNVEX_URL=http://127.0.0.1:3210\n# Deployment used by `bunvex dev`\nBUNVEX_DEPLOYMENT=local:local-x\nBUNVEX_SITE_URL=http://127.0.0.1:3211\n",
    );
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules\n.env*.local\n");
  });
});

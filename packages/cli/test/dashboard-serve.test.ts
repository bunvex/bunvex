// The dashboard's server and the local dashboard (STUDY-149 PR 7): `bunvex dashboard serve` serving a built app
// (the files, index.html for the app's pages, the prefill the image's environment sets), `/api/current_deployment`
// for a local deployment with its `Host` check (DV-476), `dashboard.zip` downloaded once per version from the
// release (here a local server), `bunvex dev` serving the local dashboard on a local deployment, and
// `bunvex dashboard` opening it — as Convex's `npx convex dev` and `npx convex dashboard` do. The frame and
// security headers of Convex's image on every response of `dashboard serve`, with the build's embedding parents
// (DV-319) in `frame-ancestors` (DV-488), and none from the local dashboard.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dashboardCommand } from "../src/dashboard.ts";
import { dashboardHeaders, embedOrigins, serveDashboard, withPrefill } from "../src/dashboard-server.ts";
import { devCommand } from "../src/dev.ts";
import type { Io } from "../src/index.ts";
import { extractZip, readDashboardPort, readDashboardUnavailable } from "../src/local-dashboard.ts";
import { EXE, forgetLatestVersion, stateDir } from "../src/local-deployment.ts";

const ENTRY = resolve(import.meta.dir, "../../bunvex/bin/local-backend.ts");
const SERVER = ["bunvex", "server"].join("/");
const dirs: string[] = [];
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  forgetLatestVersion();
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-dash-"));
  dirs.push(d);
  return d;
};

const INDEX = `<!doctype html><html><head><title>bunvex</title></head><body><div id="root"></div><script type="module" src="/assets/index-abc.js"></script></body></html>`;

/** A built dashboard: index.html and a hashed asset, as Vite writes them. */
function built(dir = tmp()) {
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), INDEX);
  writeFileSync(join(dir, "assets/index-abc.js"), "console.log('dashboard')");
  writeFileSync(join(dir, "favicon.svg"), "<svg/>");
  return dir;
}

async function zipDir(dir: string, out: string) {
  const code = await Bun.spawn(["zip", "-q", "-r", out, "."], { cwd: dir, stdin: "ignore", stdout: "ignore" }).exited;
  if (code !== 0) throw new Error(`zip exited ${code}`);
}

function io(cwd: string, env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const it: Io = {
    env,
    cwd,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    open: async (url) => {
      opened.push(url);
    },
  };
  return { it, out, err, opened };
}

/** `bunvex dashboard serve <args>` until the test ends; resolves to its URL. */
async function serve(args: string[], r = io(tmp())) {
  const stop = new AbortController();
  const done = dashboardCommand(["serve", "--port", "0", ...args], r.it, { signal: stop.signal });
  stops.push(async () => {
    stop.abort();
    await done;
  });
  for (let i = 0; i < 200; i++) {
    const line = r.err.find((l) => l.startsWith("Serving the dashboard at "));
    if (line) return line.slice("Serving the dashboard at ".length);
    if (Bun.peek.status(done) === "fulfilled") throw new Error(`serve exited: ${r.err.join("\n")}`);
    await Bun.sleep(10);
  }
  throw new Error("serve did not start");
}

/** A project whose deployment is local, created (its config.json). */
function localProject(name = "local-app", cloud = 3210, adminKey = "local-app|01abc") {
  const dir = tmp();
  writeFileSync(join(dir, ".env.local"), `BUNVEX_DEPLOYMENT=local:${name}\n`);
  mkdirSync(stateDir(dir), { recursive: true });
  writeFileSync(
    join(stateDir(dir), "config.json"),
    JSON.stringify({
      ports: { cloud, site: cloud + 1 },
      backendVersion: "test",
      adminKey,
      instanceSecret: "00",
      deploymentName: name,
    }),
  );
  return dir;
}

const html = { accept: "text/html,application/xhtml+xml" };

describe("bunvex dashboard serve", () => {
  test("serves the app: its files, index.html for its pages, a missing asset a 404, nothing outside it", async () => {
    const url = await serve(["--dir", built()]);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const root = await fetch(url, { headers: html });
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toStartWith("text/html");
    expect(root.headers.get("cache-control")).toBe("no-cache");
    expect(await root.text()).toBe(INDEX);
    // the app's script, cached for good (hashed)
    const script = await fetch(`${url}assets/index-abc.js`);
    expect(script.headers.get("content-type")).toStartWith("text/javascript");
    expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await script.text()).toBe("console.log('dashboard')");
    // a page of the app, opened or reloaded: index.html, its router takes the path
    const page = await fetch(`${url}database/users`, { headers: html });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(INDEX);
    // a missing script is not answered with HTML
    expect((await fetch(`${url}assets/missing.js`)).status).toBe(404);
    // nothing outside the build, however the path is spelled
    // (deep enough to reach / from the temporary directory)
    const up = "..%2f".repeat(30);
    for (const p of [`${up}etc%2fpasswd`, `assets/${up}etc%2fpasswd`, `${"%2e%2e%2f".repeat(30)}etc/passwd`]) {
      const r = await fetch(`${url}${p}`);
      expect(r.status).toBe(404);
      expect(await r.text()).toBe("Not Found");
    }
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
    // no deployment of its own: /api/current_deployment is a 404 (the app shows the sign-in page)
    expect((await fetch(`${url}api/current_deployment`)).status).toBe(404);
  });

  test("the sign-in page's prefill: BUNVEX_DEPLOYMENT_URL / BUNVEX_ADMIN_KEY, or the flags (Convex's NEXT_PUBLIC_*)", async () => {
    const env = { BUNVEX_DEPLOYMENT_URL: "http://127.0.0.1:3210/", BUNVEX_ADMIN_KEY: 'a"<key>' };
    const fromEnv = await (await fetch(await serve(["--dir", built()], io(tmp(), env)))).text();
    expect(fromEnv).toContain(
      '<meta name="bunvex-deployment-url" content="http://127.0.0.1:3210"><meta name="bunvex-admin-key" content="a&quot;&lt;key&gt;"></head>',
    );
    const flags = await serve(["--dir", built(), "--deployment-url", "https://api.example.com"], io(tmp(), env));
    const text = await (await fetch(flags)).text();
    expect(text).toContain('<meta name="bunvex-deployment-url" content="https://api.example.com">');
    // unset: index.html as built
    expect(withPrefill(INDEX, {})).toBe(INDEX);
    expect(withPrefill(INDEX, { deploymentUrl: "not a url" })).toBe(INDEX);
  });

  test("argument and start errors", async () => {
    const bad = io(tmp());
    expect(await dashboardCommand(["serve", "--deployment-url", "nope"], bad.it)).toBe(1);
    expect(bad.err[0]).toBe("error: option '--deployment-url <url>' argument 'nope' is invalid. Not a URL.");
    const unknown = io(tmp());
    expect(await dashboardCommand(["serve", "--bogus"], unknown.it)).toBe(1);
    expect(unknown.err[0]).toBe("error: unknown option '--bogus'");
    expect(unknown.err[2]).toStartWith("Usage: bunvex dashboard serve [options]");
    const empty = io(tmp());
    expect(await dashboardCommand(["serve", "--port", "0", "--dir", tmp()], empty.it)).toBe(1);
    expect(empty.err[0]).toMatch(/^bunvex dashboard serve: .* is not a built dashboard: it has no index\.html$/);
    const url = await serve(["--dir", built()]);
    const busy = io(tmp());
    const port = new URL(url).port;
    expect(await dashboardCommand(["serve", "--port", port, "--dir", built()], busy.it)).toBe(1);
    expect(busy.err).toEqual([`bunvex dashboard serve: port ${port} is in use`]);
    const help = io(tmp());
    expect(await dashboardCommand(["serve", "--help"], help.it)).toBe(0);
    expect(help.out[0]).toStartWith("Usage: bunvex dashboard serve [options]");
  });
});

/** Every response header that is one of Convex's image's frame and security headers, by name. */
const SECURITY = [
  "x-dns-prefetch-control",
  "strict-transport-security",
  "x-xss-protection",
  "referrer-policy",
  "x-frame-options",
  "content-security-policy",
  "cross-origin-resource-policy",
  "cross-origin-embedder-policy",
  "x-content-type-options",
];
const securityOf = (r: Response) =>
  Object.fromEntries(SECURITY.flatMap((h) => (r.headers.has(h) ? [[h, r.headers.get(h)]] : [])));
// Convex's `next.config.js`: `securityHeaders` on every path, plus the frame headers unless built for embedding
const COMMON = {
  "x-dns-prefetch-control": "on",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-xss-protection": "1; mode=block",
  "referrer-policy": "origin-when-cross-origin",
};
const SAME_ORIGIN = {
  ...COMMON,
  "x-frame-options": "SAMEORIGIN",
  "content-security-policy": "frame-ancestors 'self'",
};
const withOrigins = (content: string) =>
  INDEX.replace("</head>", `<meta name="bunvex-embed-origins" content="${content}"></head>`);

/** Every kind of answer the server gives, for one server. */
async function everyAnswer(url: string, port = new URL(url).port) {
  return {
    index: await fetch(url, { headers: html }),
    indexHead: await fetch(url, { method: "HEAD" }),
    asset: await fetch(`${url}assets/index-abc.js`),
    file: await fetch(`${url}favicon.svg`),
    page: await fetch(`${url}database/users`, { headers: html }),
    missing: await fetch(`${url}assets/missing.js`),
    outside: await fetch(`${url}${"..%2f".repeat(30)}etc%2fpasswd`),
    method: await fetch(url, { method: "POST" }),
    current: await fetch(`${url}api/current_deployment`, { headers: { host: `127.0.0.1:${port}` } }),
    rebound: await fetch(`${url}api/current_deployment`, { headers: { host: `evil.example:${port}` } }),
  };
}

describe("frame and security headers (Convex's image, `next.config.js` headers() on /:path*)", () => {
  test("dashboard serve: Convex's headers on every path and answer, framing same-origin only", async () => {
    const url = await serve(["--dir", built()], io(localProject()));
    const answers = await everyAnswer(url);
    expect(Object.keys(answers).map((k) => [k, answers[k as keyof typeof answers].status])).toEqual([
      ["index", 200],
      ["indexHead", 200],
      ["asset", 200],
      ["file", 200],
      ["page", 200],
      ["missing", 404],
      ["outside", 404],
      ["method", 405],
      ["current", 200],
      ["rebound", 403],
    ]);
    for (const [k, r] of Object.entries(answers)) expect([k, securityOf(r)]).toEqual([k, SAME_ORIGIN]);
    // the answers' own headers are kept
    expect(answers.asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(answers.current.headers.get("cache-control")).toBe("no-store");
    expect(answers.method.headers.get("allow")).toBe("GET, HEAD");
  });

  test("a build that allows embedding parents (DV-319): no X-Frame-Options, CORP / COEP, the parents in frame-ancestors (DV-488)", async () => {
    const dir = built();
    writeFileSync(
      join(dir, "index.html"),
      withOrigins("https://admin.example.com/some/path, http://localhost:3000 * ftp://files.example.com nope"),
    );
    const url = await serve(["--dir", dir]);
    const embedded = {
      ...COMMON,
      "cross-origin-resource-policy": "cross-origin",
      "cross-origin-embedder-policy": "require-corp",
      "content-security-policy": "frame-ancestors 'self' https://admin.example.com http://localhost:3000",
    };
    for (const [k, r] of Object.entries(await everyAnswer(url))) expect([k, securityOf(r)]).toEqual([k, embedded]);
    // the page still carries the list, for the app's own check of the parent (DV-319)
    expect(await (await fetch(url)).text()).toContain('<meta name="bunvex-embed-origins"');
  });

  test("the build's list, read as the app reads it", () => {
    expect(embedOrigins(INDEX)).toEqual([]);
    // Vite writes the tag empty when VITE_BUNVEX_EMBED_ORIGINS is unset: same-origin only
    expect(embedOrigins(withOrigins(""))).toEqual([]);
    expect(dashboardHeaders([])).toEqual(Object.entries(SAME_ORIGIN));
    expect(embedOrigins(withOrigins("*  javascript:alert(1), ,"))).toEqual([]);
    // commas or spaces; reduced to origins; duplicates once; the first tag only; attributes in any order
    expect(
      embedOrigins(
        `<head><meta content="https://a.example.com:8443/x https://a.example.com:8443,HTTP://B.example.com" name='bunvex-embed-origins'><meta name="bunvex-embed-origins" content="https://c.example.com"></head>`,
      ),
    ).toEqual(["https://a.example.com:8443", "http://b.example.com"]);
  });

  test("the local dashboard sends none, as Convex's CLI's (`serve-handler`)", async () => {
    const server = await serveDashboard({ dir: built(), port: 0, currentDeployment: null });
    stops.push(server.stop);
    for (const [k, r] of Object.entries(await everyAnswer(server.url))) expect([k, securityOf(r)]).toEqual([k, {}]);
  });
});

describe("/api/current_deployment (Convex's local dashboard, with the Host check: DV-476)", () => {
  test("a local project's deployment, to 127.0.0.1 and localhost on the server's port only", async () => {
    const dir = localProject("local-app", 3210, "local-app|01abc");
    const url = await serve(["--dir", built()], io(dir));
    const port = new URL(url).port;
    const ask = (host: string) => fetch(`${url}api/current_deployment`, { headers: { host } });
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
      const r = await ask(host);
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("no-store");
      // no CORS: another origin's page cannot read it
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
      expect(await r.json()).toEqual({ name: "local-app", url: "http://127.0.0.1:3210", adminKey: "local-app|01abc" });
    }
    // a page whose name was rebound to 127.0.0.1, another port, no Host
    for (const host of [
      `evil.example:${port}`,
      `127.0.0.1:${Number(port) + 1}`,
      "127.0.0.1",
      `localhost.evil.example:${port}`,
    ]) {
      const r = await ask(host);
      expect(r.status).toBe(403);
      expect(await r.text()).not.toContain("local-app|01abc");
    }
  });

  test("never on a non-loopback address; never without a local deployment", async () => {
    const dir = localProject();
    const anyAddress = await serve(["--dir", built(), "--hostname", "0.0.0.0"], io(dir));
    const port = new URL(anyAddress).port;
    const r = await fetch(`${anyAddress}api/current_deployment`, { headers: { host: `127.0.0.1:${port}` } });
    expect(r.status).toBe(404);
    // a self-hosted project: no local deployment to hand out
    const selfHosted = tmp();
    writeFileSync(
      join(selfHosted, ".env.local"),
      "BUNVEX_SELF_HOSTED_URL=http://127.0.0.1:1\nBUNVEX_SELF_HOSTED_ADMIN_KEY=k\n",
    );
    const url = await serve(["--dir", built()], io(selfHosted));
    expect((await fetch(`${url}api/current_deployment`)).status).toBe(404);
  });
});

describe("dashboard.zip", () => {
  test("downloaded from the release once per version, then cached; another version replaces it", async () => {
    const work = tmp();
    const zips: Record<string, Uint8Array> = {};
    for (const v of ["precompiled-2026-10-01-aaaaaaa", "precompiled-2026-10-02-bbbbbbb"]) {
      const d = built(join(work, v));
      writeFileSync(join(d, "version.txt"), v);
      await zipDir(d, join(work, `${v}.zip`));
      zips[v] = new Uint8Array(readFileSync(join(work, `${v}.zip`)));
    }
    let latest = "precompiled-2026-10-01-aaaaaaa";
    const downloads: string[] = [];
    const releases = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/releases/latest") return Response.json({ tag_name: latest });
        const m = /^\/releases\/download\/([^/]+)\/dashboard\.zip$/.exec(path);
        if (m && zips[m[1]!]) {
          downloads.push(m[1]!);
          return new Response(zips[m[1]!]);
        }
        return new Response("no", { status: 404 });
      },
    });
    stops.push(() => releases.stop(true));
    const home = tmp();
    const env = { BUNVEX_RELEASES_URL: `http://127.0.0.1:${releases.port}`, HOME: home };
    const first = io(tmp(), env);
    const url = await serve([], first);
    expect(first.err.slice(0, 2)).toEqual([
      "Downloading the bunvex dashboard precompiled-2026-10-01-aaaaaaa...",
      "Downloaded the bunvex dashboard.",
    ]);
    expect(await (await fetch(`${url}version.txt`)).text()).toBe("precompiled-2026-10-01-aaaaaaa");
    expect(JSON.parse(readFileSync(join(home, ".cache/bunvex/dashboard/config.json"), "utf8"))).toEqual({
      version: "precompiled-2026-10-01-aaaaaaa",
    });
    forgetLatestVersion();
    await serve([], io(tmp(), env));
    expect(downloads).toEqual(["precompiled-2026-10-01-aaaaaaa"]); // cached
    latest = "precompiled-2026-10-02-bbbbbbb";
    forgetLatestVersion();
    const newer = await serve([], io(tmp(), env));
    expect(await (await fetch(`${newer}version.txt`)).text()).toBe("precompiled-2026-10-02-bbbbbbb");
    // --version: that release's
    const pinned = await serve(["--version", "precompiled-2026-10-01-aaaaaaa"], io(tmp(), env));
    expect(await (await fetch(`${pinned}version.txt`)).text()).toBe("precompiled-2026-10-01-aaaaaaa");
    expect(downloads).toEqual([
      "precompiled-2026-10-01-aaaaaaa",
      "precompiled-2026-10-02-bbbbbbb",
      "precompiled-2026-10-01-aaaaaaa",
    ]);
    // a release without it: Convex's message
    const missing = io(tmp(), env);
    expect(
      await dashboardCommand(["serve", "--port", "0", "--version", "precompiled-2020-01-01-0000000"], missing.it),
    ).toBe(1);
    expect(missing.err.at(-1)).toBe(
      `bunvex dashboard serve: File not found at http://127.0.0.1:${releases.port}/releases/download/precompiled-2020-01-01-0000000/dashboard.zip.`,
    );
  });

  test("an archive entry outside the directory fails the whole archive", () => {
    // a stored zip whose one entry is ../evil.txt, written by hand (zip refuses to make one)
    const name = new TextEncoder().encode("../evil.txt");
    const data = new TextEncoder().encode("x");
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    central.set(name, 46);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, 1, true);
    ev.setUint16(10, 1, true);
    ev.setUint32(12, central.length, true);
    ev.setUint32(16, local.length, true);
    const zip = new Uint8Array([...local, ...central, ...end]);
    const dir = join(tmp(), "out");
    expect(() => extractZip(zip, dir)).toThrow("../evil.txt: a path outside the archive");
    expect(existsSync(join(dir, "..", "evil.txt"))).toBe(false);
  });
});

/** A stand-in for the released executable: the same program, run by Bun. */
function shim(dir: string) {
  const p = join(dir, EXE);
  writeFileSync(
    p,
    `#!/bin/sh\n[ "$1" = --version ] && echo "bunvex-local-backend test-1" && exit 0\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(ENTRY)} "$@"\n`,
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
const freePort = () => {
  for (;;) {
    const p = 20_000 + Math.floor(Math.random() * 12_000);
    if (bindable(p) && bindable(p + 1)) return p;
  }
};

describe("bunvex dev's local dashboard, and bunvex dashboard", () => {
  test("dev serves the release's dashboard from 6790 for its local deployment; dashboard opens it", async () => {
    const work = tmp();
    const app = built(join(work, "app-build"));
    await zipDir(app, join(work, "dashboard.zip"));
    const zip = new Uint8Array(readFileSync(join(work, "dashboard.zip")));
    const releases = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/releases/latest") return Response.json({ tag_name: "precompiled-2026-10-03-ccccccc" });
        if (path === "/releases/download/precompiled-2026-10-03-ccccccc/dashboard.zip") return new Response(zip);
        return new Response("no", { status: 404 });
      },
    });
    stops.push(() => releases.stop(true));
    const dir = tmp();
    mkdirSync(join(dir, "bunvex"));
    writeFileSync(
      join(dir, "bunvex/items.ts"),
      `import { query } from ${JSON.stringify(SERVER)};\nexport const all = query(async () => []);`,
    );
    const env = {
      BUNVEX_LOCAL_BACKEND_BINARY: shim(tmp()),
      BUNVEX_RELEASES_URL: `http://127.0.0.1:${releases.port}`,
      HOME: tmp(),
      BUNVEX_DISABLE_VERSION_CHECK: "1",
    };
    const cloud = freePort();
    const r = io(dir, env);
    const stop = new AbortController();
    const done = devCommand(["--typecheck=disable", "--local-cloud-port", String(cloud)], r.it, {
      signal: stop.signal,
    });
    let stopped = false;
    stops.push(async () => {
      if (!stopped) {
        stop.abort();
        await done;
      }
    });
    for (let i = 0; i < 600 && !r.err.some((l) => l.includes("bunvex functions ready!")); i++) {
      if (Bun.peek.status(done) === "fulfilled") throw new Error(r.err.join("\n"));
      await Bun.sleep(50);
    }
    const port = readDashboardPort(dir);
    expect(port).toBeGreaterThanOrEqual(6790);
    const url = `http://127.0.0.1:${port}/`;
    const page = await fetch(url);
    expect(await page.text()).toBe(INDEX);
    // no frame or security headers, as Convex's local dashboard on 6790
    expect(securityOf(page)).toEqual({});
    const config = JSON.parse(readFileSync(join(stateDir(dir), "config.json"), "utf8"));
    const current = await fetch(`${url}api/current_deployment`);
    expect(await current.json()).toEqual({
      name: config.deploymentName,
      url: `http://127.0.0.1:${cloud}`,
      adminKey: config.adminKey,
    });
    expect((await fetch(`${url}api/current_deployment`, { headers: { host: `evil.example:${port}` } })).status).toBe(
      403,
    );
    // the key it hands out is the deployment's
    const check = await fetch(`http://127.0.0.1:${cloud}/api/check_admin_key`, {
      headers: { authorization: `Bunvex ${config.adminKey}` },
    });
    expect(check.status).toBe(200);

    // `bunvex dashboard`: its URL (--no-open), or opened
    const print = io(dir, env);
    expect(await dashboardCommand(["--no-open"], print.it)).toBe(0);
    expect(print.out).toEqual([url]);
    const open = io(dir, env);
    expect(await dashboardCommand([], open.it)).toBe(0);
    expect(open.opened).toEqual([url]);
    expect(open.err).toEqual([`Opening ${url} in the default browser...`]);
    // a browser that cannot be started: Convex's warning, the URL to visit
    const headless = io(dir, env);
    headless.it.open = async () => {
      throw new Error("no browser");
    };
    expect(await dashboardCommand([], headless.it)).toBe(0);
    expect(headless.err.at(-1)).toBe(`⚠️ Could not open dashboard in the default browser.\nPlease visit: ${url}`);

    // the port now answers for another deployment: not this one's dashboard
    const other = io(dir, { ...env, BUNVEX_DEPLOYMENT: "local:another" });
    expect(await dashboardCommand(["--no-open"], other.it)).toBe(0);
    expect(other.out).toEqual([]);
    expect(other.err).toEqual([
      "You are not currently running the dashboard locally. Make sure `bunvex dev` is running and try again.",
    ]);

    // dev stopped: so is its dashboard, and `bunvex dashboard` says so
    stop.abort();
    expect(await done).toBe(0);
    stopped = true;
    const after = io(dir, env);
    expect(await dashboardCommand(["--no-open"], after.it)).toBe(0);
    expect(after.err).toEqual([
      "You are not currently running the dashboard locally. Make sure `bunvex dev` is running and try again.",
    ]);
    // --once serves none
    rmSync(join(stateDir(dir), "dashboard.json"));
    const once = io(dir, env);
    expect(await devCommand(["--typecheck=disable", "--once"], once.it)).toBe(0);
    expect(existsSync(join(stateDir(dir), "dashboard.json"))).toBe(false);
  }, 60_000);
});

describe("the local dashboard when its version cannot be had (DV-486: a warning, not Convex's stop)", () => {
  /** A project with one function, and `bunvex dev` on its local deployment until the first push is ready. */
  async function startDev(env: Record<string, string>) {
    const dir = tmp();
    mkdirSync(join(dir, "bunvex"));
    writeFileSync(
      join(dir, "bunvex/items.ts"),
      `import { query } from ${JSON.stringify(SERVER)};\nexport const all = query(async () => []);`,
    );
    const full = { BUNVEX_LOCAL_BACKEND_BINARY: shim(tmp()), BUNVEX_DISABLE_VERSION_CHECK: "1", ...env };
    const r = io(dir, full);
    const stop = new AbortController();
    const done = devCommand(["--typecheck=disable", "--local-cloud-port", String(freePort())], r.it, {
      signal: stop.signal,
    });
    let stopped = false;
    const end = async () => {
      if (stopped) return;
      stopped = true;
      stop.abort();
      return await done;
    };
    stops.push(end);
    for (let i = 0; i < 600 && !r.err.some((l) => l.includes("bunvex functions ready!")); i++) {
      if (Bun.peek.status(done) === "fulfilled") throw new Error(r.err.join("\n"));
      await Bun.sleep(50);
    }
    return { dir, env: full, r, end };
  }

  /** A dashboard already in the cache of `home`, as an earlier `dev` left it. */
  function cached(home: string, version: string) {
    const dir = join(home, ".cache/bunvex/dashboard");
    built(join(dir, "out"));
    writeFileSync(join(dir, "out/version.txt"), version);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ version }));
  }

  /** A releases URL where nothing listens: offline. */
  const closedPort = () => `http://127.0.0.1:${freePort()}`;

  test("offline, a dashboard in the cache: dev warns and serves it", async () => {
    const home = tmp();
    cached(home, "precompiled-2026-10-01-aaaaaaa");
    const dev = await startDev({ HOME: home, BUNVEX_RELEASES_URL: closedPort() });
    expect(dev.r.err).toContain("⚠️ Could not get the bunvex dashboard: Failed to fetch latest backend version");
    expect(dev.r.err).toContain("Serving the dashboard already downloaded (precompiled-2026-10-01-aaaaaaa).");
    const port = readDashboardPort(dev.dir);
    expect(port).toBeGreaterThanOrEqual(6790);
    expect(await (await fetch(`http://127.0.0.1:${port}/version.txt`)).text()).toBe("precompiled-2026-10-01-aaaaaaa");
    const open = io(dev.dir, dev.env);
    expect(await dashboardCommand(["--no-open"], open.it)).toBe(0);
    expect(open.out).toEqual([`http://127.0.0.1:${port}/`]);
    expect(await dev.end()).toBe(0);
  }, 60_000);

  test("offline, nothing in the cache: dev runs without a dashboard; bunvex dashboard says why", async () => {
    const dev = await startDev({ HOME: tmp(), BUNVEX_RELEASES_URL: closedPort() });
    expect(dev.r.err).toContain("⚠️ Could not get the bunvex dashboard: Failed to fetch latest backend version");
    expect(dev.r.err).toContain(
      "Running without the local dashboard; `bunvex dev` serves it once it can be downloaded.",
    );
    expect(readDashboardPort(dev.dir)).toBeNull();
    const ask = io(dev.dir, dev.env);
    expect(await dashboardCommand(["--no-open"], ask.it)).toBe(0);
    expect(ask.out).toEqual([]);
    expect(ask.err).toEqual([
      "`bunvex dev` is running without the local dashboard: it could not be downloaded (Failed to fetch latest backend version). Restart `bunvex dev` once it can be.",
    ]);
    // dev still works: it pushed, and stops cleanly; then `bunvex dashboard` says dev is not running
    expect(await dev.end()).toBe(0);
    const after = io(dev.dir, dev.env);
    expect(await dashboardCommand(["--no-open"], after.it)).toBe(0);
    expect(after.err).toEqual([
      "You are not currently running the dashboard locally. Make sure `bunvex dev` is running and try again.",
    ]);
  }, 60_000);

  test("the latest version not resolved, or its dashboard.zip missing: the same fallbacks", async () => {
    let latest = (): Response => new Response("Internal Server Error", { status: 500 });
    const releases = Bun.serve({
      port: 0,
      fetch(req) {
        return new URL(req.url).pathname === "/releases/latest" ? latest() : new Response("no", { status: 404 });
      },
    });
    stops.push(() => releases.stop(true));
    const base = `http://127.0.0.1:${releases.port}`;
    const unresolved = await startDev({ HOME: tmp(), BUNVEX_RELEASES_URL: base });
    expect(unresolved.r.err).toContain(
      `⚠️ Could not get the bunvex dashboard: 127.0.0.1:${releases.port} returned 500: Internal Server Error`,
    );
    expect(readDashboardUnavailable(unresolved.dir)).toBe(
      `127.0.0.1:${releases.port} returned 500: Internal Server Error`,
    );
    await unresolved.end();
    // resolved, but the release has no dashboard.zip: the cached one
    forgetLatestVersion();
    latest = () => Response.json({ tag_name: "precompiled-2026-10-04-ddddddd" });
    const home = tmp();
    cached(home, "precompiled-2026-10-01-aaaaaaa");
    const missing = await startDev({ HOME: home, BUNVEX_RELEASES_URL: base });
    expect(missing.r.err).toContain(
      `⚠️ Could not get the bunvex dashboard: File not found at ${base}/releases/download/precompiled-2026-10-04-ddddddd/dashboard.zip.`,
    );
    const port = readDashboardPort(missing.dir);
    expect(await (await fetch(`http://127.0.0.1:${port}/version.txt`)).text()).toBe("precompiled-2026-10-01-aaaaaaa");
    // the failed download left the cache as it was
    expect(JSON.parse(readFileSync(join(home, ".cache/bunvex/dashboard/config.json"), "utf8")).version).toBe(
      "precompiled-2026-10-01-aaaaaaa",
    );
    await missing.end();
  }, 60_000);
});

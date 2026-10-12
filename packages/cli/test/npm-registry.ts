// Test helper: an npm registry served by the test (STUDY-148), so installs never reach the network. Each package is
// written to a directory, packed with `tar` as npm packs (`package/…`), and served as a packument and a tarball;
// every request is recorded.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A file of a package: its text, or its text and Unix permissions. */
export type PackageFile = string | { text: string; mode: number };
export type TestPackage = {
  name: string;
  version: string;
  /** Files besides `package.json`. */
  files?: Record<string, PackageFile>;
  /** More `package.json` fields (`scripts`, `peerDependencies`, …). */
  json?: Record<string, unknown>;
};

/** `pkg`'s files in a directory of their own, ready to copy into a project's `node_modules`. */
export function writePackage(dir: string, pkg: TestPackage) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: pkg.name, version: pkg.version, main: "index.js", ...pkg.json }),
  );
  for (const [path, f] of Object.entries(pkg.files ?? {})) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof f === "string" ? f : f.text);
    if (typeof f !== "string") chmodSync(join(dir, path), f.mode);
  }
}

export type Registry = { url: string; requests: string[]; add: (pkg: TestPackage) => void; stop: () => void };

export function startRegistry(packages: TestPackage[]): Registry {
  const work = mkdtempSync(join(tmpdir(), "bunvex-registry-"));
  const tarballs = new Map<string, { pkg: TestPackage; bytes: Uint8Array }>();
  const add = (pkg: TestPackage) => {
    const dir = join(work, `${pkg.name.replace("/", "+")}@${pkg.version}`);
    writePackage(join(dir, "package"), pkg);
    const tgz = join(dir, "package.tgz");
    const p = Bun.spawnSync(["tar", "czf", tgz, "-C", dir, "package"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    if (p.exitCode !== 0) throw new Error(`tar failed: ${p.stderr}`);
    tarballs.set(`${pkg.name}@${pkg.version}`, { pkg, bytes: new Uint8Array(readFileSync(tgz)) });
  };
  for (const p of packages) add(p);
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      requests.push(`${req.method} ${path}`);
      const tar = /^\/(.+)\/-\/(.+)\.tgz$/.exec(path);
      if (tar) {
        const t = tarballs.get(tar[2]!);
        return t ? new Response(t.bytes) : new Response("not found", { status: 404 });
      }
      const name = path.slice(1);
      const versions: Record<string, unknown> = {};
      for (const [key, { pkg, bytes }] of tarballs) {
        if (pkg.name !== name) continue;
        versions[pkg.version] = {
          name,
          version: pkg.version,
          main: "index.js",
          ...pkg.json,
          dist: {
            tarball: `http://127.0.0.1:${server.port}/${name}/-/${key}.tgz`,
            shasum: createHash("sha1").update(bytes).digest("hex"),
            integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
          },
        };
      }
      if (!Object.keys(versions).length) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json({ name, "dist-tags": { latest: Object.keys(versions).at(-1) }, versions });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/`,
    requests,
    add,
    stop: () => {
      server.stop(true);
      rmSync(work, { recursive: true, force: true });
    },
  };
}

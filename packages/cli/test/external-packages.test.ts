// `node.externalPackages` (STUDY-148): which imports the CLI leaves external and which versions the push names
// (Convex's `bundler/external.ts`, its cases checked against the convex 1.46.0 CLI), then end to end: the
// deployment installs them with `bun install` from a registry this test serves, records Convex's rows, reuses an
// install, loads the packages for `"use node"` actions (files beside them, `require`, a binary they spawn, their
// install scripts, the deployment's variables), refuses a version the registry does not have, and counts them in
// the size limit.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { defineSchema, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { adminKeyCipherKey, createServer, Functions, issueAdminKey } from "@bunvex/server";
import { BundleError, bundleFunctions } from "../src/bundle.ts";
import { type Io, main } from "../src/index.ts";
import { memoryStore } from "./memory-store.ts";
import { type Registry, startRegistry, type TestPackage, writePackage } from "./npm-registry.ts";

const SECRET = "ef".repeat(32);
const NAME = "external-packages-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
// The app's imports, spelled so the dependency checker does not take them for this test's own.
const SERVER = JSON.stringify(["bunvex", "server"].join("/"));

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-ext-app-"));
  dirs.push(d);
  return d;
};

/** Reads `data.txt` next to itself: bundling it would lose the file (Convex's reason for external packages). */
const ASSET = (text: string, version = "1.2.3"): TestPackage => ({
  name: "tiny-asset",
  version,
  files: {
    "index.js": `const fs = require("fs"); const path = require("path");
exports.read = () => fs.readFileSync(path.join(__dirname, "data.txt"), "utf8").trim();
exports.where = () => __dirname;`,
    "data.txt": text,
  },
});
/** Spawns its own 0755 script; its install script leaves a file. */
const BIN: TestPackage = {
  name: "tiny-bin",
  version: "1.0.0",
  json: { scripts: { postinstall: "echo yes > installed.txt" } },
  files: {
    "index.js": `const fs = require("fs"); const path = require("path"); const { execFileSync } = require("child_process");
exports.probe = () => {
  const f = path.join(__dirname, "bin", "run.sh");
  let ran;
  try { ran = execFileSync(f).toString().trim(); } catch (e) { ran = "error: " + e.code; }
  return { mode: (fs.statSync(f).mode & 0o777).toString(8), ran, postinstall: fs.existsSync(path.join(__dirname, "installed.txt")) };
};`,
    "bin/run.sh": { text: "#!/bin/sh\necho ran\n", mode: 0o755 },
  },
};
/** Reads the environment at import and when called. */
const ENV: TestPackage = {
  name: "tiny-env",
  version: "1.0.0",
  files: {
    "index.js": `exports.atImport = process.env.SECRET_KEY ?? null;
exports.read = (name) => process.env[name] ?? null;`,
  },
};

/** An ES module package: named and default exports, the environment read at import. */
const ESM: TestPackage = {
  name: "tiny-esm",
  version: "1.0.0",
  json: { type: "module" },
  files: { "index.js": `export const atImport = process.env.SECRET_KEY ?? null;\nexport default "the default";` },
};

/** A project: `bunvex/` files, a `package.json` and the packages installed in its `node_modules`. */
function project(files: Record<string, string>, installed: TestPackage[], packageJson: Record<string, unknown>) {
  const dir = tmp();
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", private: true, ...packageJson }));
  for (const p of installed) writePackage(join(dir, "node_modules", p.name), p);
  return dir;
}

const NODE_FILE = (imports: string, body: string) => `"use node";
import { action } from ${SERVER};
${imports}
export const run = action(async () => ${body});`;

/** An entry of a zip archive, as text (its local headers walked; entries deflated or stored). */
function zipEntry(zip: Buffer, name: string): string {
  for (let at = 0; zip.readUInt32LE(at) === 0x04034b50; ) {
    const method = zip.readUInt16LE(at + 8);
    const size = zip.readUInt32LE(at + 18);
    const nameLength = zip.readUInt16LE(at + 26);
    const start = at + 30 + nameLength + zip.readUInt16LE(at + 28);
    const data = zip.subarray(start, start + size);
    if (zip.toString("utf8", at + 30, at + 30 + nameLength) === name)
      return (method === 8 ? inflateRawSync(data) : data).toString("utf8");
    at = start + size;
  }
  throw new Error(`no ${name} in the archive`);
}

/** The bundle's modules that import a package, by path, and the push's `nodeDependencies`. */
async function bundled(dir: string, externalPackages: string[]) {
  const b = await bundleFunctions(join(dir, "bunvex"), dir, { externalPackages });
  const imports: Record<string, string[]> = {};
  for (const m of b.modules) {
    const found = [...m.source.matchAll(/(?:from |__require\()"(tiny-[^"]*|pkg-[^"]*)"/g)].map((x) => x[1]!);
    if (found.length) imports[m.path] = found;
  }
  return { imports, deps: b.nodeDependencies };
}

describe("what the CLI leaves external (Convex's bundler/external.ts)", () => {
  const PURE: TestPackage = { name: "tiny-pure", version: "2.0.0", files: { "index.js": "exports.x = 1;" } };

  test('only "use node" imports of listed packages, at their installed versions', async () => {
    const dir = project(
      {
        "bunvex/ext.ts": NODE_FILE(`import { read } from "tiny-asset"; import { x } from "tiny-pure";`, "[read(), x]"),
        // An isolate file bundles a listed package, as Convex's.
        "bunvex/iso.ts": `import { query } from ${SERVER}; import { x } from "tiny-pure"; export const q = query(async () => x);`,
      },
      [ASSET("hi"), PURE],
      // A range in package.json: the installed version is sent.
      { dependencies: { "tiny-asset": "^1.0.0", "tiny-pure": "2.0.0" } },
    );
    expect(await bundled(dir, ["tiny-asset"])).toEqual({
      imports: { "ext.js": ["tiny-asset"] },
      deps: [{ name: "tiny-asset", version: "1.2.3" }],
    });
    expect(await bundled(dir, ["tiny-asset", "tiny-pure"])).toEqual({
      imports: { "ext.js": ["tiny-asset", "tiny-pure"] },
      deps: [
        { name: "tiny-asset", version: "1.2.3" },
        { name: "tiny-pure", version: "2.0.0" },
      ],
    });
    // Nothing listed: everything bundled, nothing sent.
    expect(await bundled(dir, [])).toEqual({ imports: {}, deps: [] });
  });

  test('"*": every dependency kind; never bunvex, local or undeclared packages; subpaths and require as written', async () => {
    const OTHER: TestPackage = { name: "tiny-other", version: "3.1.0", files: { "index.js": "exports.y = 2;" } };
    const files = {
      "bunvex/a.ts": NODE_FILE(`import { where } from "tiny-asset/index.js";`, `[where(), require("tiny-pure").x]`),
      "bunvex/b.ts": NODE_FILE(`import { y } from "tiny-other";`, "y"),
    };
    const dir = project(files, [ASSET("hi"), PURE, OTHER], {
      dependencies: { bunvex: "*", "tiny-asset": "1.2.3" },
      devDependencies: { "tiny-pure": "^2.0.0" },
      // A local version is bundled, as Convex's.
      optionalDependencies: { "tiny-other": "file:./vendor/tiny-other" },
    });
    expect(await bundled(dir, ["*"])).toEqual({
      imports: { "a.js": ["tiny-asset/index.js", "tiny-pure"] },
      deps: [
        { name: "tiny-asset", version: "1.2.3" },
        { name: "tiny-pure", version: "2.0.0" },
      ],
    });
    // Not declared in package.json: bundled.
    const undeclared = project(files, [ASSET("hi"), PURE, OTHER], { dependencies: { "tiny-asset": "1.2.3" } });
    expect((await bundled(undeclared, ["*"])).deps).toEqual([{ name: "tiny-asset", version: "1.2.3" }]);
  });

  test("peer and optional dependencies that are candidates too; a nested copy is bundled", async () => {
    const A: TestPackage = {
      name: "pkg-a",
      version: "1.0.0",
      json: { peerDependencies: { "pkg-b": "*" }, optionalDependencies: { "pkg-c": "*", "pkg-d": "*" } },
      files: { "index.js": `exports.a = require("tiny-asset").read;` },
    };
    const B: TestPackage = { name: "pkg-b", version: "1.1.0", json: { peerDependencies: { "pkg-d": "*" } } };
    const D: TestPackage = { name: "pkg-d", version: "4.0.0" };
    const dir = project({ "bunvex/a.ts": NODE_FILE(`import { a } from "pkg-a";`, "a()") }, [A, B, D, ASSET("top")], {
      // pkg-c is not a dependency of the app: not sent.
      dependencies: { "pkg-a": "1.0.0", "pkg-b": "1.1.0", "pkg-d": "4.0.0", "tiny-asset": "1.2.3" },
    });
    expect((await bundled(dir, ["pkg-a", "pkg-b", "pkg-d"])).deps).toEqual([
      { name: "pkg-a", version: "1.0.0" },
      { name: "pkg-b", version: "1.1.0" },
      { name: "pkg-d", version: "4.0.0" },
    ]);
    // pkg-a bundled, its own nested tiny-asset too: only the project's top-level copy may stay external.
    writePackage(join(dir, "node_modules/pkg-a/node_modules/tiny-asset"), ASSET("nested", "0.9.0"));
    expect(await bundled(dir, ["tiny-asset"])).toEqual({ imports: {}, deps: [] });
  });

  test("Convex's messages", async () => {
    const files = { "bunvex/a.ts": NODE_FILE(`import { read } from "tiny-asset";`, "read()") };
    const message = (dir: string) =>
      bundleFunctions(join(dir, "bunvex"), dir, { externalPackages: ["tiny-asset"] }).then(
        () => "bundled",
        (e) => (e instanceof BundleError ? e.message : `other: ${e}`),
      );
    const bad = project(files, [ASSET("hi")], { dependencies: { "tiny-asset": 5 } });
    expect(await message(bad)).toBe(
      `Invalid "${join(bad, "package.json")}". "dependencies.tiny-asset" version has type number.`,
    );
    const noVersion = project(files, [], { dependencies: { "tiny-asset": "1.2.3" } });
    writePackage(join(noVersion, "node_modules/tiny-asset"), { ...ASSET("hi"), json: { version: undefined } });
    expect(await message(noVersion)).toBe(
      `"${join(noVersion, "node_modules/tiny-asset/package.json")}" misses a 'version' field. which is required for installing external package "tiny-asset" configured in bunvex.json.`,
    );
    const unparsable = project(files, [ASSET("hi")], {});
    writeFileSync(join(unparsable, "package.json"), "{oops");
    expect(await message(unparsable)).toStartWith(
      `Couldn't parse "${join(unparsable, "package.json")}". Make sure it's a valid JSON. Error: SyntaxError`,
    );
  });
});

describe("the deployment installs them (STUDY-148)", () => {
  let registry: Registry;
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    registry = startRegistry([ASSET("hello from tiny-asset"), ASSET("newer", "1.2.4"), BIN, ENV, ESM]);
    // `bun install` runs with the server's environment: this registry, and a cache of the test's own.
    for (const k of ["NPM_CONFIG_REGISTRY", "BUN_INSTALL_CACHE_DIR", "SERVER_ONLY_VAR"]) saved[k] = process.env[k];
    process.env.NPM_CONFIG_REGISTRY = registry.url;
    process.env.BUN_INSTALL_CACHE_DIR = mkdtempSync(join(tmpdir(), "bunvex-ext-cache-"));
    process.env.SERVER_ONLY_VAR = "the server's";
  });
  afterAll(() => {
    rmSync(process.env.BUN_INSTALL_CACHE_DIR!, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    registry.stop();
  });

  async function deployment(store = memoryStore(), dir = tmp()) {
    const engine = await new Engine(
      defineSchema({}),
      new SqlitePersistence(join(dir, "db.sqlite"), { durable: true }),
      { instanceName: NAME, instanceSecret: SECRET, storedSchema: true },
    ).init();
    const s = createServer({
      engine,
      functions: new Functions(engine),
      port: 0,
      deployable: true,
      moduleStorage: store as never,
    });
    let stopped: Promise<unknown> | null = null;
    const stop = () => (stopped ??= Promise.resolve(s.shutdown()));
    stops.push(stop);
    const url = `http://127.0.0.1:${s.server.port}`;
    const call = async (path: string, args: object = {}) =>
      (await (
        await fetch(`${url}/api/action`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, args }),
        })
      ).json()) as { status: string; value?: unknown; errorMessage?: string };
    const rows = (table: string) =>
      engine.query((db) => db.asSystem(() => db.query(table).collect())) as Promise<Record<string, unknown>[]>;
    return { url, call, rows, engine, store, dir, stop };
  }

  const APP = {
    "bunvex/ext.ts": `"use node";
import { action } from ${SERVER};
import { read, where } from ${JSON.stringify("tiny-asset")};
import { probe } from ${JSON.stringify("tiny-bin")};
export const asset = action(async () => ({ text: read(), where: where(), required: require("tiny-asset").read() }));
export const bin = action(async () => probe());`,
    "bunvex/plain.ts": `import { query } from ${SERVER}; export const ping = query(async () => "pong");`,
  };
  const PACKAGE_JSON = {
    dependencies: { bunvex: "*", "tiny-asset": "1.2.3", "tiny-bin": "^1.0.0", "tiny-env": "1.0.0" },
  };
  const INSTALLED = [ASSET("hello from tiny-asset"), BIN, ENV];

  async function deploy(app: string, url: string, flags: string[] = []) {
    writeFileSync(join(app, ".env.local"), `BUNVEX_SELF_HOSTED_URL=${url}\nBUNVEX_SELF_HOSTED_ADMIN_KEY="${KEY}"\n`);
    const out: string[] = [];
    const err: string[] = [];
    const it: Io = { env: {}, cwd: app, out: (l) => out.push(l), err: (l) => err.push(l) };
    const code = await main(["deploy", "--typecheck=disable", ...flags], it);
    return { code, out, err };
  }

  test("installed with bun install, recorded as Convex's rows, loaded for Node actions; a restart loads them again", async () => {
    const d = await deployment();
    const app = project(APP, INSTALLED, PACKAGE_JSON);
    writeFileSync(join(app, "bunvex.json"), JSON.stringify({ node: { externalPackages: ["*"] } }));
    registry.requests.length = 0;
    const r = await deploy(app, d.url);
    expect(r.err.join("\n")).not.toContain("error");
    expect(r.code).toBe(0);
    expect(registry.requests).toContain("GET /tiny-asset");
    expect(registry.requests).toContain("GET /tiny-bin");
    // The package reads the file beside it, through `__dirname` and through `require`.
    const asset = (await d.call("ext:asset")).value as { text: string; where: string; required: string };
    expect(asset.text).toBe("hello from tiny-asset");
    expect(asset.required).toBe("hello from tiny-asset");
    expect(asset.where).toMatch(/\/bunvex-node-[^/]+\/[0-9a-f-]{36}\/node_modules\/tiny-asset$/);
    // Its install script ran (as npm runs them, DV-471); its binary keeps 0755 and runs (DV-473).
    expect((await d.call("ext:bin")).value).toEqual({ mode: "755", ran: "ran", postinstall: true });
    // Convex's row: `{storageKey, sha256 (bytes), deps: [{package, version}], packageSize (int64)}`; tiny-env is
    // declared but imported by no Node module, so not installed.
    const [row, ...more] = await d.rows("_external_deps_packages");
    expect(more).toEqual([]);
    expect(row!.deps).toEqual([
      { package: "tiny-asset", version: "1.2.3" },
      { package: "tiny-bin", version: "1.0.0" },
    ]);
    expect(Object.keys(row!).sort()).toEqual(["_creationTime", "_id", "deps", "packageSize", "sha256", "storageKey"]);
    expect(row!.sha256).toBeInstanceOf(ArrayBuffer);
    const size = row!.packageSize as { zippedSizeBytes: bigint; unzippedSizeBytes: bigint };
    expect(typeof size.zippedSizeBytes).toBe("bigint");
    const blob = new Uint8Array(await new Response(await d.store.get(row!.storageKey as string)).arrayBuffer());
    expect(BigInt(blob.length)).toBe(size.zippedSizeBytes);
    expect(new Uint8Array(new Bun.CryptoHasher("sha256").update(blob).digest())).toEqual(
      new Uint8Array(row!.sha256 as ArrayBuffer),
    );
    // The package names the row; its metadata.json the blob.
    const [pkg] = await d.rows("_source_packages");
    expect(pkg!.externalPackageId).toBe(row!._id);
    const zip = Buffer.from(await new Response(await d.store.get(pkg!.storageKey as string)).arrayBuffer());
    const metadata = JSON.parse(zipEntry(zip, "metadata.json")) as { externalDepsStorageKey: string };
    expect(metadata.externalDepsStorageKey).toBe(row!.storageKey as string);

    // Another server on the same store and data: the deployed code loads with its packages.
    await d.stop();
    const again = await deployment(d.store, d.dir);
    for (let i = 0; i < 100 && (await again.call("ext:asset")).status !== "success"; i++) await Bun.sleep(50);
    expect(((await again.call("ext:asset")).value as { text: string }).text).toBe("hello from tiny-asset");
  }, 60_000);

  test("a push with the same packages reuses the install; another version installs again", async () => {
    const d = await deployment();
    const app = project(APP, INSTALLED, PACKAGE_JSON);
    writeFileSync(join(app, "bunvex.json"), JSON.stringify({ node: { externalPackages: ["tiny-asset", "tiny-bin"] } }));
    // A dry run installs and records them too, as Convex's `start_push` does first; the push then reuses them.
    expect((await deploy(app, d.url, ["--dry-run"])).code).toBe(0);
    expect(await d.rows("_source_packages")).toEqual([]);
    const [first] = await d.rows("_external_deps_packages");
    registry.requests.length = 0;
    expect((await deploy(app, d.url)).code).toBe(0);
    expect(registry.requests).toEqual([]);
    // A module changes; the packages do not: no request to the registry, the same row.
    writeFileSync(
      join(app, "bunvex/plain.ts"),
      `import { query } from ${SERVER}; export const ping = query(async () => "pong!");`,
    );
    registry.requests.length = 0;
    expect((await deploy(app, d.url)).code).toBe(0);
    expect(registry.requests).toEqual([]);
    expect((await d.rows("_external_deps_packages")).length).toBe(1);
    expect((await d.rows("_source_packages"))[0]!.externalPackageId).toBe(first!._id);
    // Another installed version: a new row and its files.
    writePackage(join(app, "node_modules/tiny-asset"), ASSET("newer", "1.2.4"));
    expect((await deploy(app, d.url)).code).toBe(0);
    const rows = await d.rows("_external_deps_packages");
    expect(rows.map((r) => (r.deps as { version: string }[])[0]!.version)).toEqual(["1.2.3", "1.2.4"]);
    expect(((await d.call("ext:asset")).value as { text: string }).text).toBe("newer");
    // Nothing imported any more: no row named, nothing installed.
    rmSync(join(app, "bunvex/ext.ts"));
    expect((await deploy(app, d.url)).code).toBe(0);
    expect((await d.rows("_source_packages"))[0]!.externalPackageId).toBeNull();
    expect((await d.rows("_external_deps_packages")).length).toBe(2);
  }, 60_000);

  test("an install that fails is Convex's 400 InvalidExternalModules, and nothing is deployed", async () => {
    const d = await deployment();
    // A version the registry does not have.
    const app = project(APP, [ASSET("x", "9.9.9"), BIN], PACKAGE_JSON);
    writeFileSync(join(app, "bunvex.json"), JSON.stringify({ node: { externalPackages: ["*"] } }));
    const r = await deploy(app, d.url);
    expect(r.code).toBe(1);
    const message = r.err.join("\n");
    expect(message).toContain(
      "Hit an error while pushing:\nLoading the pushed modules encountered the following error:\nCommand failed: bun install\n",
    );
    expect(message).toContain('No version matching "9.9.9" found for specifier "tiny-asset"');
    expect(await d.rows("_external_deps_packages")).toEqual([]);
    expect(await d.rows("_source_packages")).toEqual([]);
  }, 60_000);

  test("no zipped size limit (Convex's 5695d6d): packages that zip past the old knob deploy", async () => {
    const d = await deployment();
    // 400 KB that do not compress: past a 300 KB zipped bound with the packages. The unzipped limit (230 MB), which
    // counts them too, is checked in server/test/push-components.test.ts.
    const BIG: TestPackage = {
      name: "tiny-big",
      version: "1.0.0",
      files: {
        "index.js": "exports.n = 1;",
        "blob.bin": Buffer.from(crypto.getRandomValues(new Uint8Array(400_000))).toString("base64"),
      },
    };
    registry.add(BIG);
    const app = project({ "bunvex/big.ts": NODE_FILE(`import { n } from "tiny-big";`, "n") }, [BIG], {
      dependencies: { "tiny-big": "1.0.0" },
    });
    writeFileSync(join(app, "bunvex.json"), JSON.stringify({ node: { externalPackages: ["tiny-big"] } }));
    const saved = process.env.MAX_ZIPPED_PACKAGES_SIZE;
    process.env.MAX_ZIPPED_PACKAGES_SIZE = "300000";
    try {
      // No zipped limit since Convex's 5695d6d (STUDY-186 A3): the old knob refuses nothing.
      expect((await deploy(app, d.url)).code).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.MAX_ZIPPED_PACKAGES_SIZE;
      else process.env.MAX_ZIPPED_PACKAGES_SIZE = saved;
    }
  }, 60_000);

  test("packages read the deployment's variables, then the server's (DV-472)", async () => {
    const d = await deployment();
    const app = project(
      {
        "bunvex/env.ts": NODE_FILE(
          `import { atImport, read } from "tiny-env"; import esm, { atImport as esmAtImport } from "tiny-esm";`,
          `({ atImport, esm, esmAtImport, now: read("SECRET_KEY"), server: read("SERVER_ONLY_VAR"), action: process.env.SERVER_ONLY_VAR ?? null })`,
        ),
      },
      [ENV, ESM],
      { dependencies: { "tiny-env": "1.0.0", "tiny-esm": "1.0.0" } },
    );
    writeFileSync(join(app, "bunvex.json"), JSON.stringify({ node: { externalPackages: ["*"] } }));
    writeFileSync(join(app, ".env.local"), `BUNVEX_SELF_HOSTED_URL=${d.url}\nBUNVEX_SELF_HOSTED_ADMIN_KEY="${KEY}"\n`);
    const it: Io = { env: {}, cwd: app, out: () => {}, err: () => {} };
    expect(await main(["env", "set", "SECRET_KEY", "from the deployment"], it)).toBe(0);
    expect((await deploy(app, d.url)).code).toBe(0);
    expect((await d.call("env:run")).value).toEqual({
      atImport: "from the deployment",
      // An ES module package: its exports, and the variables at its import too.
      esm: "the default",
      esmAtImport: "from the deployment",
      now: "from the deployment",
      // The package also sees the server's own variables; the action's `process.env` does not (STUDY-37).
      server: "the server's",
      action: null,
    });
    // Outside an action the server's `process.env` is its own.
    expect(process.env.SECRET_KEY).toBeUndefined();
  }, 60_000);
});

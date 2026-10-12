// `node.externalPackages` (STUDY-148) on Convex's backend (the oracle) and on bunvex's: the app of
// `external-app/` deployed by each CLI with `"*"`, its packages installed by each deployment from a registry this
// test serves (`npm install` there, `bun install` here: DV-470). Compared: the actions' answers (a file read beside
// the package, `require`), what `start_push` answers for packages (an id, the same one again), a version the
// registry lacks (Convex's 400 `InvalidExternalModules`, the installer's command and output aside), and the decided
// differences asserted on each side: a packaged binary keeps its mode on bunvex only (DV-473), packages see the
// server's own variables on bunvex only (DV-472).
//
// Local only: skipped, with a note, when Convex's backend is not there (scripts/download-convex-backend.sh, or
// CONVEX_BACKEND_BIN) or `npm` is not (Convex's local Node executor runs it). Convex's executor drops the backend's
// `npm_config_*` variables once it has run any Node code (an analysis included), so both backends start with an app
// that has no Node module (`external-app/`), every install happens before `later/ext.ts` is pushed, and that push
// installs before its own analysis.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";
import { type Registry, startRegistry, type TestPackage, writePackage } from "../harness/npm-registry.ts";

const ready = existsSync(ORACLE_BIN) && Bun.which("npm") !== null;
if (!ready)
  console.warn(`external-packages: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN) or no npm`);

const APP = resolve(import.meta.dir, "../external-app");
const HARNESS_MODULES = resolve(import.meta.dir, "../node_modules");

const PACKAGES: TestPackage[] = [
  {
    name: "tiny-asset",
    version: "1.2.3",
    files: {
      "index.js": `const fs = require("fs"); const path = require("path");
exports.read = () => fs.readFileSync(path.join(__dirname, "data.txt"), "utf8").trim();`,
      "data.txt": "hello from tiny-asset",
    },
  },
  {
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
  },
  { name: "tiny-env", version: "1.0.0", files: { "index.js": "exports.read = (name) => process.env[name] ?? null;" } },
];

/** Each backend's project directory. */
const projects: Record<string, string> = {};

/** The project with the packages installed, declared and listed (`"*"`) in its config file. */
function prepare(project: string, dir: "convex" | "bunvex") {
  projects[dir] = project;
  rmSync(join(project, "node_modules"));
  mkdirSync(join(project, "node_modules"));
  for (const name of readdirSync(HARNESS_MODULES))
    symlinkSync(join(HARNESS_MODULES, name), join(project, "node_modules", name));
  for (const p of PACKAGES) writePackage(join(project, "node_modules", p.name), p);
  const pkg = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
  for (const p of PACKAGES) pkg.dependencies[p.name] = p.version;
  writeFileSync(join(project, "package.json"), JSON.stringify(pkg));
  writeFileSync(join(project, `${dir}.json`), JSON.stringify({ node: { externalPackages: ["*"] } }));
}

let registry: Registry;
let convex: Backend;
let bunvex: Backend;
let caches: string;

beforeAll(async () => {
  if (!ready) return;
  registry = startRegistry(PACKAGES);
  caches = mkdtempSync(join(tmpdir(), "external-packages-caches-"));
  const env = {
    // npm's settings (Convex's executor runs it with the backend's environment), scripts on whatever the machine's
    // npm config says, a cache of the test's own.
    npm_config_registry: registry.url,
    npm_config_ignore_scripts: "false",
    npm_config_cache: join(caches, "npm"),
    // Bun's (the server's environment, DV-470).
    NPM_CONFIG_REGISTRY: registry.url,
    BUN_INSTALL_CACHE_DIR: join(caches, "bun"),
    SERVER_ONLY_VAR: "the server's",
  };
  [convex, bunvex] = await Promise.all([
    startConvex({ app: APP, env, prepare }),
    startBunvex({ app: APP, env, prepare }),
  ]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
  registry?.stop();
  if (caches) rmSync(caches, { recursive: true, force: true });
});

/** A dry `start_push` of no module, asking for `nodeDependencies`: the status, and the answer's code, message, id. */
async function startPush(b: Backend, nodeDependencies: { name: string; version: string }[]) {
  const r = await fetch(`${b.url}/api/deploy2/start_push`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      adminKey: b.adminKey,
      dryRun: true,
      functions: b.name === "convex" ? "convex/" : "bunvex/",
      appDefinition: {
        definition: null,
        dependencies: [],
        schema: null,
        changedModules: [],
        unchangedModuleHashes: [],
        udfServerVersion: "1.46.0",
      },
      componentDefinitions: [],
      nodeDependencies,
    }),
  });
  const body = (await r.json()) as { code?: string; message?: string; externalDepsId?: string | null };
  return { status: r.status, ...body };
}

async function action(b: Backend, path: string) {
  const r = await b.call("action", path, {});
  expect(r.ok).toBe(true);
  return (r.body as { value: unknown }).value;
}

describe.skipIf(!ready)("external packages, against Convex's backend", () => {
  // Installs first: Convex's executor loses the registry setting after its first Node action.
  test("a version the registry lacks: Convex's 400 InvalidExternalModules, the installer's output aside", async () => {
    const missing = [{ name: "tiny-asset", version: "9.9.9" }];
    const [c, b] = await Promise.all([startPush(convex, missing), startPush(bunvex, missing)]);
    const frame = (r: typeof c) => ({
      status: r.status,
      code: r.code,
      // Up to the command: npm's or Bun's (DV-470), then each one's own output.
      message: r.message?.replace(/Command failed: (npm|bun) install\n[\s\S]*$/, "Command failed: <installer> install"),
    });
    expect(frame(b)).toEqual(frame(c));
    expect(frame(c)).toEqual({
      status: 400,
      code: "InvalidExternalModules",
      message:
        "Hit an error while pushing:\nLoading the pushed modules encountered the following error:\nCommand failed: <installer> install",
    });
    // Each installer asked this registry, and said so its own way.
    expect(c.message).toContain("npm error code ETARGET");
    expect(c.message).toContain("tiny-asset@9.9.9");
    expect(b.message).toContain('No version matching "9.9.9" found for specifier "tiny-asset"');
  });

  test("start_push answers the packages' row; the same packages again reuse it", async () => {
    const deps = [
      { name: "tiny-asset", version: "1.2.3" },
      { name: "tiny-env", version: "1.0.0" },
    ];
    for (const b of [convex, bunvex]) {
      const first = await startPush(b, deps);
      expect([b.name, first.status, first.message]).toEqual([b.name, 200, undefined]);
      expect(first.externalDepsId).toMatch(/^[0-9a-z]{32}$/);
      // The same packages in another order: the same row.
      expect((await startPush(b, [...deps].reverse())).externalDepsId).toBe(first.externalDepsId);
      expect((await startPush(b, [])).externalDepsId).toBeNull();
    }
  });

  test("a push of the Node module installs its packages", async () => {
    for (const b of [convex, bunvex]) {
      let source = readFileSync(join(APP, "later/ext.ts"), "utf8");
      if (b.name === "bunvex") source = source.replaceAll('"convex/server"', '"bunvex/server"');
      writeFileSync(join(projects[b.name]!, b.name, "ext.ts"), source);
    }
    registry.requests.length = 0;
    await Promise.all([
      convex.cli(["deploy", "--yes", "--typecheck=disable"]),
      bunvex.cli(["deploy", "--typecheck=disable"]),
    ]);
    // Both installed tiny-bin, which no earlier push asked for, from this registry.
    expect(registry.requests.filter((r) => r === "GET /tiny-bin").length).toBeGreaterThanOrEqual(2);
  });

  test("the actions: a file beside the package, through an import and through `require`", async () => {
    const [c, b] = await Promise.all([action(convex, "ext:asset"), action(bunvex, "ext:asset")]);
    expect(b).toEqual(c);
    expect(c).toEqual({ text: "hello from tiny-asset", required: "hello from tiny-asset" });
  });

  test("a packaged binary: its install script ran on both; it keeps 0755 and runs on bunvex only (DV-473)", async () => {
    expect(await action(convex, "ext:bin")).toEqual({ mode: "666", ran: "error: EACCES", postinstall: true });
    expect(await action(bunvex, "ext:bin")).toEqual({ mode: "755", ran: "ran", postinstall: true });
  });

  test("the deployment's variables reach the packages; the server's own reach them on bunvex only (DV-472)", async () => {
    for (const b of [convex, bunvex]) await b.cli(["env", "set", "SECRET_KEY", "set"]);
    const [c, b] = await Promise.all([action(convex, "ext:env"), action(bunvex, "ext:env")]);
    expect(c).toEqual({ deployment: "set", server: null, action: null });
    expect(b).toEqual({ deployment: "set", server: "the server's", action: null });
  });
});

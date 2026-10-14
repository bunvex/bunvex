// The packages as npm ships them, on Node.js (STUDY-160): staged by scripts/npm-packages.ts into an app's
// node_modules, then imported by `node` — as ES modules and through `require` — against a real bunvex server.
// Convex's client runs on Node; bunvex's must too (owner, 2026-10-13). Run with `bun run test:npm`: it needs
// `node` (22 or later, for its global WebSocket) on the PATH.
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { startServer } from "../test/harness.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const app = mkdtempSync(join(tmpdir(), "bunvex-npm-node-"));
let h: Awaited<ReturnType<typeof startServer>>;

/** The app's node_modules/<name>: the workspace's install of it, as resolved from `dir`. */
function linkFrom(dir: string, name: string) {
  const to = join(app, "node_modules", name);
  if (existsSync(to)) return;
  mkdirSync(dirname(to), { recursive: true });
  symlinkSync(dirname(Bun.resolveSync(`${name}/package.json`, dir)), to);
}

beforeAll(async () => {
  const staged = Bun.spawnSync(["bun", join(ROOT, "scripts/npm-packages.ts"), join(app, "node_modules")], {
    stderr: "pipe",
  });
  if (staged.exitCode !== 0) throw new Error(`staging failed:\n${staged.stderr}`);
  // Every package's third-party dependencies and peers, from the workspace's install, as npm would add them.
  for (const dir of [
    "values",
    "core",
    "auth",
    "file-storage",
    "server",
    "client",
    "react",
    "react-auth0",
    "react-query",
  ]) {
    const m = JSON.parse(readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    for (const name of Object.keys({ ...m.dependencies, ...m.peerDependencies })) {
      if (name.startsWith("@bunvex/")) continue;
      linkFrom(join(ROOT, "packages", dir), name);
    }
  }
  // The scripts run from the app's directory: Node resolves their imports from where they are.
  for (const script of ["esm.mjs", "cjs.cjs", "types.ts", "types-cjs.cts"])
    copyFileSync(join(import.meta.dir, "app", script), join(app, script));
  h = await startServer();
}, 120_000);

afterAll(async () => {
  await h?.stop();
  rmSync(app, { recursive: true, force: true });
});

const version = (JSON.parse(readFileSync(join(ROOT, "packages/client/package.json"), "utf8")) as { version: string })
  .version;

async function node(script: string): Promise<Record<string, unknown>> {
  const p = Bun.spawn(["node", join(app, script), h.url], {
    cwd: app,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`node ${script} exited with ${code}:\n${err}`);
  return JSON.parse(out.trim().split("\n").at(-1)!) as Record<string, unknown>;
}

test("node runs the client as ES modules: HTTP and sync clients, Next.js helpers, React packages", async () => {
  // Node's global WebSocket is what the sync client uses there, as Convex's on Node 22+ (STUDY-151 §5).
  const major = Number(Bun.spawnSync(["node", "-p", "process.versions.node.split('.')[0]"]).stdout.toString());
  expect(major).toBeGreaterThanOrEqual(22);
  const r = await node("esm.mjs");
  expect(r).toEqual({
    version,
    sent: "FROM NODE",
    listed: ["from node"],
    echoed: "5n",
    error: { bunvexError: true, code: "nope", n: "7" },
    fetched: 1,
    live: ["from node"],
    tables: ["messages"],
    exports: ["function", "function", "function", "function", "function"],
  });
}, 60_000);

test("node runs the client through require (CommonJS)", async () => {
  const r = await node("cjs.cjs");
  expect(r).toEqual({
    version,
    sent: "FROM REQUIRE",
    listed: expect.arrayContaining(["from require"]),
    error: { bunvexError: true, code: "nope" },
    react: "function",
  });
}, 60_000);

/** `tsc` over the app's typed files, with the module settings an app on Node or behind a bundler uses. */
function tsc(
  module: "nodenext" | "esnext",
  resolution: "nodenext" | "bundler",
  files: string[],
  strict?: { types: string[] },
) {
  const config = join(app, `tsconfig.${resolution}${strict ? ".strict" : ""}.json`);
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module,
        moduleResolution: resolution,
        target: "ES2022",
        lib: ["ES2023", "DOM"],
        types: strict?.types ?? [],
        // As Next.js, Vite and `bunvex codegen --init` set it: @bunvex/server's declarations name Bun's types.
        skipLibCheck: !strict,
      },
      files,
    }),
  );
  const p = Bun.spawnSync([join(ROOT, "node_modules/.bin/tsc"), "-p", config], { cwd: app });
  return `${p.stdout}${p.stderr}`.trim();
}

test("TypeScript reads the published declarations, for import and for require", () => {
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "app", private: true, type: "module" }));
  expect(tsc("nodenext", "nodenext", ["types.ts", "types-cjs.cts"])).toBe("");
  expect(tsc("esnext", "bundler", ["types.ts"])).toBe("");
  // Every declaration checked, as an app on Node (Node's types, as Next.js's templates add) with `skipLibCheck`
  // off and no Bun types sees them: they name nothing of Bun's (DV-504, owner 2026-10-14: as Convex's).
  linkFrom(join(ROOT, "examples/nextjs-app-router"), "@types/node");
  expect(existsSync(join(app, "node_modules/@types/bun"))).toBe(false);
  expect(tsc("esnext", "bundler", ["types.ts"], { types: ["node"] })).toBe("");
  expect(tsc("nodenext", "nodenext", ["types.ts", "types-cjs.cts"], { types: ["node"] })).toBe("");
}, 60_000);

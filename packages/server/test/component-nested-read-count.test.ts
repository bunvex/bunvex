// Nested calls' reads (STUDY-161 §16.7), as Convex counts them: only the first nested call in a transaction reads its
// callee's start — two reads, one more from a component, one more into another namespace, and the callee's modules
// not loaded yet; later nested calls read nothing more. Every expected count below was measured on Convex's binary
// (`precompiled-2026-10-07-d8bdde0`) with the same app: the root with two modules (`app`, `rootother`), `probe` (two
// modules, mounted twice: `probe`, `second`), `probe2` and `probe3` (one module each). A call is named
// `component.module.function`, `app.module.function` for the root's, or by a handle the app made.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import type { ModuleSource } from "../src/code-version.ts";
import { Functions } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const SECRET = "cd".repeat(32);
const NAME = "component-nested-read-count-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const mod = (path: string, lines: string[]): ModuleSource => ({
  path,
  source: lines.join("\n"),
  environment: "isolate",
});
const dep = (path: string) => `./_componentDeps/${Buffer.from(path).toString("base64url")}`;
const used = "(await ctx.meta.getTransactionMetrics()).databaseQueries.used";
const noop = "export const noop = query({ args: {}, handler: async () => null });";

const component = (name: string, modules: string[]) => ({
  definitionPath: name,
  definition: mod("bunvex.config.js", [
    'import { defineComponent } from "bunvex/server";',
    `export default defineComponent("${name}");`,
  ]),
  dependencies: [] as string[],
  schema: null,
  functions: modules.map((m) =>
    mod(`${m}.js`, [
      'import { query } from "bunvex/server";',
      'import { v } from "bunvex/values";',
      "export const q = query({ args: {}, handler: async () => null });",
      `export const viaHandle = query({ args: { handles: v.array(v.string()) }, handler: async (ctx, { handles }) => { for (const h of handles) await ctx.runQuery(h, {}); return ${used}; } });`,
    ]),
  ),
  udfServerVersion: "1.46.0",
});

const APP = mod("app.js", [
  'import { componentsGeneric, createFunctionHandle, mutation, query } from "bunvex/server";',
  'import { v } from "bunvex/values";',
  "const components = componentsGeneric();",
  "const ref = (name) => { const [c, m, f] = name.split('.'); return c === 'app' ? `${m}:${f}` : components[c][m][f]; };",
  noop,
  `export const calls = query({ args: { calls: v.array(v.string()) }, handler: async (ctx, { calls }) => { for (const c of calls) await ctx.runQuery(ref(c), {}); return ${used}; } });`,
  "export const handles = mutation({ args: {}, handler: async () => Promise.all([ref('app.app.noop'), ref('app.rootother.noop'), components.probe2.lib.q, components.probe.other.q, components.probe.lib.q].map((r) => createFunctionHandle(r))) });",
]);
const ROOTOTHER = mod("rootother.js", ['import { query } from "bunvex/server";', noop]);

async function deployment() {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-component-nested-"));
  dirs.push(dir);
  const engine = await new Engine(defineSchema({}), new SqlitePersistence(join(dir, "db.sqlite"), { durable: true }), {
    instanceName: NAME,
    instanceSecret: SECRET,
    storedSchema: true,
  }).init();
  const s = createServer({
    engine,
    functions: new Functions(engine),
    port: 0,
    deployable: true,
    moduleStorage: new MemoryBlobStore(),
    redactLogsToClient: false,
  });
  await s.codeReady;
  stops.push(async () => {
    s.server.stop(true);
    await engine.close();
  });
  const api = `http://127.0.0.1:${s.server.port}`;
  const post = async (path: string, body: object) => {
    const r = await fetch(`${api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bunvex ${KEY}` },
      body: JSON.stringify(body),
    });
    return (await r.json()) as Record<string, any>;
  };
  const start = await post("/api/deploy2/start_push", {
    adminKey: KEY,
    functions: "bunvex",
    nodeDependencies: [],
    appDefinition: {
      definition: mod("bunvex.config.js", [
        'import { defineApp } from "bunvex/server";',
        `import probe from "${dep("probe")}";`,
        `import probe2 from "${dep("probe2")}";`,
        `import probe3 from "${dep("probe3")}";`,
        "const app = defineApp();",
        "app.use(probe);",
        'app.use(probe, { name: "second" });',
        "app.use(probe2);",
        "app.use(probe3);",
        "export default app;",
      ]),
      dependencies: ["probe", "probe2", "probe3"],
      schema: null,
      changedModules: [APP, ROOTOTHER],
      unchangedModuleHashes: [],
      udfServerVersion: "1.46.0",
    },
    componentDefinitions: [
      component("probe", ["lib", "other"]),
      component("probe2", ["lib"]),
      component("probe3", ["zz"]),
    ],
  });
  if (!start.schemaChange) throw new Error(JSON.stringify(start));
  await post("/api/deploy2/wait_for_schema", { adminKey: KEY, schemaChange: start.schemaChange, timeoutMs: 5000 });
  const finish = await post("/api/deploy2/finish_push", { adminKey: KEY, startPush: start, dryRun: false });
  if (finish.code) throw new Error(JSON.stringify(finish));
  const value = async (componentPath: string, path: string, args: object, kind = "function") => {
    const r = await post(`/api/${kind}`, { componentPath, path, args, format: "json" });
    if (r.status !== "success") throw new Error(JSON.stringify(r));
    return r.value;
  };
  return value;
}

test("from the app: the first nested call counts its callee's start, the later ones nothing (Convex's counts)", async () => {
  const value = await deployment();
  const cases: [string[], number][] = [
    [[], 4],
    [["app.app.noop"], 6],
    [["app.rootother.noop"], 7],
    [["app.app.noop", "app.rootother.noop"], 6],
    [["probe.lib.q"], 9],
    [["probe2.lib.q"], 8],
    [["app.app.noop", "probe.lib.q"], 6],
    [["probe.lib.q", "probe2.lib.q", "probe3.zz.q"], 9],
    [["probe2.lib.q", "probe.lib.q"], 8],
    [["probe.lib.q", "app.rootother.noop"], 9],
    [["probe.lib.q", "second.lib.q"], 9],
    [["probe.lib.q", "probe.other.q"], 9],
  ];
  const got = [];
  for (const [calls] of cases) got.push([calls, await value("", "app:calls", { calls })]);
  expect(got).toEqual(cases);
});

test("from a component, by handles: back into the app, into another component, into itself (Convex's counts)", async () => {
  const value = await deployment();
  const [app, rootother, probe2, other, lib] = (await value("", "app:handles", {}, "mutation")) as string[];
  const cases: [string, string[], number][] = [
    ["alone", [], 5],
    ["into the app", [app!], 11],
    ["into the app's other module", [rootother!], 11],
    ["into the app twice", [app!, rootother!], 11],
    ["into another component", [probe2!], 10],
    ["into its own other module", [other!], 9],
    ["into its own module", [lib!], 8],
    ["into another component, then the app", [probe2!, app!], 10],
    ["into the app, then another component", [app!, probe2!], 11],
  ];
  const got = [];
  for (const [label, handles] of cases) got.push([label, handles, await value("probe", "lib:viaHandle", { handles })]);
  expect(got).toEqual(cases);
});

// The reads a component's function starts with (STUDY-161 §16.7), as Convex counts them (measured on its binary,
// `precompiled-2026-10-07-d8bdde0`, with `ctx.meta` and the "Many reads" warning): a root function 2 + its modules; a
// component's 3 + its modules (Convex's `load_component_args`), the modules its namespace's own — with two function
// modules or more, the chunk Convex's library would be in (§16.3). Each run reports its transaction's count.
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

const SECRET = "ab".repeat(32);
const NAME = "component-read-count-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const mod = (path: string, source: string): ModuleSource => ({ path, source, environment: "isolate" });
const dep = (path: string) => `./_componentDeps/${Buffer.from(path).toString("base64url")}`;
/** A function reporting its transaction's count of reads so far (no read of its own). */
const reads = `export const reads = query({ args: {}, handler: async (ctx) => (await ctx.meta.getTransactionMetrics()).databaseQueries.used });`;

/** The same after a write (a component's write checks it is mounted: the engine's read, not counted). */
const write = `export const write = mutation({ args: {}, handler: async (ctx) => { await ctx.db.insert("items", { n: 1 }); return (await ctx.meta.getTransactionMetrics()).databaseQueries.used; } });`;

const component = (name: string, modules: string[]) => ({
  definitionPath: name,
  definition: mod(
    "bunvex.config.js",
    `import { defineComponent } from "bunvex/server";\nexport default defineComponent("${name}");`,
  ),
  dependencies: [] as string[],
  schema: mod(
    "schema.js",
    `import { defineSchema, defineTable } from "bunvex/server";\nimport { v } from "bunvex/values";\nexport default defineSchema({ items: defineTable(v.any()) });`,
  ),
  functions: modules.map((m) => mod(`${m}.js`, `import { mutation, query } from "bunvex/server";\n${reads}\n${write}`)),
  udfServerVersion: "1.46.0",
});

async function deployment() {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-component-read-count-"));
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
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const start = await post("/api/deploy2/start_push", {
    adminKey: KEY,
    functions: "bunvex",
    nodeDependencies: [],
    appDefinition: {
      definition: mod(
        "bunvex.config.js",
        `import { defineApp } from "bunvex/server";\nimport one from "${dep("one")}";\nimport two from "${dep("two")}";\nconst app = defineApp();\napp.use(one);\napp.use(two);\napp.use(two, { name: "again" });\nexport default app;`,
      ),
      dependencies: ["one", "two"],
      schema: null,
      changedModules: [mod("app.js", `import { query } from "bunvex/server";\n${reads}`)],
      unchangedModuleHashes: [],
      udfServerVersion: "1.46.0",
    },
    componentDefinitions: [component("one", ["lib"]), component("two", ["lib", "other"])],
  });
  if (start.status !== 200) throw new Error(JSON.stringify(start.body));
  await post("/api/deploy2/wait_for_schema", { adminKey: KEY, schemaChange: start.body.schemaChange, timeoutMs: 5000 });
  const finish = await post("/api/deploy2/finish_push", { adminKey: KEY, startPush: start.body, dryRun: false });
  if (finish.status !== 200) throw new Error(JSON.stringify(finish.body));
  return async (componentPath: string, path: string) => {
    const r = await post("/api/function", { componentPath, path, args: {}, format: "json" });
    if (r.body.status !== "success") throw new Error(JSON.stringify(r.body));
    return r.body.value as number;
  };
}

test("a function's start reads: the app's, and a component's with its component's own modules", async () => {
  const run = await deployment();
  // the app: its configuration, its environment, its one module
  expect(await run("", "app:reads")).toBe(3);
  // a component of one module: 3 + its module
  expect(await run("one", "lib:reads")).toBe(4);
  // a component of two modules: 3 + its module + the chunk Convex's library would be in (Convex: 5, measured)
  expect(await run("two", "lib:reads")).toBe(5);
  expect(await run("two", "other:reads")).toBe(5);
  // another instance of the same definition: the same
  expect(await run("again", "lib:reads")).toBe(5);
  // a write counts nothing more (Convex: the same count, measured)
  expect(await run("one", "lib:write")).toBe(4);
  expect(await run("two", "lib:write")).toBe(5);
});

// Search and vector indexes in components (STUDY-157 PR 5): Convex's `textSearchInComponent.test.ts` and
// `vectorSearchInComponent.test.ts` (js-integration-tests at c358201e1) rewritten for bunvex — a component's text
// search from a query and a mutation (its own writes included, a filter that matches and one that does not), and its
// action's `ctx.vectorSearch` — plus an app table of the same name kept apart, and the indexes back after a restart.
import { afterEach, describe, expect, test } from "bun:test";
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
const NAME = "component-search-test";
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

const APP_DEFINITION = mod("bunvex.config.js", [
  'import { defineApp } from "bunvex/server";',
  `import foods from "${dep("foods")}";`,
  "const app = defineApp();",
  "app.use(foods);",
  "export default app;",
]);
/** The same table in the app and in the component, each with its own indexes. */
const SCHEMA = mod("schema.js", [
  'import { defineSchema, defineTable } from "bunvex/server";',
  'import { v } from "bunvex/values";',
  "export default defineSchema({",
  "  foods: defineTable({ description: v.string(), cuisine: v.string(), embedding: v.array(v.float64()) })",
  '    .searchIndex("by_description", { searchField: "description", filterFields: ["cuisine"] })',
  '    .vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 3, filterFields: ["cuisine"] }),',
  "});",
]);
const SEARCH = (db: string) =>
  `async (ctx, { query, cuisine }) => ${db}.query("foods").withSearchIndex("by_description", (q) => cuisine === undefined ? q.search("description", query) : q.search("description", query).eq("cuisine", cuisine)).collect()`;
const SEARCH_ARGS = "{ query: v.string(), cuisine: v.optional(v.string()) }";
const APP = mod("app.js", [
  'import { action, componentsGeneric, mutation, query } from "bunvex/server";',
  'import { v } from "bunvex/values";',
  "const c = componentsGeneric().foods.lib;",
  "export const populate = mutation({ args: {}, handler: async (ctx) => { await ctx.runMutation(c.populate, {}); await ctx.db.insert('foods', { description: 'app soup', cuisine: 'app', embedding: [1, 0, 0] }); } });",
  `export const searchQuery = query({ args: ${SEARCH_ARGS}, handler: async (ctx, a) => ctx.runQuery(c.searchQuery, a) });`,
  `export const searchMutation = mutation({ args: ${SEARCH_ARGS}, handler: async (ctx, a) => ctx.runMutation(c.searchMutation, a) });`,
  "export const searchWithWrite = mutation({ args: {}, handler: async (ctx) => ctx.runMutation(c.searchWithWrite, {}) });",
  `export const appSearch = query({ args: ${SEARCH_ARGS}, handler: ${SEARCH("ctx.db")} });`,
  "export const vector = action({ args: { cuisine: v.optional(v.string()) }, handler: async (ctx, a) => ctx.runAction(c.vector, a) });",
]);
const FOODS = [
  ["a soup of tomatoes, warm", "italian", [1, 0, 0]],
  ["a cold soup of cucumbers", "spanish", [0, 1, 0]],
  ["noodles with a spicy sauce", "thai", [0, 0, 1]],
];
const COMPONENT = {
  definitionPath: "foods",
  definition: mod("bunvex.config.js", [
    'import { defineComponent } from "bunvex/server";',
    'export default defineComponent("foods");',
  ]),
  dependencies: [] as string[],
  schema: SCHEMA,
  functions: [
    mod("lib.js", [
      'import { action, mutation, query } from "bunvex/server";',
      'import { v } from "bunvex/values";',
      `export const populate = mutation({ args: {}, handler: async (ctx) => { for (const [description, cuisine, embedding] of ${JSON.stringify(FOODS)}) await ctx.db.insert("foods", { description, cuisine, embedding }); } });`,
      `export const searchQuery = query({ args: ${SEARCH_ARGS}, handler: async (ctx, a) => (await (${SEARCH("ctx.db")})(ctx, a)).map((d) => d.description) });`,
      `export const searchMutation = mutation({ args: ${SEARCH_ARGS}, handler: async (ctx, a) => (await (${SEARCH("ctx.db")})(ctx, a)).map((d) => d.description) });`,
      // Convex's "with a write": the transaction's own insert is found.
      `export const searchWithWrite = mutation({ args: {}, handler: async (ctx) => { await ctx.db.insert("foods", { description: "a soup of pumpkins", cuisine: "american", embedding: [1, 1, 0] }); return (await (${SEARCH("ctx.db")})(ctx, { query: "soup" })).map((d) => d.description); } });`,
      'export const vector = action({ args: { cuisine: v.optional(v.string()) }, handler: async (ctx, { cuisine }) => { const hits = await ctx.vectorSearch("foods", "by_embedding", { vector: [1, 0.1, 0], limit: 2, ...(cuisine === undefined ? {} : { filter: (q) => q.eq("cuisine", cuisine) }) }); return Promise.all(hits.map(async (h) => (await ctx.runQuery("lib:get", { id: h._id }))?.description)); } });',
      'export const get = query({ args: { id: v.id("foods") }, handler: async (ctx, { id }) => ctx.db.get(id) });',
    ]),
  ],
  udfServerVersion: "1.46.0",
};

/** A deployable server on `dir` (a new store when absent), with its module store kept across restarts. */
async function server(dir: string, modules: MemoryBlobStore) {
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
    moduleStorage: modules,
    redactLogsToClient: false,
  });
  await s.codeReady;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    s.server.stop(true);
    await engine.close();
  };
  stops.push(stop);
  const api = `http://127.0.0.1:${s.server.port}`;
  const post = async (path: string, body: object) => {
    const r = await fetch(`${api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bunvex ${KEY}` },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: text ? (JSON.parse(text) as Record<string, any>) : null };
  };
  /** The app's function `path`: its value, or its error's message. */
  const call = async (kind: "query" | "mutation" | "action", path: string, args: object = {}) => {
    const r = (await post(`/api/${kind}`, { path, args, format: "json" })).body!;
    return r.status === "success" ? r.value : { error: r.errorMessage as string };
  };
  return { engine, post, call, stop };
}

const NO_COMPONENTS = mod("bunvex.config.js", [
  'import { defineApp } from "bunvex/server";',
  "export default defineApp();",
]);

/** A push of the app, with the component mounted or not. */
async function push(s: Awaited<ReturnType<typeof server>>, mounted = true) {
  const start = await s.post("/api/deploy2/start_push", {
    adminKey: KEY,
    functions: "bunvex",
    nodeDependencies: [],
    appDefinition: {
      definition: mounted ? APP_DEFINITION : NO_COMPONENTS,
      dependencies: mounted ? ["foods"] : [],
      schema: SCHEMA,
      changedModules: [APP],
      unchangedModuleHashes: [],
      udfServerVersion: "1.46.0",
    },
    componentDefinitions: mounted ? [COMPONENT] : [],
  });
  if (start.status !== 200) throw new Error(JSON.stringify(start.body));
  await s.post("/api/deploy2/wait_for_schema", {
    adminKey: KEY,
    schemaChange: start.body!.schemaChange,
    timeoutMs: 5000,
  });
  const finish = await s.post("/api/deploy2/finish_push", { adminKey: KEY, startPush: start.body, dryRun: false });
  if (finish.status !== 200) throw new Error(JSON.stringify(finish.body));
}

async function deployment() {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-component-search-"));
  dirs.push(dir);
  const modules = new MemoryBlobStore();
  const s = await server(dir, modules);
  await push(s);
  expect(await s.call("mutation", "app:populate")).toBeNull();
  return { ...s, dir, modules };
}

/** The search, once the indexes answer (built in the background after the push or a start). */
async function settled(f: () => Promise<unknown>) {
  const end = Date.now() + 5000;
  for (;;) {
    const r = await f();
    const error = (r as { error?: string } | null)?.error;
    if (!error || !/backfill|bootstrap|not available|try again/i.test(error) || Date.now() > end) return r;
    await Bun.sleep(20);
  }
}

describe("text search in a component (Convex's textSearchInComponent)", () => {
  test("from a query: the component's documents only, a filter that matches and one that does not", async () => {
    const d = await deployment();
    // By relevance: compared as sets.
    expect(((await settled(() => d.call("query", "app:searchQuery", { query: "soup" }))) as string[]).sort()).toEqual([
      "a cold soup of cucumbers",
      "a soup of tomatoes, warm",
    ]);
    expect(await d.call("query", "app:searchQuery", { query: "soup", cuisine: "spanish" })).toEqual([
      "a cold soup of cucumbers",
    ]);
    expect(await d.call("query", "app:searchQuery", { query: "soup", cuisine: "french" })).toEqual([]);
    // The app's table of the same name, its own index.
    expect(
      ((await d.call("query", "app:appSearch", { query: "soup" })) as { description: string }[]).map(
        (f) => f.description,
      ),
    ).toEqual(["app soup"]);
  });

  test("from a mutation, its own write included", async () => {
    const d = await deployment();
    expect(await settled(() => d.call("mutation", "app:searchMutation", { query: "noodles" }))).toEqual([
      "noodles with a spicy sauce",
    ]);
    expect(await d.call("mutation", "app:searchMutation", { query: "noodles", cuisine: "italian" })).toEqual([]);
    expect(((await d.call("mutation", "app:searchWithWrite")) as string[]).sort()).toEqual([
      "a cold soup of cucumbers",
      "a soup of pumpkins",
      "a soup of tomatoes, warm",
    ]);
  });
});

describe("vector search in a component (Convex's vectorSearchInComponent)", () => {
  test("an action's ctx.vectorSearch reads its component's index, with a filter", async () => {
    const d = await deployment();
    expect(await settled(() => d.call("action", "app:vector", {}))).toEqual([
      "a soup of tomatoes, warm",
      "a cold soup of cucumbers",
    ]);
    expect(await d.call("action", "app:vector", { cuisine: "thai" })).toEqual(["noodles with a spicy sauce"]);
  });
});

test("after a restart, a component's indexes answer again", async () => {
  const d = await deployment();
  expect(await settled(() => d.call("query", "app:searchQuery", { query: "cucumbers" }))).toEqual([
    "a cold soup of cucumbers",
  ]);
  await d.stop();
  const again = await server(d.dir, d.modules);
  expect(await settled(() => again.call("query", "app:searchQuery", { query: "cucumbers" }))).toEqual([
    "a cold soup of cucumbers",
  ]);
  expect(await settled(() => again.call("action", "app:vector", { cuisine: "spanish" }))).toEqual([
    "a cold soup of cucumbers",
  ]);
});

test("a deleted component's indexes are dropped with it; the app's stay", async () => {
  const d = await deployment();
  await settled(() => d.call("query", "app:searchQuery", { query: "soup" }));
  const tables = () => new Set(d.engine.searchIndexes.all().map((e) => e.tablet)).size;
  expect(tables()).toBe(2);
  const id = (
    (await d.post("/api/query", { path: "_system/frontend/components:list", args: {}, format: "json" })).body!
      .value as { id: string; path: string }[]
  ).find((c) => c.path === "foods")!.id;
  await push(d, false);
  // Unmounted, its data and indexes are kept (it may be remounted).
  expect(tables()).toBe(2);
  expect((await d.post("/api/delete_component", { componentId: id })).status).toBe(200);
  expect(tables()).toBe(1);
  expect(d.engine.vectorIndexes.all()).toHaveLength(1);
});

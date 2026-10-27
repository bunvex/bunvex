// The dashboard's system functions in a component (STUDY-152 §4, step 9), as Convex's `queryWithComponent` /
// `mutationWithComponent` (system-udfs `secretSystemTables.ts`): a non-null `componentId` runs the function again
// in that component's namespace, with `componentId: null`; its audit events name the component.
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
const NAME = "component-system-functions-test";
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
  `import counter from "${dep("counter")}";`,
  "const app = defineApp();",
  "app.use(counter);",
  "export default app;",
]);
const APP_SCHEMA = mod("schema.js", [
  'import { defineSchema, defineTable } from "bunvex/server";',
  'import { v } from "bunvex/values";',
  "export default defineSchema({ notes: defineTable({ text: v.string() }) });",
]);
const APP = mod("app.js", [
  'import { componentsGeneric, mutation, query } from "bunvex/server";',
  "const c = componentsGeneric().counter.lib;",
  "export const seed = mutation({ args: {}, handler: async (ctx) => { await ctx.db.insert('notes', { text: 'app' }); await ctx.runMutation(c.add, { n: 1 }); } });",
  "export const items = query({ args: {}, handler: async (ctx) => ctx.runQuery(c.all, {}) });",
]);
const COUNTER = {
  definitionPath: "counter",
  definition: mod("bunvex.config.js", [
    'import { defineComponent } from "bunvex/server";',
    'export default defineComponent("counter");',
  ]),
  dependencies: [] as string[],
  schema: mod("schema.js", [
    'import { defineSchema, defineTable } from "bunvex/server";',
    'import { v } from "bunvex/values";',
    "export default defineSchema({ items: defineTable({ n: v.number() }) });",
  ]),
  functions: [
    mod("lib.js", [
      'import { mutation, query } from "bunvex/server";',
      'import { v } from "bunvex/values";',
      "export const add = mutation({ args: { n: v.number() }, handler: async (ctx, { n }) => ctx.db.insert('items', { n }) });",
      "export const all = query({ args: {}, handler: async (ctx) => ctx.db.query('items').collect() });",
    ]),
  ],
  udfServerVersion: "1.46.0",
};

async function deployment() {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-component-storage-"));
  dirs.push(dir);
  const engine = await new Engine(defineSchema({}), new SqlitePersistence(join(dir, "db.sqlite"), { durable: true }), {
    instanceName: NAME,
    instanceSecret: SECRET,
    storedSchema: true,
  }).init();
  const functions = new Functions(engine);
  const s = createServer({
    engine,
    functions,
    port: 0,
    deployable: true,
    moduleStorage: new MemoryBlobStore(),
    fileStorage: new MemoryBlobStore(),
    redactLogsToClient: false,
  });
  await s.codeReady;
  stops.push(async () => {
    s.server.stop(true);
    await engine.close();
  });
  const api = `http://127.0.0.1:${s.server.port}`;
  const post = async (path: string, body: object, auth: string | null = `Bunvex ${KEY}`) => {
    const r = await fetch(`${api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: text ? (JSON.parse(text) as Record<string, any>) : null };
  };
  const start = await post("/api/deploy2/start_push", {
    adminKey: KEY,
    functions: "bunvex",
    nodeDependencies: [],
    appDefinition: {
      definition: APP_DEFINITION,
      dependencies: ["counter"],
      schema: APP_SCHEMA,
      changedModules: [APP],
      unchangedModuleHashes: [],
      udfServerVersion: "1.46.0",
    },
    componentDefinitions: [COUNTER],
  });
  if (start.status !== 200) throw new Error(JSON.stringify(start.body));
  await post("/api/deploy2/wait_for_schema", {
    adminKey: KEY,
    schemaChange: start.body!.schemaChange,
    timeoutMs: 5000,
  });
  const finish = await post("/api/deploy2/finish_push", { adminKey: KEY, startPush: start.body, dryRun: false });
  if (finish.status !== 200) throw new Error(JSON.stringify(finish.body));
  /** A function `path` called with the admin key; its value, or its error's message. */
  const call = async (kind: "query" | "mutation", path: string, args: object = {}) => {
    const r = (await post(`/api/${kind}`, { path, args, format: "json" })).body!;
    return r.status === "success" ? r.value : { error: r.errorMessage as string };
  };
  const componentId = (
    (await post("/api/query", { path: "_system/frontend/components:list", args: {}, format: "json" })).body!.value as {
      id: string;
      path: string;
    }[]
  ).find((c) => c.path === "counter")!.id;
  await call("mutation", "app:seed");
  const upload = async (url: string, text: string) =>
    (
      (await (await fetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body: text })).json()) as {
        storageId: string;
      }
    ).storageId;
  return { api, call, componentId, upload };
}

describe("the dashboard's system functions in a component (STUDY-152 §4)", () => {
  test("reads: the table mapping, sizes, a page, the schemas, each in the component's namespace", async () => {
    const d = await deployment();
    const q = (path: string, args: object = {}) => d.call("query", `_system/frontend/${path}`, args);
    const names = (m: unknown) => Object.values(m as Record<string, string>).filter((n) => !n.startsWith("_"));
    expect(names(await q("getTableMapping", {}))).toEqual(["notes"]);
    expect(names(await q("getTableMapping", { componentId: d.componentId }))).toEqual(["items"]);
    expect(await q("tableSize", { tableName: "items", componentId: d.componentId })).toBe(1);
    expect(await q("tableSize", { tableName: "items" })).toBe(0);
    expect(await q("tableSize:sizeOfAllTables", { componentId: d.componentId })).toBe(1);
    const page = (await q("paginatedTableDocuments", {
      componentId: d.componentId,
      table: "items",
      filters: null,
      paginationOpts: { numItems: 10, cursor: null },
    })) as { page: { n: number }[] };
    expect(page.page.map((x) => x.n)).toEqual([1]);
    const schemas = (await q("getSchemas", { componentId: d.componentId })) as { active: string };
    expect(JSON.parse(schemas.active).tables.map((t: { tableName: string }) => t.tableName)).toEqual(["items"]);
    // an id that names no component is a system error, as Convex's `must_component_path`
    expect(await q("getTableMapping", { componentId: "nope" })).toHaveProperty("error");
    // apiSpec reads its componentId itself: the component's functions
    const spec = (await d.call("query", "_system/cli/modules:apiSpec", { componentId: d.componentId })) as {
      identifier: string;
    }[];
    expect(spec.map((s) => s.identifier).sort()).toEqual(["lib.js:add", "lib.js:all"]);
  });

  test("writes: a document added in the component, its audit event naming it", async () => {
    const d = await deployment();
    const added = await d.call("mutation", "_system/frontend/addDocument", {
      componentId: d.componentId,
      table: "items",
      documents: [{ n: 2 }],
    });
    expect(added).toEqual({ success: true });
    expect(((await d.call("query", "app:items")) as { n: number }[]).map((x) => x.n)).toEqual([1, 2]);
    const events = (await d.call("query", "_system/frontend/listDeploymentEventsFromTime", { fromTimestamp: 0 })) as {
      action: string;
      metadata: Record<string, unknown>;
    }[];
    const add = events.find((e) => e.action === "add_documents")!;
    expect(add.metadata.component_id).toBe(d.componentId);
    expect(add.metadata.component).toBe("counter");
    expect(add.metadata.table).toBe("items");
  });

  test("files: an upload URL into the component, its files listed with `?component=`", async () => {
    const d = await deployment();
    const url = (await d.call("mutation", "_system/frontend/fileStorageV2:generateUploadUrl", {
      componentId: d.componentId,
    })) as string;
    const id = await d.upload(url, "hello");
    expect(await d.call("query", "_system/frontend/fileStorageV2:numFiles", {})).toBe(0);
    expect(await d.call("query", "_system/frontend/fileStorageV2:numFiles", { componentId: d.componentId })).toBe(1);
    const page = (await d.call("query", "_system/frontend/fileStorageV2:fileMetadata", {
      componentId: d.componentId,
      paginationOpts: { numItems: 10, cursor: null },
    })) as { page: { _id: string; url: string }[] };
    expect(page.page.map((f) => f._id)).toEqual([id]);
    expect(page.page[0]!.url).toEndWith(`?component=${d.componentId}`);
    expect((await fetch(page.page[0]!.url)).status).toBe(200);
  });
});

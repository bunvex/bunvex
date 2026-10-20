// File storage in components (STUDY-157 PR 3): Convex's "File storage in component" cases (js-integration-tests
// fileStorage.test.ts) rewritten for bunvex, plus a component query's `getUrl`, a mutation's `delete`, the download
// route's `?component=` (a missing one, an unknown one, one that is not an id) and the app's files unchanged.
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
const NAME = "component-storage-test";
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
const SCHEMA = mod("schema.js", [
  'import { defineSchema, defineTable } from "bunvex/server";',
  "export default defineSchema({});",
]);
/** `_storage` as the caller's namespace sees it: each file's id. */
const FILES = "async (ctx) => (await ctx.db.system.query('_storage').collect()).map((f) => f._id)";
const APP = mod("app.js", [
  'import { action, componentsGeneric, mutation, query } from "bunvex/server";',
  'import { v } from "bunvex/values";',
  "const c = componentsGeneric().counter.lib;",
  "export const uploadUrl = mutation({ args: {}, handler: async (ctx) => ctx.storage.generateUploadUrl() });",
  "export const url = query({ args: { id: v.string() }, handler: async (ctx, { id }) => ctx.storage.getUrl(id) });",
  `export const files = query({ args: {}, handler: ${FILES} });`,
  "export const filesInComponent = query({ args: {}, handler: async (ctx) => ctx.runQuery(c.files, {}) });",
  "export const componentUploadUrl = mutation({ args: {}, handler: async (ctx) => ctx.runMutation(c.uploadUrl, {}) });",
  "export const componentUrl = query({ args: { id: v.string() }, handler: async (ctx, a) => ctx.runQuery(c.url, a) });",
  "export const componentStoreAndGet = action({ args: { text: v.string() }, handler: async (ctx, a) => ctx.runAction(c.storeAndGet, a) });",
  "export const componentDeleteFromAction = action({ args: { id: v.string() }, handler: async (ctx, a) => ctx.runAction(c.removeFromAction, a) });",
  "export const componentDelete = mutation({ args: { id: v.string() }, handler: async (ctx, a) => ctx.runMutation(c.remove, a) });",
]);
const COUNTER = {
  definitionPath: "counter",
  definition: mod("bunvex.config.js", [
    'import { defineComponent } from "bunvex/server";',
    'export default defineComponent("counter");',
  ]),
  dependencies: [] as string[],
  schema: SCHEMA,
  functions: [
    mod("lib.js", [
      'import { action, mutation, query } from "bunvex/server";',
      'import { v } from "bunvex/values";',
      "export const uploadUrl = mutation({ args: {}, handler: async (ctx) => ctx.storage.generateUploadUrl() });",
      "export const url = query({ args: { id: v.string() }, handler: async (ctx, { id }) => ctx.storage.getUrl(id) });",
      `export const files = query({ args: {}, handler: ${FILES} });`,
      "export const removeFromAction = action({ args: { id: v.string() }, handler: async (ctx, { id }) => { await ctx.storage.delete(id); } });",
      "export const remove = mutation({ args: { id: v.string() }, handler: async (ctx, { id }) => { await ctx.storage.delete(id); } });",
      // Convex's "file storage store and get": an action stores a blob and reads it back, with its URL.
      "export const storeAndGet = action({ args: { text: v.string() }, handler: async (ctx, { text }) => { const id = await ctx.storage.store(new Blob([text], { type: 'text/plain' })); const blob = await ctx.storage.get(id); return { id, text: await blob.text(), url: await ctx.storage.getUrl(id), meta: await ctx.storage.getMetadata(id) }; } });",
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
      schema: SCHEMA,
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
  /** The app's function `path`, called as a client; its value, or its error's message. */
  const call = async (kind: "query" | "mutation" | "action", path: string, args: object = {}) => {
    const r = (await post(`/api/${kind}`, { path, args, format: "json" }, null)).body!;
    return r.status === "success" ? r.value : { error: r.errorMessage as string };
  };
  const componentId = (
    (await post("/api/query", { path: "_system/frontend/components:list", args: {}, format: "json" })).body!.value as {
      id: string;
      path: string;
    }[]
  ).find((c) => c.path === "counter")!.id;
  const upload = async (url: string, text: string) =>
    (
      (await (await fetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body: text })).json()) as {
        storageId: string;
      }
    ).storageId;
  return { api, call, componentId, upload };
}

describe("File storage in component (Convex's js-integration-tests)", () => {
  test("file storage upload and get url: the child's file, its URL with ?component=", async () => {
    const d = await deployment();
    const storageId = await d.upload(await d.call("mutation", "app:componentUploadUrl"), "hello");
    expect(await d.call("query", "app:filesInComponent")).toEqual([storageId]);
    expect(await d.call("query", "app:files")).toEqual([]);
    const url = (await d.call("query", "app:componentUrl", { id: storageId })) as string;
    expect(url).toBe(`${d.api}/api/storage/${url.split("/").pop()!.split("?")[0]}?component=${d.componentId}`);
    const r = await fetch(url);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/plain");
    expect(await r.text()).toBe("hello");
  });

  test("file storage store and get: an action's blob, read back in its component", async () => {
    const d = await deployment();
    const r = (await d.call("action", "app:componentStoreAndGet", { text: "stored" })) as any;
    expect(r.text).toBe("stored");
    expect(r.url).toEndWith(`?component=${d.componentId}`);
    expect(r.meta).toMatchObject({ size: 6, contentType: "text/plain" });
    expect(await d.call("query", "app:filesInComponent")).toEqual([r.id]);
    expect(await d.call("query", "app:files")).toEqual([]);
    expect(await (await fetch(r.url)).text()).toBe("stored");
  });
});

describe("a component's files", () => {
  test("the download route: without ?component= or with another component, a 404; not an id, a 500", async () => {
    const d = await deployment();
    const storageId = await d.upload(await d.call("mutation", "app:componentUploadUrl"), "hello");
    const url = (await d.call("query", "app:componentUrl", { id: storageId })) as string;
    const bare = url.split("?")[0];
    const uuid = bare.split("/").pop();
    const missing = await fetch(bare);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ code: "FileNotFound", message: `File ${uuid} not found` });
    // An id that names no component (a file's own id): no such namespace, no such file.
    const other = await fetch(`${bare}?component=${storageId}`);
    expect(other.status).toBe(404);
    expect(((await other.json()) as { code: string }).code).toBe("FileNotFound");
    expect((await fetch(`${bare}?component=nope`)).status).toBe(500);
  });

  test("an app's file stays the app's: its URL has no ?component=, and the component's view has no such file", async () => {
    const d = await deployment();
    const storageId = await d.upload(await d.call("mutation", "app:uploadUrl"), "app file");
    expect(await d.call("query", "app:files")).toEqual([storageId]);
    expect(await d.call("query", "app:filesInComponent")).toEqual([]);
    const url = (await d.call("query", "app:url", { id: storageId })) as string;
    expect(url).not.toContain("?component=");
    expect(await (await fetch(url)).text()).toBe("app file");
    expect((await fetch(`${url}?component=${d.componentId}`)).status).toBe(404);
  });

  for (const [kind, path] of [
    ["mutation", "app:componentDelete"],
    ["action", "app:componentDeleteFromAction"],
  ] as const)
    test(`a component's ${kind} deletes its own file`, async () => {
      const d = await deployment();
      const storageId = await d.upload(await d.call("mutation", "app:componentUploadUrl"), "gone");
      expect(await d.call(kind, path, { id: storageId })).toBeNull();
      expect(await d.call("query", "app:filesInComponent")).toEqual([]);
      expect(await d.call("query", "app:componentUrl", { id: storageId })).toBeNull();
    });
});

// Running a function inside a component (STUDY-154 PR 2): a pushed component's code loaded in its own contexts and
// run by an admin with its component path (`/api/function`, the websocket), in its namespace, with its variables, its
// schema and Convex's refusals; each instance its own; reloaded after a push and at a restart.
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
import { syncUrl, v1Client } from "./v1-client.ts";

const SECRET = "ef".repeat(32);
const NAME = "component-runtime-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const mod = (path: string, source: string): ModuleSource => ({ path, source, environment: "isolate" });
const dep = (path: string) => `./_componentDeps/${Buffer.from(path).toString("base64url")}`;

/** The app mounting `counter` twice: the first with its variables bound, the second without. */
const appDefinition = (withSecond = true) =>
  mod(
    "bunvex.config.js",
    `import { defineApp } from "bunvex/server";\nimport { v } from "bunvex/values";\nimport counter from "${dep("counter")}";\nconst app = defineApp({ env: { APPX: v.optional(v.string()) } });\napp.use(counter, { env: { MODE: "fast", KEY: app.env.APPX } });\n${withSecond ? `app.use(counter, { name: "second" });\n` : ""}export default app;`,
  );
const COUNTER = {
  definitionPath: "counter",
  definition: mod(
    "bunvex.config.js",
    `import { defineComponent } from "bunvex/server";\nimport { v } from "bunvex/values";\nexport default defineComponent("counter", { env: { MODE: v.optional(v.string()), KEY: v.optional(v.string()) } });`,
  ),
  dependencies: [] as string[],
  schema: mod(
    "schema.js",
    `import { defineSchema, defineTable } from "bunvex/server";\nimport { v } from "bunvex/values";\nexport default defineSchema({ messages: defineTable({ body: v.string() }).index("by_body", ["body"]) });`,
  ),
  functions: [
    mod(
      "lib.js",
      [
        'import { action, internalQuery, mutation, query } from "bunvex/server";',
        'import { v } from "bunvex/values";',
        "let calls = 0;",
        'export const add = mutation({ args: { body: v.string() }, handler: async (ctx, a) => ctx.db.insert("messages", { body: a.body }) });',
        'export const bad = mutation({ args: {}, handler: async (ctx) => ctx.db.insert("messages", { body: 1 }) });',
        'export const count = query({ args: {}, handler: async (ctx) => (await ctx.db.query("messages").collect()).length });',
        'export const secret = internalQuery({ args: {}, handler: async () => "internal" });',
        "export const env = query({ args: {}, handler: async () => ({ mode: process.env.MODE ?? null, key: process.env.KEY ?? null, appx: process.env.APPX ?? null, site: process.env.BUNVEX_SITE_URL ?? null }) });",
        "export const bump = mutation({ args: {}, handler: async () => ++calls });",
        'export const page = query({ args: {}, handler: async (ctx) => ctx.db.query("messages").paginate({ numItems: 1, cursor: null }) });',
        'export const schedule = mutation({ args: {}, handler: async (ctx) => { await ctx.scheduler.runAfter(0, "lib:bump", {}); } });',
        'export const viaAction = action({ args: {}, handler: async (ctx) => ctx.runQuery("lib:count", {}) });',
        'export const nested = mutation({ args: {}, handler: async (ctx) => { await ctx.runMutation("lib:add", { body: "nested" }); return ctx.runQuery("lib:count", {}); } });',
      ].join("\n"),
    ),
  ],
  udfServerVersion: "1.46.0",
};

/** A deployment on `dir`'s store: reopened on the same files, it is a restart. */
async function deployment(
  dir = mkdtempSync(join(tmpdir(), "bunvex-component-runtime-")),
  store = new MemoryBlobStore(),
) {
  if (!dirs.includes(dir)) dirs.push(dir);
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
    moduleStorage: store,
    redactLogsToClient: false,
  });
  await s.codeReady;
  const stop = async () => {
    s.server.stop(true);
    await engine.close();
  };
  stops.push(stop);
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
  const push = async (definition = appDefinition()) => {
    const start = await post("/api/deploy2/start_push", {
      adminKey: KEY,
      functions: "bunvex",
      nodeDependencies: [],
      appDefinition: {
        definition,
        dependencies: ["counter"],
        schema: null,
        changedModules: [
          mod(
            "app.js",
            `import { query } from "bunvex/server";\nexport const hi = query({ args: {}, handler: async () => "hi" });`,
          ),
        ],
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
    return start.body!.schemaChange.allocatedComponentIds as Record<string, string>;
  };
  /** `/api/function` of `path` in component `componentPath`, as `bunvex run --component` calls it. */
  const run = (componentPath: string, path: string, args: object = {}, auth?: string | null) =>
    post("/api/function", { componentPath, path, args, format: "json" }, auth);
  return { engine, s, post, push, run, stop, dir, store };
}

describe("a component's functions, run by an admin", () => {
  test("query, mutation and action in each instance's own namespace", async () => {
    const d = await deployment();
    await d.push();
    expect((await d.run("counter", "lib:add", { body: "a" })).body!.status).toBe("success");
    expect((await d.run("counter", "lib:count")).body).toEqual({ status: "success", value: 1 });
    expect((await d.run("second", "lib:count")).body).toEqual({ status: "success", value: 0 });
    // An action calls its own component's query by name; a mutation its own component's functions.
    expect((await d.run("counter", "lib:viaAction")).body).toEqual({ status: "success", value: 1 });
    expect((await d.run("second", "lib:nested")).body).toEqual({ status: "success", value: 1 });
    // An admin reaches internal functions; the app's own functions are not the component's.
    expect((await d.run("counter", "lib:secret")).body).toEqual({ status: "success", value: "internal" });
    expect((await d.run("", "app:hi")).body).toEqual({ status: "success", value: "hi" });
  });

  test("Convex's refusals: not an admin, an unknown path, a function the component lacks", async () => {
    const d = await deployment();
    await d.push();
    expect((await d.run("counter", "lib:count", {}, null)).status).toBe(403);
    expect(await d.run("nope", "lib:count")).toEqual({
      status: 400,
      body: { code: "ComponentPathNotFound", message: "Component path 'nope' not found" },
    });
    const missing = await d.run("counter", "lib:nope");
    expect(missing.body!.errorMessage).toContain(
      "Could not find function for 'lib:nope' in 'counter'. Did you forget to run `bunvex dev`?",
    );
  });

  test("its variables: its bindings and the built-ins, nothing else of the deployment's", async () => {
    const d = await deployment();
    await d.engine.mutation((db) => d.engine.environment.update(db, [{ name: "APPX", value: "secret-x" }]));
    await d.push();
    const counter = (await d.run("counter", "lib:env")).body!.value;
    expect(counter).toMatchObject({ mode: "fast", key: "secret-x", appx: null });
    const second = (await d.run("second", "lib:env")).body!.value;
    expect(second).toMatchObject({ mode: null, key: null, appx: null });
  });

  test("its schema on writes, and what a component may not do", async () => {
    const d = await deployment();
    await d.push();
    expect((await d.run("counter", "lib:bad")).body!.errorMessage).toContain(
      'Failed to insert or update a document in table "messages" because it does not match the schema',
    );
    expect((await d.run("counter", "lib:page")).body!.errorMessage).toContain(
      "paginate() is only supported in the app.",
    );
    expect((await d.run("counter", "lib:schedule")).body!.errorMessage).toContain(
      "`ctx.scheduler` in a component is not supported yet",
    );
  });

  test("each instance's module state is its own (C3)", async () => {
    const d = await deployment();
    await d.push();
    expect((await d.run("counter", "lib:bump")).body!.value).toBe(1);
    expect((await d.run("counter", "lib:bump")).body!.value).toBe(2);
    expect((await d.run("second", "lib:bump")).body!.value).toBe(1);
  });

  test("an unmounted instance's functions are not found; a restart loads the mounted ones", async () => {
    const d = await deployment();
    await d.push();
    await d.run("counter", "lib:add", { body: "kept" });
    await d.push(appDefinition(false));
    expect((await d.run("second", "lib:count")).body!.errorMessage).toContain(
      "Could not find function for 'lib:count' in 'second'.",
    );
    await d.stop();
    stops.pop();
    const again = await deployment(d.dir, d.store);
    expect((await again.run("counter", "lib:count")).body).toEqual({ status: "success", value: 1 });
  });
});

describe("the dashboard's reads and its custom query in a component (PR 3)", () => {
  const systemQuery = (d: Awaited<ReturnType<typeof deployment>>, path: string, args: object = {}) =>
    d.post("/api/query", { path, args, format: "json" });

  test("modules of every component, of one, a function's validator, and the components", async () => {
    const d = await deployment();
    const ids = await d.push();
    const all = (await systemQuery(d, "_system/frontend/modules:listForAllComponents")).body!.value as [
      string | null,
      [string, { functions: { name: string }[] }][],
    ][];
    // The app's first, then each component's, in `_components`' order.
    expect(all[0]![0]).toBeNull();
    expect(
      all
        .slice(1)
        .map(([id]) => id)
        .sort(),
    ).toEqual([ids.counter, ids.second].sort());
    const counterModules = all.find(([id]) => id === ids.counter)![1];
    expect(counterModules.find(([p]) => p === "lib.js")![1].functions.map((f) => f.name)).toContain("add");
    expect(all[0]![1].map(([p]) => p)).toContain("app.js");
    const one = (await systemQuery(d, "_system/frontend/modules:list", { componentId: ids.second })).body!.value as [
      string,
      unknown,
    ][];
    expect(one.map(([p]) => p)).toContain("lib.js");
    const validator = (
      await systemQuery(d, "_system/frontend/modules:argsValidator", { componentId: ids.counter, function: "lib:add" })
    ).body!.value as string;
    expect(JSON.parse(validator)).toMatchObject({ type: "object", value: { body: { fieldType: { type: "string" } } } });
    // The app's own: no `lib.js` there.
    expect(
      (await systemQuery(d, "_system/frontend/modules:argsValidator", { function: "lib:add" })).body!.value,
    ).toBeNull();
    const components = (await systemQuery(d, "_system/frontend/components:list")).body!.value as { path: string }[];
    expect(components.map((c) => c.path).sort()).toEqual(["", "counter", "second"]);
  });

  test("the custom query runs in the component given by id, with its data", async () => {
    const d = await deployment();
    const ids = await d.push();
    await d.run("counter", "lib:add", { body: "a" });
    const tester = (componentId?: string) =>
      d.post(
        "/api/run_test_function",
        {
          adminKey: KEY,
          args: {},
          bundle: {
            path: "testQuery.js",
            source:
              'import { query } from "bunvex:/_system/repl/wrappers.js";\nexport default query({ handler: async (ctx) => (await ctx.db.query("messages").collect()).length });',
          },
          format: "json",
          ...(componentId ? { componentId } : {}),
        },
        null,
      );
    expect((await tester(ids.counter)).body).toEqual({ status: "success", value: 1 });
    expect((await tester(ids.second)).body).toEqual({ status: "success", value: 0 });
    // The app has no `messages`: none read.
    expect((await tester()).body).toEqual({ status: "success", value: 0 });
    expect((await tester("nope")).status).toBe(500);
  });

  test("in a component, the custom query's import sees no deployment variable", async () => {
    const d = await deployment();
    await d.engine.mutation((db) => d.engine.environment.update(db, [{ name: "APPX", value: "x" }]));
    const ids = await d.push();
    const atImport = (componentId?: string) =>
      d.post(
        "/api/run_test_function",
        {
          adminKey: KEY,
          args: {},
          bundle: {
            path: "testQuery.js",
            source:
              'import { query } from "bunvex:/_system/repl/wrappers.js";\nconst seen = process.env.APPX ?? null;\nexport default query({ handler: async () => seen });',
          },
          format: "json",
          ...(componentId ? { componentId } : {}),
        },
        null,
      );
    expect((await atImport()).body).toEqual({ status: "success", value: "x" });
    expect((await atImport(ids.counter)).body).toEqual({ status: "success", value: null });
  });
});

describe("logs", () => {
  test("a component's run is logged by its own name, with its component's path", async () => {
    const d = await deployment();
    await d.push();
    await d.run("counter", "lib:count");
    const r = await fetch(`http://127.0.0.1:${d.s.server.port}/api/stream_function_logs?cursor=0`, {
      headers: { authorization: `Bunvex ${KEY}` },
    });
    const entries = (
      (await r.json()) as { entries: { kind: string; identifier: string; componentPath: string | null }[] }
    ).entries;
    const run = entries.find((e) => e.kind === "Completion" && e.identifier === "lib:count");
    expect(run?.componentPath).toBe("counter");
  });
});

describe("over the websocket", () => {
  test("an admin subscribes to a component's query; its mutation re-runs it", async () => {
    const d = await deployment();
    await d.push();
    const c = await v1Client(syncUrl(d.s.server.port));
    stops.push(() => c.ws.close());
    c.send({ type: "Authenticate", baseVersion: 0, tokenType: "Admin", value: KEY });
    c.modify([{ type: "Add", queryId: 1, udfPath: "lib:count", args: [{}], componentPath: "counter" }]);
    await c.until(() =>
      c
        .transitions()
        .some((t) => t.modifications.some((m) => m.type === "QueryUpdated" && (m as { value: unknown }).value === 0)),
    );
    c.send({ type: "Mutation", requestId: 0, udfPath: "lib:add", args: [{ body: "x" }], componentPath: "counter" });
    await c.until(() =>
      c
        .transitions()
        .some((t) => t.modifications.some((m) => m.type === "QueryUpdated" && (m as { value: unknown }).value === 1)),
    );
  });
});

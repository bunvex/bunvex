// A push with components over HTTP (STUDY-153 PR 3c): start_push and evaluate_push with Convex's request shape
// (`appDefinition.definition`, `componentDefinitions`), answered as Convex answers them (the analysis per definition,
// the checked tree, the schema change per component), wait_for_schema over every component, and the refusals of
// STUDY-153 §1.10 as a push answers them. finish_push of a push with components comes in PR 4.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { componentRow, defineSchema, defineTable, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { checkPackagesSize, ModulesTooLargeError } from "../src/code-store.ts";
import type { ModuleSource } from "../src/code-version.ts";
import { Functions } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const SECRET = "cd".repeat(32);
const NAME = "push-components-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const mod = (path: string, source: string, environment: "isolate" | "node" = "isolate"): ModuleSource => ({
  path,
  source,
  environment,
});
const dep = (path: string) => `./_componentDeps/${Buffer.from(path).toString("base64url")}`;

/** The app mounting `counter` twice, as the CLI bundles it (`bunvex/server` external, DV-495). */
const APP_DEFINITION = mod(
  "bunvex.config.js",
  `import { defineApp } from "bunvex/server";\nimport counter from "${dep("counter")}";\nconst app = defineApp();\napp.use(counter);\napp.use(counter, { name: "second" });\nexport default app;`,
);
const COUNTER = {
  definitionPath: "counter",
  definition: mod(
    "bunvex.config.js",
    `import { defineComponent } from "bunvex/server";\nexport default defineComponent("counter");`,
  ),
  dependencies: [] as string[],
  schema: mod(
    "schema.js",
    `import { defineSchema, defineTable } from "bunvex/server";\nimport { v } from "bunvex/values";\nexport default defineSchema({ messages: defineTable({ body: v.string() }).index("by_body", ["body"]) });`,
  ),
  functions: [
    mod(
      "lib.js",
      `import { internalMutation, mutation } from "bunvex/server";\nexport const add = mutation({ args: {}, handler: async () => 1 });\nexport const secret = internalMutation({ args: {}, handler: async () => 2 });`,
    ),
  ],
  udfServerVersion: "1.46.0",
};

async function deployment() {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-push-components-"));
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
  stops.push(
    () => engine.close(),
    () => s.server.stop(true),
  );
  const api = `http://127.0.0.1:${s.server.port}`;
  const post = async (path: string, body: object) => {
    const r = await fetch(`${api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminKey: KEY, functions: "bunvex", nodeDependencies: [], ...body }),
    });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  /** A start (or `evaluate_push`) of the app's modules with these components. */
  const start = (
    o: { definition?: ModuleSource | null; dependencies?: string[]; components?: object[]; app?: ModuleSource[] } = {},
    step = "start_push",
  ) =>
    post(`/api/deploy2/${step}`, {
      appDefinition: {
        definition: o.definition === undefined ? APP_DEFINITION : o.definition,
        dependencies: o.dependencies ?? ["counter"],
        schema: null,
        changedModules: o.app ?? [
          mod(
            "app.js",
            `import { query } from "bunvex/server";\nexport const hello = query({ args: {}, handler: async () => "hi" });`,
          ),
        ],
        unchangedModuleHashes: [],
        udfServerVersion: "1.46.0",
      },
      componentDefinitions: o.components ?? [COUNTER],
    });
  return { engine, post, start };
}

describe("start_push with components", () => {
  test("the app mounting `counter` twice: Convex's answer, each instance's namespace and pending schema", async () => {
    const d = await deployment();
    const r = await d.start();
    expect(r.status).toBe(200);
    const { analysis, app, schemaChange } = r.body;
    // One analysis per definition: the app's (its exports left empty) and `counter`'s, its public functions exported.
    expect(Object.keys(analysis)).toEqual(["", "counter"]);
    expect(analysis[""].definition.childComponents).toEqual([
      { type: "SerializedComponentInstantiation", name: "counter", path: "counter", args: [], env: [] },
      { type: "SerializedComponentInstantiation", name: "second", path: "counter", args: [], env: [] },
    ]);
    expect(analysis[""].definition.exports).toEqual({ type: "branch", branch: [] });
    expect(analysis.counter.definition.exports).toEqual({
      type: "branch",
      branch: [
        ["lib", { type: "branch", branch: [["add", { type: "leaf", leaf: "_reference/function/lib.js:add" }]] }],
      ],
    });
    expect(analysis.counter.schema.tables.map((t: { tableName: string }) => t.tableName)).toEqual(["messages"]);
    expect(Object.keys(analysis.counter.functions)).toEqual(["lib.js"]);
    // The checked tree, each instance's exports its own functions.
    expect(Object.keys(app.childComponents)).toEqual(["counter", "second"]);
    expect(app.childComponents.second.exports.lib.children.add).toEqual({
      type: "leaf",
      resource: { type: "function", path: { component: "second", udfPath: "lib.js:add" } },
    });
    // Ids allocated for the app (its first push) and both instances; a pending schema in each namespace.
    expect(Object.keys(schemaChange.allocatedComponentIds)).toEqual(["", "counter", "second"]);
    expect(Object.keys(schemaChange.schemaIds)).toEqual(["", "counter", "second"]);
    expect(Object.keys(schemaChange.indexDiffs)).toEqual(["", "counter", "second"]);
    expect(JSON.stringify(schemaChange.indexDiffs.counter.added_indexes)).toContain("by_body");
    expect(schemaChange.indexDiffs[""].added_indexes).toEqual([]);
    for (const name of ["counter", "second"]) {
      const ns = d.engine.catalog.components.get(schemaChange.allocatedComponentIds[name]);
      expect(ns?.table("messages")).toBeDefined();
    }
    // Both instances' schemas become ready: wait_for_schema reads each in its namespace.
    const wait = await d.post("/api/deploy2/wait_for_schema", { schemaChange, timeoutMs: 5000 });
    expect(wait.body).toEqual({ type: "complete" });
  });

  test("finish_push of a push with components is refused until PR 4; its namespaces stay allocated (C-10)", async () => {
    const d = await deployment();
    const r = await d.start();
    await d.post("/api/deploy2/wait_for_schema", { schemaChange: r.body.schemaChange, timeoutMs: 5000 });
    const f = await d.post("/api/deploy2/finish_push", { startPush: r.body, dryRun: false });
    expect(f).toEqual({
      status: 400,
      body: {
        code: "ComponentsNotSupported",
        message: "Hit an error while pushing:\nComponents are not supported by this deployment yet",
      },
    });
    expect(d.engine.catalog.components.has(r.body.schemaChange.allocatedComponentIds.counter)).toBe(true);
  });

  test("an app definition with no children: the push finishes as before", async () => {
    const d = await deployment();
    const definition = mod(
      "bunvex.config.js",
      `import { defineApp } from "bunvex/server";\nexport default defineApp();`,
    );
    const r = await d.start({ definition, dependencies: [], components: [] });
    expect(r.status).toBe(200);
    expect(r.body.app.childComponents).toEqual({});
    expect(r.body.app.exports).toEqual({
      app: {
        type: "branch",
        children: {
          hello: { type: "leaf", resource: { type: "function", path: { component: "", udfPath: "app.js:hello" } } },
        },
      },
    });
    await d.post("/api/deploy2/wait_for_schema", { schemaChange: r.body.schemaChange, timeoutMs: 5000 });
    const f = await d.post("/api/deploy2/finish_push", { startPush: r.body, dryRun: false });
    expect(f.status).toBe(200);
  });

  test("no definition sent: Convex's default app, no allocation for a child", async () => {
    const d = await deployment();
    const r = await d.start({ definition: null, dependencies: [], components: [] });
    expect(r.body.analysis[""].definition).toMatchObject({
      path: "",
      definitionType: { type: "app" },
      childComponents: [],
    });
    expect(Object.keys(r.body.schemaChange.allocatedComponentIds)).toEqual([""]);
  });

  test("a dry run allocates nothing and starts no schema (DV-444); each component's index diff against nothing", async () => {
    const d = await deployment();
    const r = await d.start({}, "evaluate_push");
    expect(r.status).toBe(200);
    expect(r.body.schemaChange.allocatedComponentIds).toEqual({});
    expect(r.body.schemaChange.schemaIds).toEqual({});
    expect(r.body.schemaChange.indexDiffs.counter.added_indexes).toHaveLength(1);
    expect(d.engine.catalog.components.size).toBe(0);
  });

  test("wait_for_schema: a component's failed schema names its path", async () => {
    const d = await deployment();
    const r = await d.start();
    const { schemaChange } = r.body;
    await d.post("/api/deploy2/wait_for_schema", { schemaChange, timeoutMs: 5000 });
    const ns = schemaChange.allocatedComponentIds.counter as string;
    await d.engine.mutation((db) => db.inComponent(ns, () => db.insert("messages", { body: 7 } as never)));
    // `counter`'s schema again, `body` a string: its document fails the walk.
    const next = await d.engine.startSchemaPush(
      defineSchema({}),
      new Map([
        [
          ns,
          defineSchema({
            messages: defineTable({ body: v.string(), n: v.optional(v.number()) }).index("by_body", ["body"]),
          }),
        ],
      ]),
    );
    const wait = await d.post("/api/deploy2/wait_for_schema", {
      schemaChange: {
        schemaIds: { "": next.schemaId, counter: next.components.get(ns)!.schemaId },
        allocatedComponentIds: { counter: ns },
      },
      timeoutMs: 5000,
    });
    expect(wait.body).toMatchObject({ type: "failed", componentPath: "counter", tableName: "messages" });
  });
});

describe("wait_for_schema and a concurrent push", () => {
  test("a component another push created under another id: 409 RaceDetected (d8bdde0)", async () => {
    const d = await deployment();
    const { schemaChange } = (await d.start()).body;
    // Another push created `counter` meanwhile, under another id.
    await d.engine.mutation((db) =>
      db.asSystem(async () => {
        const definitionId = await db.insert("_component_definitions", { path: "" } as never);
        const root = await db.insert(
          "_components",
          componentRow({ definitionId, parent: null, name: null, state: "active", httpPrefix: null }) as never,
        );
        await db.insert(
          "_components",
          componentRow({
            definitionId,
            parent: root,
            name: "counter",
            args: [],
            env: [],
            state: "active",
            httpPrefix: null,
          }) as never,
        );
      }),
    );
    const wait = await d.post("/api/deploy2/wait_for_schema", { schemaChange, timeoutMs: 5000 });
    expect(wait).toEqual({
      status: 409,
      body: { code: "RaceDetected", message: "Component counter was created by a concurrent push" },
    });
  });
});

describe("refused, as Convex's push refuses them", () => {
  const refused = async (o: Parameters<Awaited<ReturnType<typeof deployment>>["start"]>[0]) => {
    const d = await deployment();
    const r = await d.start(o);
    return { status: r.status, code: r.body.code as string, message: r.body.message as string };
  };

  test('the request: a Node module in a component, an absolute path: InvalidConfig, not "while pushing"', async () => {
    expect(await refused({ components: [{ ...COUNTER, functions: [mod("lib.js", "export {}", "node")] }] })).toEqual({
      status: 400,
      code: "InvalidConfig",
      message: 'Node actions are not supported in components. Remove `"use node;" from lib.js',
    });
    expect(await refused({ dependencies: ["/abs"] })).toEqual({
      status: 400,
      code: "InvalidConfig",
      message: "Component paths must be relative (/abs is absolute).",
    });
  });

  test("a definition's evaluation and the tree's check: their codes, \"while pushing\"", async () => {
    expect(await refused({ components: [{ ...COUNTER, dependencies: ["counter"] }] })).toEqual({
      status: 400,
      code: "CyclicImport",
      message: "Hit an error while pushing:\nFound cyclic definition dependency",
    });
    const twice = mod(
      "bunvex.config.js",
      `import { defineApp } from "bunvex/server";\nimport counter from "${dep("counter")}";\nconst app = defineApp();\napp.use(counter);\napp.use(counter);\nexport default app;`,
    );
    expect(await refused({ definition: twice })).toEqual({
      status: 400,
      code: "TypecheckError",
      message:
        'Hit an error while pushing:\nComponent ComponentDefinitionPath { path: "" } has multiple child components with the same name: ComponentName(Identifier("counter"))',
    });
  });

  test("a component's schema or module that does not load", async () => {
    const badSchema = await refused({
      components: [{ ...COUNTER, schema: mod("schema.js", `throw new Error("bad schema");`) }],
    });
    expect(badSchema.code).toBe("InvalidSchema");
    expect(badSchema.message).toStartWith("Hit an error while pushing:\nUncaught Error: bad schema");
    const badModule = await refused({
      components: [{ ...COUNTER, functions: [mod("lib.js", `throw new Error("boom");`)] }],
    });
    expect(badModule.code).toBe("InvalidModules");
  });

  test("a component's staged validator or search index: not yet (ComponentsNotSupported), nothing allocated", async () => {
    const d = await deployment();
    const search = mod(
      "schema.js",
      `import { defineSchema, defineTable } from "bunvex/server";\nimport { v } from "bunvex/values";\nexport default defineSchema({ messages: defineTable({ body: v.string() }).searchIndex("s", { searchField: "body" }) });`,
    );
    const r = await d.start({ components: [{ ...COUNTER, schema: search }] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("ComponentsNotSupported");
    expect(d.engine.catalog.components.size).toBe(0);
  });
});

describe("the packages' size (Convex's upload_packages)", () => {
  test("one check over the total: two packages that fit alone, too large together", () => {
    const big = [mod("a.js", "x".repeat(600))];
    const limits = { zipped: 1_000_000, unzipped: 1000 };
    checkPackagesSize([big], null, limits);
    expect(() => checkPackagesSize([big, big], null, limits)).toThrow(ModulesTooLargeError);
  });
});

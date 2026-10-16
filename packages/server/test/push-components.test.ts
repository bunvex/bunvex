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
import { checkPackagesSize, loadLatestCode, ModulesTooLargeError } from "../src/code-store.ts";
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
  const store = new MemoryBlobStore();
  const s = createServer({
    engine,
    functions: new Functions(engine),
    port: 0,
    deployable: true,
    moduleStorage: store,
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
  /** A dashboard route, with the admin key in the header. */
  const admin = async (path: string, body: object) => {
    const r = await fetch(`${api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bunvex ${KEY}` },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: text ? (JSON.parse(text) as Record<string, any>) : null };
  };
  return { engine, post, start, store, admin };
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

describe("evaluate_schema with components (PR 3d)", () => {
  /** `counter` mounted as a push's finish will write it (PR 4): the rows, in the namespace its start allocated. */
  async function mounted(
    d: Awaited<ReturnType<typeof deployment>>,
    ns: string,
    state: "active" | "unmounted" = "active",
    definition = "counter",
  ) {
    await d.engine.mutation((db) =>
      db.asSystem(async () => {
        const app = await db.insert("_component_definitions", { path: "" } as never);
        const def = await db.insert("_component_definitions", { path: definition } as never);
        const root = await db.insert(
          "_components",
          componentRow({ definitionId: app, parent: null, name: null, state: "active", httpPrefix: null }) as never,
        );
        await db.importInsert(d.engine.catalog.table("_components"), {
          _id: ns,
          ...componentRow({
            definitionId: def,
            parent: root,
            name: "counter",
            args: [],
            env: [],
            state,
            httpPrefix: null,
          }),
        });
      }),
    );
  }
  const evaluate = (d: Awaited<ReturnType<typeof deployment>>, components: object[]) =>
    d.post("/api/deploy2/evaluate_schema", {
      appDefinition: {
        definition: APP_DEFINITION,
        dependencies: ["counter"],
        schema: null,
        changedModules: [],
        unchangedModuleHashes: [],
        udfServerVersion: "1.46.0",
      },
      componentDefinitions: components,
    });
  const withIndex = {
    ...COUNTER,
    schema: mod(
      "schema.js",
      `import { defineSchema, defineTable } from "bunvex/server";\nimport { v } from "bunvex/values";\nexport default defineSchema({ messages: defineTable({ body: v.string(), n: v.optional(v.number()) }).index("by_body", ["body"]).index("by_both", ["body", "n"]) });`,
    ),
  };

  test("no instance yet: the app's prediction, and `counter` a new definition", async () => {
    const d = await deployment();
    await d.engine.summariesReady();
    const r = await evaluate(d, [COUNTER]);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.componentSchemaEvaluations)).toEqual([""]);
    expect(r.body.newComponentDefinitions).toEqual(["counter"]);
  });

  test("an existing instance: predicted in its namespace, its documents counted", async () => {
    const d = await deployment();
    const { schemaChange } = (await d.start()).body;
    await d.post("/api/deploy2/wait_for_schema", { schemaChange, timeoutMs: 5000 });
    const ns = schemaChange.allocatedComponentIds.counter as string;
    await mounted(d, ns);
    await d.engine.mutation((db) =>
      db.inComponent(ns, async () => {
        await db.insert("messages", { body: "a" });
        await db.insert("messages", { body: "b" });
      }),
    );
    await d.engine.summariesReady();
    const r = await evaluate(d, [withIndex]);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.componentSchemaEvaluations)).toEqual(["", "counter"]);
    const counter = r.body.componentSchemaEvaluations.counter;
    expect(counter.definitionPath).toBe("counter");
    expect(counter.tables).toEqual([expect.objectContaining({ name: "messages", numDocs: 2 })]);
    expect(counter.indexes.find((i: { name: string }) => i.name === "messages.by_both")).toMatchObject({
      change: "added",
      needsBackfill: true,
      numDocs: 2,
    });
    expect(r.body.newComponentDefinitions).toEqual([]);
    // The app's prediction does not see `counter`'s table.
    expect(r.body.componentSchemaEvaluations[""].indexes).toEqual([]);
  });

  test("the outcome against the component's own active schema", async () => {
    const d = await deployment();
    const { schemaChange } = (await d.start()).body;
    await d.post("/api/deploy2/wait_for_schema", { schemaChange, timeoutMs: 5000 });
    const ns = schemaChange.allocatedComponentIds.counter as string;
    await mounted(d, ns);
    // `counter`'s schema made active, as PR 4's finish will.
    await d.engine.commitSchemaPush(
      schemaChange.schemaIds[""],
      async () => {},
      new Map([[ns, schemaChange.schemaIds.counter]]),
    );
    await d.engine.mutation((db) => db.inComponent(ns, () => db.insert("messages", { body: "a" })));
    await d.engine.summariesReady();
    const same = await evaluate(d, [COUNTER]);
    expect(same.body.componentSchemaEvaluations.counter.tables[0].outcome).toBe("supersetOfEnforced");
  });

  test("an instance whose definition is not pushed: nothing predicted; one pushed without a schema: its indexes dropped", async () => {
    const d = await deployment();
    const { schemaChange } = (await d.start()).body;
    await d.post("/api/deploy2/wait_for_schema", { schemaChange, timeoutMs: 5000 });
    const ns = schemaChange.allocatedComponentIds.counter as string;
    await mounted(d, ns);
    await d.engine.summariesReady();
    const absent = await evaluate(d, []);
    expect(absent.body.componentSchemaEvaluations.counter).toEqual({
      definitionPath: "counter",
      schemaValidation: false,
      tables: [],
      indexes: [],
      discardedStagedValidators: [],
    });
    const noSchema = await evaluate(d, [{ ...COUNTER, schema: null }]);
    const c = noSchema.body.componentSchemaEvaluations.counter;
    expect(c.tables).toEqual([]);
    expect(c.indexes.map((i: { change: string }) => i.change)).toEqual(["dropped"]);
  });

  test("an unmounted instance whose definition is gone is skipped", async () => {
    const d = await deployment();
    const { schemaChange } = (await d.start()).body;
    const ns = schemaChange.allocatedComponentIds.counter as string;
    await mounted(d, ns, "unmounted", "gone");
    await d.engine.mutation((db) =>
      db.asSystem(async () => {
        const gone = await db
          .query("_component_definitions")
          .filter((q) => q.eq(q.field("path"), "gone"))
          .first();
        await db.delete("_component_definitions", gone!._id);
      }),
    );
    await d.engine.summariesReady();
    const r = await evaluate(d, [COUNTER]);
    expect(Object.keys(r.body.componentSchemaEvaluations)).toEqual([""]);
  });
});

describe("finish_push with components (PR 4)", () => {
  /** A start, its wait and its finish, as the CLI does. */
  async function push(d: Awaited<ReturnType<typeof deployment>>, o: Parameters<typeof d.start>[0] = {}) {
    const start = await d.start(o);
    if (start.status !== 200) return { start, finish: start };
    await d.post("/api/deploy2/wait_for_schema", { schemaChange: start.body.schemaChange, timeoutMs: 5000 });
    return { start, finish: await d.post("/api/deploy2/finish_push", { startPush: start.body, dryRun: false }) };
  }
  const rowsIn = (d: Awaited<ReturnType<typeof deployment>>, ns: string | null, table: string) =>
    d.engine.query((db) => db.asSystem(() => db.inComponent(ns, () => db.query(table).collect()))) as Promise<
      Record<string, any>[]
    >;
  const onlyCounter = mod(
    "bunvex.config.js",
    `import { defineApp } from "bunvex/server";\nimport counter from "${dep("counter")}";\nconst app = defineApp();\napp.use(counter);\nexport default app;`,
  );

  test("create: `counter` and `second`, Convex's answer and rows", async () => {
    const d = await deployment();
    const { start, finish } = await push(d);
    expect(finish.status).toBe(200);
    const ids = start.body.schemaChange.allocatedComponentIds;
    expect(finish.body.definitionDiffs).toEqual({ "": {}, counter: {} });
    expect(Object.keys(finish.body.componentDiffs)).toEqual(["", "counter", "second"]);
    for (const k of ["", "counter", "second"])
      expect(finish.body.componentDiffs[k].diffType).toEqual({ type: "create" });
    const counter = finish.body.componentDiffs.counter;
    expect(counter.moduleDiff).toEqual({ added: ["bunvex.config.js", "lib.js", "schema.js"], removed: [] });
    expect(counter.udfConfigDiff).toEqual({ previous_version: "Unspecified version", next_version: "1.46.0" });
    expect(counter.schemaDiff.previous_schema).toBeNull();
    expect(JSON.parse(counter.schemaDiff.next_schema).tables[0].tableName).toBe("messages");
    expect(finish.body.componentDiffs[""].moduleDiff.added).toContain("bunvex.config.js");
    // The rows: the definitions, the instances with their allocated ids, each namespace's code.
    const definitions = await rowsIn(d, null, "_component_definitions");
    expect(definitions.map((r) => r.path).sort()).toEqual(["", "counter"]);
    expect(definitions.find((r) => r.path === "")!.childComponents[0]).toEqual({
      type: "SerializedComponentInstantiation",
      name: "counter",
      path: "counter",
      args: [],
      env: [],
    });
    const components = await rowsIn(d, null, "_components");
    expect(components.map((r) => r._id).sort()).toEqual([ids[""], ids.counter, ids.second].sort());
    expect(components.find((r) => r._id === ids.second)).toMatchObject({
      name: "second",
      parent: ids[""],
      state: "active",
    });
    const modules = await rowsIn(d, ids.counter, "_modules");
    expect(modules.map((r) => r.path).sort()).toEqual(["bunvex.config.js", "lib.js", "schema.js"]);
    // Two instances of one definition share one package.
    const [p1] = await rowsIn(d, ids.counter, "_source_packages");
    const [p2] = await rowsIn(d, ids.second, "_source_packages");
    expect(p1!._id).not.toBe(p2!._id);
    expect(p1!.storageKey).toBe(p2!.storageKey);
    // Every namespace's `_udf_config` has the app's import seed.
    const [rootConfig] = await rowsIn(d, null, "_udf_config");
    const [counterConfig] = await rowsIn(d, ids.counter, "_udf_config");
    expect(new Uint8Array(counterConfig!.importPhaseRngSeed)).toEqual(new Uint8Array(rootConfig!.importPhaseRngSeed));
    // Each instance's schema is active in its namespace.
    expect(d.engine.componentSchema(ids.counter).tables).toHaveProperty("messages");
    // The audit event: the app's diff first, then by path.
    const [event] = (await rowsIn(d, null, "_deployment_audit_log")).filter(
      (r) => r.action === "push_config_with_components",
    );
    expect(event!.metadata.component_diffs.map((c: { component_path: string | null }) => c.component_path)).toEqual([
      null,
      "counter",
      "second",
    ]);
  });

  test("remove `second`: unmounted, its code gone, its data and package kept; added back: remounted", async () => {
    const d = await deployment();
    const { start } = await push(d);
    const ids = start.body.schemaChange.allocatedComponentIds;
    const removed = await push(d, { definition: onlyCounter });
    expect(removed.finish.status).toBe(200);
    expect(removed.start.body.schemaChange.schemaIds).not.toHaveProperty("second");
    const second = removed.finish.body.componentDiffs.second;
    expect(second).toMatchObject({
      diffType: { type: "unmount" },
      moduleDiff: { added: [], removed: ["bunvex.config.js", "lib.js", "schema.js"] },
      udfConfigDiff: null,
      schemaDiff: null,
    });
    expect((await rowsIn(d, null, "_components")).find((r) => r._id === ids.second)!.state).toBe("unmounted");
    expect(await rowsIn(d, ids.second, "_modules")).toEqual([]);
    expect(await rowsIn(d, ids.second, "_source_packages")).toHaveLength(1);
    expect(await rowsIn(d, ids.second, "_udf_config")).toHaveLength(1);
    // Removing it again: no diff for it.
    const again = await push(d, { definition: onlyCounter });
    expect(again.finish.body.componentDiffs).not.toHaveProperty("second");
    // Back: remounted, its code there again, its server version unchanged.
    const back = await push(d);
    expect(back.finish.body.componentDiffs.second).toMatchObject({
      diffType: { type: "remount" },
      udfConfigDiff: null,
    });
    expect((await rowsIn(d, ids.second, "_modules")).length).toBe(3);
  });

  test("every child and its definition removed: unmounted, the definition's row deleted", async () => {
    const d = await deployment();
    await push(d);
    const none = mod("bunvex.config.js", `import { defineApp } from "bunvex/server";\nexport default defineApp();`);
    const r = await push(d, { definition: none, dependencies: [], components: [] });
    expect(r.finish.status).toBe(200);
    expect(r.finish.body.definitionDiffs).toEqual({ "": {}, counter: {} });
    expect(r.finish.body.componentDiffs.counter.diffType).toEqual({ type: "unmount" });
    expect((await rowsIn(d, null, "_component_definitions")).map((x) => x.path)).toEqual([""]);
  });

  test("the app's code loads back with its definition module beside it (C-2), and shared blobs are kept", async () => {
    const d = await deployment();
    const first = await push(d);
    const ids = first.start.body.schemaChange.allocatedComponentIds;
    // The app's package holds `bunvex.config.js`, which imports `_componentDeps/…`: not loaded as functions.
    const loaded = await loadLatestCode(d.engine, d.store);
    expect(loaded?.version.functions.has("app:hello")).toBe(true);
    // `second` unmounted keeps its package row, which shares `counter`'s first blob.
    const [shared] = await rowsIn(d, ids.second, "_source_packages");
    await push(d, { definition: onlyCounter });
    expect(await d.store.get(shared!.storageKey).catch(() => null)).not.toBeNull();
    // `counter`'s next package replaced its row, but `second`'s still names the blob.
    const [counterNow] = await rowsIn(d, ids.counter, "_source_packages");
    expect(counterNow!.storageKey).not.toBe(shared!.storageKey);
  });

  test("the app's declared variables: one unset, one failing its validator", async () => {
    const d = await deployment();
    const withEnv = mod(
      "bunvex.config.js",
      `import { defineApp } from "bunvex/server";\nimport { v } from "bunvex/values";\nexport default defineApp({ env: { APPX: v.literal("a") } });`,
    );
    const unset = await push(d, { definition: withEnv, dependencies: [], components: [] });
    expect(unset.finish).toEqual({
      status: 400,
      body: {
        code: "MissingEnvironmentVariables",
        message:
          "Hit an error while pushing:\nRequired environment variables are not set: APPX. Set them in the dashboard or CLI before pushing.",
      },
    });
    await d.engine.mutation((db) => d.engine.environment.update(db, [{ name: "APPX", value: "b" }]));
    const invalid = await push(d, { definition: withEnv, dependencies: [], components: [] });
    expect(invalid.finish.body.code).toBe("InvalidEnvironmentVariable");
    expect(invalid.finish.body.message).toStartWith(
      "Hit an error while pushing:\nEnvironment variable APPX does not match its declared validator: ",
    );
  });

  test("a component another push created under another id: 409 RaceDetected at the finish too", async () => {
    const d = await deployment();
    const start = await d.start();
    await d.post("/api/deploy2/wait_for_schema", { schemaChange: start.body.schemaChange, timeoutMs: 5000 });
    // Another push finished `counter` meanwhile, under another id.
    await d.engine.mutation((db) =>
      db.asSystem(async () => {
        const definitionId = await db.insert("_component_definitions", { path: "x" } as never);
        await db.importInsert(d.engine.catalog.table("_components")!, {
          _id: start.body.schemaChange.allocatedComponentIds[""],
          ...componentRow({ definitionId, parent: null, name: null, state: "active", httpPrefix: null }),
        });
        await db.insert(
          "_components",
          componentRow({
            definitionId,
            parent: start.body.schemaChange.allocatedComponentIds[""],
            name: "counter",
            args: [],
            env: [],
            state: "active",
            httpPrefix: null,
          }) as never,
        );
      }),
    );
    const f = await d.post("/api/deploy2/finish_push", { startPush: start.body, dryRun: false });
    expect(f).toEqual({
      status: 409,
      body: { code: "RaceDetected", message: "Component counter was created by a concurrent push" },
    });
  });
});

describe("delete_component (PR 4b)", () => {
  async function pushed(d: Awaited<ReturnType<typeof deployment>>, o: Parameters<typeof d.start>[0] = {}) {
    const start = await d.start(o);
    await d.post("/api/deploy2/wait_for_schema", { schemaChange: start.body.schemaChange, timeoutMs: 5000 });
    await d.post("/api/deploy2/finish_push", { startPush: start.body, dryRun: false });
    return start.body.schemaChange.allocatedComponentIds as Record<string, string>;
  }
  const onlyCounter = mod(
    "bunvex.config.js",
    `import { defineApp } from "bunvex/server";\nimport counter from "${dep("counter")}";\nconst app = defineApp();\napp.use(counter);\nexport default app;`,
  );

  test("a mounted component is refused; an unmounted one goes, rows and tables, with its audit event", async () => {
    const d = await deployment();
    const ids = await pushed(d);
    expect(await d.admin("/api/delete_component", { componentId: ids.second })).toEqual({
      status: 400,
      body: { code: "ComponentMustBeUnmounted", message: "Component must be unmounted before deletion" },
    });
    await d.engine.mutation((db) => db.inComponent(ids.second!, () => db.insert("messages", { body: "x" })));
    await pushed(d, { definition: onlyCounter });
    expect(await d.admin("/api/delete_component", { componentId: ids.second })).toEqual({ status: 200, body: null });
    const components = await d.engine.query((db) => db.asSystem(() => db.query("_components").collect()));
    expect(components.map((c) => c._id)).not.toContain(ids.second);
    expect(d.engine.catalog.components.has(ids.second!)).toBe(false);
    // Its tables (its `messages` and its system tables) are deleted in the background.
    for (let i = 0; i < 200 && d.engine.catalog.deleting.size; i++) await Bun.sleep(10);
    const tables = await d.engine.query((db) => db.asSystem(() => db.query("_tables").collect()));
    expect(tables.filter((t) => t.namespace === ids.second)).toEqual([]);
    expect(d.engine.catalog.components.has(ids.counter!)).toBe(true);
    const events = await d.engine.query((db) => db.asSystem(() => db.query("_deployment_audit_log").collect()));
    expect(events.find((e) => e.action === "delete_component")?.metadata).toEqual({
      component_id: ids.second,
      component: "second",
    });
  });

  test("a component with one under it: both go", async () => {
    const d = await deployment();
    const app = mod(
      "bunvex.config.js",
      `import { defineApp } from "bunvex/server";\nimport outer from "${dep("outer")}";\nconst app = defineApp();\napp.use(outer);\nexport default app;`,
    );
    const outer = {
      ...COUNTER,
      definitionPath: "outer",
      dependencies: ["inner"],
      definition: mod(
        "bunvex.config.js",
        `import { defineComponent } from "bunvex/server";\nimport inner from "${dep("inner")}";\nconst c = defineComponent("outer");\nc.use(inner);\nexport default c;`,
      ),
    };
    const inner = {
      ...COUNTER,
      definitionPath: "inner",
      definition: mod(
        "bunvex.config.js",
        `import { defineComponent } from "bunvex/server";\nexport default defineComponent("inner");`,
      ),
    };
    const ids = await pushed(d, { definition: app, dependencies: ["outer"], components: [outer, inner] });
    expect(Object.keys(ids)).toEqual(["", "outer", "outer/inner"]);
    const none = mod("bunvex.config.js", `import { defineApp } from "bunvex/server";\nexport default defineApp();`);
    await pushed(d, { definition: none, dependencies: [], components: [] });
    expect((await d.admin("/api/delete_component", { componentId: ids.outer })).status).toBe(200);
    const left = await d.engine.query((db) => db.asSystem(() => db.query("_components").collect()));
    expect(left.map((c) => c._id)).toEqual([ids[""]]);
    expect(d.engine.catalog.components.has(ids["outer/inner"]!)).toBe(false);
  });

  test("the app, or an id that names no component: Convex's system errors", async () => {
    const d = await deployment();
    const ids = await pushed(d);
    expect((await d.admin("/api/delete_component", {})).status).toBe(500);
    expect((await d.admin("/api/delete_component", { componentId: ids[""] })).status).toBe(500);
    await pushed(d, { definition: onlyCounter });
    await d.admin("/api/delete_component", { componentId: ids.second });
    expect((await d.admin("/api/delete_component", { componentId: ids.second })).status).toBe(500);
  });
});

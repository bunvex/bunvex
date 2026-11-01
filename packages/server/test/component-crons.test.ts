// Crons in components (STUDY-157 PR 2): a component's `crons.js` runs its own functions, a mutation's and an
// action's, its next runs and logs in its namespace, beside the app's crons; an unmount stops them and a remount
// starts them again.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
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
const NAME = "component-crons-test";
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
  'import { defineApp } from "@bunvex/server";',
  `import counter from "${dep("counter")}";`,
  "const app = defineApp();",
  "app.use(counter);",
  "export default app;",
]);
const NO_COMPONENTS = mod("bunvex.config.js", [
  'import { defineApp } from "@bunvex/server";',
  "export default defineApp();",
]);
const SCHEMA = mod("schema.js", [
  'import { defineSchema, defineTable } from "@bunvex/server";',
  'import { v } from "@bunvex/values";',
  "export default defineSchema({ messages: defineTable({ body: v.string() }) });",
]);
const APP = mod("app.js", [
  'import { componentsGeneric, mutation, query } from "@bunvex/server";',
  "const c = componentsGeneric().counter.lib;",
  "export const tick = mutation({ args: {}, handler: async (ctx) => { await ctx.db.insert('messages', { body: 'app' }); } });",
  "export const messages = query({ args: {}, handler: async (ctx) => (await ctx.db.query('messages').collect()).map((m) => m.body) });",
  "export const messagesInComponent = query({ args: {}, handler: async (ctx) => ctx.runQuery(c.messages, {}) });",
]);
// The app's cron, of a name the component's shares: each namespace has its own.
const APP_CRONS = mod("crons.js", [
  'import { cronJobs } from "@bunvex/server";',
  "const crons = cronJobs();",
  'crons.interval("tick", { hours: 1 }, "app:tick");',
  "export default crons;",
]);
const COUNTER = {
  definitionPath: "counter",
  definition: mod("bunvex.config.js", [
    'import { defineComponent } from "@bunvex/server";',
    'export default defineComponent("counter");',
  ]),
  dependencies: [] as string[],
  schema: SCHEMA,
  functions: [
    mod("lib.js", [
      'import { action, internalMutation, query } from "@bunvex/server";',
      "export const tick = internalMutation({ args: {}, handler: async (ctx) => { await ctx.db.insert('messages', { body: 'tick' }); return 'ticked'; } });",
      "export const act = action({ args: {}, handler: async (ctx) => { await ctx.runMutation('lib:tick', {}); return 'acted'; } });",
      "export const messages = query({ args: {}, handler: async (ctx) => (await ctx.db.query('messages').collect()).map((m) => m.body) });",
    ]),
    mod("crons.js", [
      'import { cronJobs } from "@bunvex/server";',
      "const crons = cronJobs();",
      'crons.interval("tick", { hours: 1 }, "lib:tick");',
      'crons.interval("act", { hours: 1 }, "lib:act");',
      "export default crons;",
    ]),
  ],
  udfServerVersion: "1.46.0",
};

async function deployment() {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-component-crons-"));
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
  /** A push of the app, with `counter` mounted or not. */
  const push = async (withCounter = true) => {
    const start = await post("/api/deploy2/start_push", {
      adminKey: KEY,
      functions: "bunvex",
      nodeDependencies: [],
      appDefinition: {
        definition: withCounter ? APP_DEFINITION : NO_COMPONENTS,
        dependencies: withCounter ? ["counter"] : [],
        schema: SCHEMA,
        changedModules: [APP, APP_CRONS],
        unchangedModuleHashes: [],
        udfServerVersion: "1.46.0",
      },
      componentDefinitions: withCounter ? [COUNTER] : [],
    });
    if (start.status !== 200) throw new Error(JSON.stringify(start.body));
    await post("/api/deploy2/wait_for_schema", {
      adminKey: KEY,
      schemaChange: start.body!.schemaChange,
      timeoutMs: 5000,
    });
    const finish = await post("/api/deploy2/finish_push", { adminKey: KEY, startPush: start.body, dryRun: false });
    if (finish.status !== 200) throw new Error(JSON.stringify(finish.body));
  };
  const call = async (path: string) =>
    (await post("/api/query", { path, args: {}, format: "json" }, null)).body!.value as string[];
  const componentId = async () =>
    (
      (await post("/api/query", { path: "_system/frontend/components:list", args: {}, format: "json" })).body!
        .value as { id: string; path: string }[]
    ).find((c) => c.path === "counter")!.id;
  /** A system table of the component's namespace, read directly. */
  const inComponent = async (id: string, table: string) =>
    engine.query((db) => db.inComponent(id, () => db.asSystem(() => db.query(table).collect())));
  return { engine, push, call, componentId, inComponent };
}

async function until(f: () => Promise<boolean>, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

describe("a component's crons", () => {
  test("run its own functions in its namespace, beside the app's cron of the same name", async () => {
    const d = await deployment();
    const errors = spyOn(console, "error");
    stops.push(() => errors.mockRestore());
    await d.push();
    // A new interval cron runs at once: the component's mutation, its action (which calls the mutation), the app's.
    await until(async () => (await d.call("app:messagesInComponent")).length === 2, "the component's crons");
    // Not before the push installed the component's code: no run found its function missing.
    expect(errors.mock.calls.map((c) => String(c[1] ?? c[0])).filter((m) => m.includes("missing function"))).toEqual(
      [],
    );
    await until(async () => (await d.call("app:messages")).length === 1, "the app's cron");
    expect(await d.call("app:messages")).toEqual(["app"]);
    const id = await d.componentId();
    // Each run's log is the component's, with its result (as JSON text, as Convex stores it).
    await until(async () => (await d.inComponent(id, "_cron_job_logs")).length === 2, "the component's logs");
    const logs = (await d.inComponent(id, "_cron_job_logs")) as unknown as {
      name: string;
      status: { result: { value: string } };
    }[];
    expect(logs.map((l) => [l.name, l.status.result.value]).sort()).toEqual([
      ["act", '"acted"'],
      ["tick", '"ticked"'],
    ]);
    expect(
      ((await d.inComponent(id, "_cron_jobs")) as unknown as { name: string }[]).map((j) => j.name).sort(),
    ).toEqual(["act", "tick"]);
    // The app's log is the app's own.
    const appLogs = (await d.engine.query((db) =>
      db.asSystem(() => db.query("_cron_job_logs").collect()),
    )) as unknown as {
      name: string;
    }[];
    expect(appLogs.map((l) => l.name)).toEqual(["tick"]);
  });

  test("an unmount deletes them; a remount starts them again", async () => {
    const d = await deployment();
    await d.push();
    await until(async () => (await d.call("app:messagesInComponent")).length === 2, "the first runs");
    const id = await d.componentId();
    await d.push(false);
    expect(await d.inComponent(id, "_cron_jobs")).toEqual([]);
    expect(await d.inComponent(id, "_cron_next_run")).toEqual([]);
    await d.push();
    // New again, so each runs at once once more.
    await until(async () => (await d.call("app:messagesInComponent")).length === 4, "the runs after the remount");
  });
});

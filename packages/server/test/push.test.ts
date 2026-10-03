// Pushing over HTTP (STUDY-35 PR 4): Convex's deploy2 protocol — get_config_hashes, start_push,
// wait_for_schema, finish_push — with the Deploy operation, diff pushes, Convex's errors, the schema and
// auth.config from the push, crons in the same commit, and a restart on the pushed code and schema.
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
import { startIssuer } from "./issuer.ts";

const SECRET = "ab".repeat(32);
const NAME = "push-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
const READ_ONLY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), readOnly: true });

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const mod = (path: string, source: string): ModuleSource => ({ path, source, environment: "isolate" });
const sha = (m: ModuleSource) =>
  new Bun.CryptoHasher("sha256")
    .update(m.source)
    .update(m.sourceMap ?? "")
    .digest("hex");

async function deployment(dir: string, o: { deployable?: boolean; store?: MemoryBlobStore } = {}) {
  const engine = await new Engine(defineSchema({}), new SqlitePersistence(join(dir, "db.sqlite"), { durable: true }), {
    instanceName: NAME,
    instanceSecret: SECRET,
    storedSchema: true,
  }).init();
  const s = createServer({
    engine,
    functions: new Functions(engine),
    port: 0,
    deployable: o.deployable ?? true,
    moduleStorage: o.store ?? new MemoryBlobStore(),
    redactLogsToClient: false,
  });
  const api = `http://127.0.0.1:${s.server.port}`;
  const post = async (path: string, body: object, key: string | null = KEY) => {
    const r = await fetch(`${api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bunvex ${key}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const call = async (kind: string, path: string, args: object = {}, auth?: string) =>
    (await (
      await fetch(`${api}/api/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
        body: JSON.stringify({ path, args }),
      })
    ).json()) as { status: string; value?: unknown; errorMessage?: string };
  /** What `bunvex deploy` does: hashes, start, wait, finish. */
  const push = async (modules: ModuleSource[], schema: ModuleSource | null = null, key = KEY) => {
    const hashes = (await post("/api/get_config_hashes", {}, key)).body.moduleHashes as {
      path: string;
      hash: string;
    }[];
    const remote = new Map(hashes.map((h) => [h.path, h.hash]));
    const changedModules = modules.filter((m) => remote.get(m.path) !== sha(m));
    const unchangedModuleHashes = modules
      .filter((m) => remote.get(m.path) === sha(m))
      .map((m) => ({ path: m.path, environment: m.environment, sha256: sha(m) }));
    const start = await post(
      "/api/deploy2/start_push",
      {
        dryRun: false,
        functions: "bunvex",
        appDefinition: {
          definition: null,
          dependencies: [],
          schema,
          changedModules,
          unchangedModuleHashes,
          udfServerVersion: "1",
        },
        componentDefinitions: [],
        nodeDependencies: [],
      },
      key,
    );
    if (start.status !== 200) return { start, changedModules };
    let wait: Record<string, any>;
    do
      wait = (
        await post("/api/deploy2/wait_for_schema", { schemaChange: start.body.schemaChange, timeoutMs: 1000 }, key)
      ).body;
    while (wait.type === "inProgress");
    const finish = await post("/api/deploy2/finish_push", { startPush: start.body, dryRun: false }, key);
    return { start, wait, finish, changedModules };
  };
  return { engine, s, post, call, push, api };
}
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-push-"));
  dirs.push(d);
  return d;
};

const messages = (n: number) =>
  mod(
    "messages.js",
    `import { query, mutation } from "@bunvex/server";
     import { v } from "@bunvex/values";
     export const list = query(async ({ db }) => (await db.query("messages").withIndex("by_author", (q) => q.eq("author", "ada")).collect()).map((m) => m.body + " v${n}"));
     export const send = mutation({ args: { author: v.string(), body: v.string() }, handler: async ({ db }, a) => db.insert("messages", a) });`,
  );
const schema = mod(
  "schema.js",
  `import { defineSchema, defineTable } from "@bunvex/server";
   import { v } from "@bunvex/values";
   export default defineSchema({ messages: defineTable({ author: v.string(), body: v.string() }).index("by_author", ["author"]) });`,
);

describe("deploy2 over HTTP", () => {
  test("a first push: start (analysis, schema change), wait, finish (diff); the code and schema are live", async () => {
    const d = await deployment(tmp());
    stops.push(() => d.s.shutdown());
    const r = await d.push([messages(1), mod("other.js", `export const x = 1;`)], schema);
    expect(r.start.status).toBe(200);
    expect(Object.keys(r.start.body.analysis[""].functions).sort()).toEqual(["messages.js", "other.js"]);
    expect(r.start.body.analysis[""].functions["messages.js"].functions.map((f: { name: string }) => f.name)).toEqual([
      "list",
      "send",
    ]);
    expect(r.start.body.analysis[""].schema.tables[0].tableName).toBe("messages");
    expect(r.start.body.schemaChange.indexDiffs[""].added_indexes).toEqual(["messages.by_author"]);
    expect(r.wait).toEqual({ type: "complete" });
    expect(r.finish!.status).toBe(200);
    expect(r.finish!.body.componentDiffs[""].moduleDiff).toEqual({ added: ["messages.js", "other.js"], removed: [] });
    expect((await d.call("mutation", "messages:send", { author: "ada", body: "hi" })).status).toBe("success");
    expect((await d.call("query", "messages:list")).value).toEqual(["hi v1"]);
    // The schema's validator holds.
    expect((await d.call("mutation", "messages:send", { author: "ada" })).status).toBe("error");
  });

  test("a second push sends only what changed; a wrong hash is a 409", async () => {
    const d = await deployment(tmp());
    stops.push(() => d.s.shutdown());
    await d.push([messages(1), mod("other.js", `export const x = 1;`)], schema);
    const hashes = (await d.post("/api/get_config_hashes", {})).body.moduleHashes;
    expect(hashes.map((h: { path: string }) => h.path).sort()).toEqual(["messages.js", "other.js"]);
    const r = await d.push([messages(2), mod("other.js", `export const x = 1;`)], schema);
    expect(r.changedModules.map((m) => m.path)).toEqual(["messages.js"]);
    expect(r.finish!.status).toBe(200);
    await d.call("mutation", "messages:send", { author: "ada", body: "yo" });
    expect((await d.call("query", "messages:list")).value).toEqual(["yo v2"]);
    const bad = await d.post("/api/deploy2/start_push", {
      appDefinition: {
        changedModules: [],
        unchangedModuleHashes: [{ path: "other.js", environment: "isolate", sha256: "00" }],
        schema: null,
      },
    });
    expect([bad.status, bad.body.code]).toEqual([409, "ExistingModuleHashConflict"]);
  });

  test("a module or schema that fails: Convex's errors, and the old code keeps serving", async () => {
    const d = await deployment(tmp());
    stops.push(() => d.s.shutdown());
    await d.push([messages(1)], schema);
    const broken = await d.push([mod("messages.js", `throw new Error("broken at import");`)], schema);
    expect(broken.start.status).toBe(400);
    expect(broken.start.body.code).toBe("InvalidModules");
    expect(broken.start.body.message).toStartWith(
      "Hit an error while pushing:\nLoading the pushed modules encountered the following error:\nFailed to analyze messages.js: Uncaught Error: broken at import",
    );
    const badSchema = await d.push([messages(1)], mod("schema.js", `export default 42;`));
    expect([badSchema.start.status, badSchema.start.body.code]).toEqual([400, "InvalidSchema"]);
    expect((await d.call("query", "messages:list")).status).toBe("success");
  });

  test("a schema the existing documents do not match: wait_for_schema answers failed", async () => {
    const d = await deployment(tmp());
    stops.push(() => d.s.shutdown());
    const loose = mod(
      "schema.js",
      `import { defineSchema, defineTable } from "@bunvex/server"; import { v } from "@bunvex/values";
       export default defineSchema({ messages: defineTable(v.any()).index("by_author", ["author"]) });`,
    );
    await d.push([messages(1)], loose);
    await d.call("mutation", "messages:send", { author: "ada", body: "ok" });
    const strict = mod(
      "schema.js",
      `import { defineSchema, defineTable } from "@bunvex/server"; import { v } from "@bunvex/values";
       export default defineSchema({ messages: defineTable({ author: v.string(), body: v.string(), score: v.number() }).index("by_author", ["author"]) });`,
    );
    const r = await d.push([messages(2)], strict);
    expect(r.wait).toMatchObject({ type: "failed", componentPath: "", tableName: "messages" });
    expect(r.wait!.error).toMatch(/^Document with ID ".+" in table "messages" does not match the schema: /);
    expect(r.finish!.body.code).toBe("SchemaNotReady");
    expect((await d.call("query", "messages:list")).value).toEqual(["ok v1"]);
  });

  test("the Deploy operation: no key, a read-only key, an embedded server", async () => {
    const d = await deployment(tmp());
    stops.push(() => d.s.shutdown());
    expect((await d.post("/api/get_config_hashes", {}, null)).body.code).toBe("BadDeployKey");
    const ro = await d.post("/api/get_config_hashes", {}, READ_ONLY);
    expect([ro.status, ro.body.message]).toEqual([
      403,
      "You do not have permission to perform this operation (deployment:deploy).",
    ]);
    // The admin key in the body, as Convex's CLI also sends it.
    expect((await d.post("/api/get_config_hashes", { adminKey: KEY }, null)).status).toBe(200);
    const e = await deployment(tmp(), { deployable: false });
    stops.push(() => e.s.shutdown());
    expect((await e.post("/api/get_config_hashes", {})).body.code).toBe("NotDeployable");
  });

  test("two pushes racing: the older one's finish is RaceDetected", async () => {
    const d = await deployment(tmp());
    stops.push(() => d.s.shutdown());
    const body = (n: number) => ({
      appDefinition: { schema, changedModules: [messages(n)], unchangedModuleHashes: [] },
      componentDefinitions: [],
    });
    const a = await d.post("/api/deploy2/start_push", body(1));
    const b = await d.post("/api/deploy2/start_push", body(2));
    expect((await d.post("/api/deploy2/wait_for_schema", { schemaChange: a.body.schemaChange })).body).toEqual({
      type: "raceDetected",
    });
    const fa = await d.post("/api/deploy2/finish_push", { startPush: a.body });
    expect([fa.status, fa.body.code, fa.body.message]).toEqual([
      400,
      "RaceDetected",
      "Schema was overwritten by another push.",
    ]);
    expect((await d.post("/api/deploy2/finish_push", { startPush: b.body })).status).toBe(200);
    // A finish for a push this server never started (or lost on a restart) is refused the same way.
    const unknown = await d.post("/api/deploy2/finish_push", {
      startPush: { schemaChange: { schemaIds: { "": "nope" } } },
    });
    expect([unknown.status, unknown.body.code]).toEqual([400, "RaceDetected"]);
  });

  test("auth.config from the push, evaluated with the deployment's variables; kept across a restart", async () => {
    const issuer = await startIssuer();
    stops.push(issuer.stop);
    const dir = tmp();
    const store = new MemoryBlobStore();
    const d = await deployment(dir, { store });
    const who = mod(
      "who.js",
      `import { query } from "@bunvex/server"; export const me = query(async ({ auth }) => (await auth.getUserIdentity())?.subject ?? null);`,
    );
    const auth = mod(
      "auth.config.js",
      `export default { providers: [{ domain: process.env.ISSUER, applicationID: "app" }] };`,
    );
    // A variable it reads that is not set: Convex's error.
    const missing = await d.push([who, auth]);
    expect(missing.start.status).toBe(400);
    expect(missing.start.body).toEqual({
      code: "AuthConfigMissingEnvironmentVariable",
      message:
        "Hit an error while pushing:\nEnvironment variable ISSUER is used in auth config file but its value was not set",
    });
    expect(
      (await d.post("/api/update_environment_variables", { changes: [{ name: "ISSUER", value: issuer.url }] })).status,
    ).toBe(200);
    const r = await d.push([who, auth]);
    expect(r.start.body.appAuth).toEqual([{ domain: issuer.url, applicationID: "app" }]);
    expect((await d.call("query", "who:me", {}, `Bearer ${await issuer.sign()}`)).value).toBe("user-1");
    // A restart re-evaluates the stored auth config.
    await d.s.shutdown();
    await d.engine.close();
    const again = await deployment(dir, { store });
    stops.push(() => again.s.shutdown());
    await again.s.codeReady;
    expect((await again.call("query", "who:me", {}, `Bearer ${await issuer.sign()}`)).value).toBe("user-1");
    // Removing the variable it reads would break it: refused, nothing changed.
    const refused = await again.post("/api/update_environment_variables", {
      changes: [{ name: "ISSUER", value: null }],
    });
    expect(refused).toEqual({
      status: 400,
      body: {
        code: "AuthConfigMissingEnvironmentVariable",
        message: "Environment variable ISSUER is used in auth config file but its value was not set",
      },
    });
    expect((await again.call("query", "who:me", {}, `Bearer ${await issuer.sign()}`)).value).toBe("user-1");
    // Changing it re-evaluates the config: the old issuer's tokens are no longer accepted.
    await again.post("/api/update_environment_variables", {
      changes: [{ name: "ISSUER", value: "https://elsewhere.example" }],
    });
    expect((await again.call("query", "who:me", {}, `Bearer ${await issuer.sign()}`)).status).not.toBe("success");
    // Without auth.config in the next push, tokens are no longer accepted either.
    await again.post("/api/update_environment_variables", { changes: [{ name: "ISSUER", value: issuer.url }] });
    expect((await again.call("query", "who:me", {}, `Bearer ${await issuer.sign()}`)).value).toBe("user-1");
    await again.push([who]);
    expect((await again.call("query", "who:me", {}, `Bearer ${await issuer.sign()}`)).status).not.toBe("success");
  });

  test("crons come with the push, in its commit", async () => {
    const d = await deployment(tmp());
    stops.push(() => d.s.shutdown());
    const jobs = mod(
      "jobs.js",
      `import { internalMutation } from "@bunvex/server"; export const tick = internalMutation(async () => {});`,
    );
    const crons = mod(
      "crons.js",
      `import { cronJobs } from "@bunvex/server"; const c = cronJobs(); c.interval("tick", { minutes: 5 }, "jobs:tick"); export default c;`,
    );
    const r1 = await d.push([jobs, crons]);
    expect(r1.finish!.body.componentDiffs[""].cronDiff).toEqual({ added: ["tick"], updated: [], deleted: [] });
    const r2 = await d.push([jobs]);
    expect(r2.finish!.body.componentDiffs[""].cronDiff).toEqual({ added: [], updated: [], deleted: ["tick"] });
  });

  test("a restart serves the pushed code and schema", async () => {
    const dir = tmp();
    const store = new MemoryBlobStore();
    const a = await deployment(dir, { store });
    await a.push([messages(1)], schema);
    await a.call("mutation", "messages:send", { author: "ada", body: "kept" });
    await a.s.shutdown();
    const b = await deployment(dir, { store });
    stops.push(() => b.s.shutdown());
    await b.s.codeReady;
    expect((await b.call("query", "messages:list")).value).toEqual(["kept v1"]);
    expect((await b.call("mutation", "messages:send", { author: "ada" })).status).toBe("error");
  });
});

describe("environment variables (STUDY-37)", () => {
  const envMod = mod(
    "env.js",
    `import { action, query } from "@bunvex/server";
     export const read = query(async (_, { name }) => process.env[name] ?? null);
     export const inAction = action(async (_, { name }) => process.env[name] ?? null);
     export const keys = query(async () => Object.keys(process.env));`,
  );

  test("the HTTP API: update (one batch, Convex's errors) and list, with their operations", async () => {
    const d = await deployment(tmp());
    stops.push(() => d.s.shutdown());
    const list = async (key = KEY) => {
      const r = await fetch(`${d.api}/api/list_environment_variables`, { headers: { authorization: `Bunvex ${key}` } });
      return { status: r.status, body: await r.json() };
    };
    expect(await list()).toEqual({ status: 200, body: { environmentVariables: {} } });
    const ok = await fetch(`${d.api}/api/update_environment_variables`, {
      method: "POST",
      headers: { authorization: `Bunvex ${KEY}` },
      body: JSON.stringify({
        changes: [
          { name: "B", value: "2" },
          { name: "A", value: "1" },
        ],
      }),
    });
    expect([ok.status, await ok.text()]).toEqual([200, ""]);
    expect((await list()).body).toEqual({ environmentVariables: { A: "1", B: "2" } });
    expect((await d.post("/api/v1/update_environment_variables", { changes: [{ name: "B" }] })).status).toBe(200);
    expect((await list()).body).toEqual({ environmentVariables: { A: "1" } });
    // A refused batch changes nothing.
    const bad = await d.post("/api/update_environment_variables", {
      changes: [
        { name: "C", value: "3" },
        { name: "9X", value: "no" },
      ],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("EnvironmentVariableNameInvalid");
    const builtIn = await d.post("/api/update_environment_variables", {
      changes: [{ name: "BUNVEX_CLOUD_URL", value: "x" }],
    });
    expect(builtIn.body).toEqual({
      code: "EnvVarNameForbidden",
      message: 'Environment variable with name "BUNVEX_CLOUD_URL" is built-in and cannot be overridden',
    });
    expect((await list()).body).toEqual({ environmentVariables: { A: "1" } });
    // Their operations: a read-only key lists but does not write; no key is refused.
    expect((await list(READ_ONLY)).status).toBe(200);
    expect((await d.post("/api/update_environment_variables", { changes: [] }, READ_ONLY)).status).toBe(403);
    expect((await d.post("/api/update_environment_variables", { changes: [] }, null)).status).toBe(403);
    // The CLI's system queries.
    expect(
      (
        (await d.call("query", "_system/cli/queryEnvironmentVariables", {}, `Bunvex ${KEY}`)).value as {
          name: string;
        }[]
      ).map((v) => v.name),
    ).toEqual(["A"]);
    expect(
      (await d.call("query", "_system/cli/queryEnvironmentVariables:get", { name: "A" }, `Bunvex ${KEY}`)).value,
    ).toEqual({
      name: "A",
      value: "1",
    });
    expect(
      (await d.call("query", "_system/cli/queryEnvironmentVariables:get", { name: "Z" }, `Bunvex ${KEY}`)).value,
    ).toBe(null);
  });

  test("process.env in pushed code: per name in the read set, actions at their start, the built-ins", async () => {
    const d = await deployment(tmp());
    stops.push(() => d.s.shutdown());
    await d.push([envMod]);
    const set = (name: string, value: string | null) =>
      d.post("/api/update_environment_variables", { changes: [{ name, value }] });
    expect((await d.call("query", "env:read", { name: "X" })).value).toBe(null);
    await set("X", "1");
    expect((await d.call("query", "env:read", { name: "X" })).value).toBe("1"); // the cached null was invalidated
    await set("X", "2");
    expect((await d.call("query", "env:read", { name: "X" })).value).toBe("2");
    expect((await d.call("action", "env:inAction", { name: "X" })).value).toBe("2");
    expect((await d.call("query", "env:read", { name: "BUNVEX_CLOUD_URL" })).value).toBe(d.api);
    expect((await d.call("query", "env:read", { name: "BUNVEX_SITE_URL" })).value).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+$/,
    );
    // Convex's isolate env lists nothing, and refuses a name that does not parse.
    expect((await d.call("query", "env:keys")).value).toEqual([]);
    const invalid = await d.call("query", "env:read", { name: "a-b" });
    expect(invalid.errorMessage).toContain("The environment variable name a-b is invalid.");
    // The server's own environment is not the deployment's.
    expect((await d.call("query", "env:read", { name: "PATH" })).value).toBe(null);
    // A "use node" action: the process's allowlisted variables plus the deployment's, which can be listed.
    await d.push([
      envMod,
      {
        path: "nodeEnv.js",
        environment: "node",
        source: `"use node";
         import { action } from "@bunvex/server";
         export const keys = action(async () => Object.keys(process.env));`,
      },
    ]);
    const keys = (await d.call("action", "nodeEnv:keys")).value as string[];
    expect(keys).toContain("X");
    expect(keys).toContain("BUNVEX_CLOUD_URL");
    expect(keys).toContain("PATH");
    expect(keys).not.toContain("HOME");
  });

  test('the function log names a "use node" action\'s environment (STUDY-47)', async () => {
    const d = await deployment(tmp());
    stops.push(() => d.s.shutdown());
    await d.push([
      envMod,
      {
        path: "nodeAct.js",
        environment: "node",
        source: `"use node";
         import { action } from "@bunvex/server";
         export const go = action(async () => 1);`,
      },
    ]);
    await d.call("action", "nodeAct:go");
    await d.call("action", "env:inAction", { name: "X" });
    const { parts } = await d.s.functionLog.after(0, 1000);
    const done = parts.filter((p) => p.kind === "Completion") as { identifier: string; environment: string }[];
    expect(done.map((p) => [p.identifier, p.environment])).toEqual([
      ["nodeAct:go", "node"],
      ["env:inAction", "isolate"],
    ]);
  });

  test("a subscription re-runs when a variable it read changes", async () => {
    const d = await deployment(tmp());
    stops.push(() => d.s.shutdown());
    await d.push([envMod]);
    const values: unknown[] = [];
    const ws = new WebSocket(`${d.api.replace("http", "ws")}/api/1.0/sync`);
    await new Promise((r) => ws.addEventListener("open", r));
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === "Transition") for (const q of m.modifications) if (q.type === "QueryUpdated") values.push(q.value);
    });
    ws.send(
      JSON.stringify({ type: "Connect", sessionId: crypto.randomUUID(), connectionCount: 0, lastCloseReason: null }),
    );
    ws.send(
      JSON.stringify({
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 1,
        modifications: [{ type: "Add", queryId: 0, udfPath: "env:read", args: [{ name: "Y" }] }],
      }),
    );
    const until = async (n: number) => {
      for (let i = 0; i < 100 && values.length < n; i++) await Bun.sleep(20);
    };
    await until(1);
    await d.post("/api/update_environment_variables", { changes: [{ name: "OTHER", value: "1" }] });
    await d.post("/api/update_environment_variables", { changes: [{ name: "Y", value: "yes" }] });
    await until(2);
    ws.close();
    expect(values).toEqual([null, "yes"]);
  });

  test("a push whose variables changed before its finish is a race", async () => {
    const d = await deployment(tmp());
    stops.push(() => d.s.shutdown());
    const start = await d.post("/api/deploy2/start_push", {
      dryRun: false,
      appDefinition: { schema: null, changedModules: [envMod], unchangedModuleHashes: [] },
      componentDefinitions: [],
    });
    expect(start.status).toBe(200);
    await d.post("/api/update_environment_variables", { changes: [{ name: "X", value: "1" }] });
    const finish = await d.post("/api/deploy2/finish_push", { startPush: start.body, dryRun: false });
    expect(finish).toEqual({
      status: 400,
      body: { code: "RaceDetected", message: "Environment variables have changed during push" },
    });
  });
});

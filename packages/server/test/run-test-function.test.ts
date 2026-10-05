// The function tester (STUDY-119): `POST /api/run_test_function`, as Convex's `run_test_function` and
// `execute_standalone_module` — one module, analyzed alone, whose default query runs once, uncached; the admin
// key in the body; Convex's refusals.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { Functions } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const SECRET = "cd".repeat(32);
const NAME = "tester-test";
const cipherKey = adminKeyCipherKey(SECRET);
const KEY = issueAdminKey({ instanceName: NAME, cipherKey });
const READ_ONLY = issueAdminKey({ instanceName: NAME, cipherKey, readOnly: true });
const OTHER = issueAdminKey({ instanceName: "tacos", cipherKey });
const SERVER = ["bunvex", "server"].join("/");
const WRAPPERS = "bunvex:/_system/repl/wrappers.js";

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function deployment() {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-tester-"));
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
  stops.push(() => s.shutdown());
  await s.deployCode([
    {
      path: "items.js",
      source: `import { mutation, query } from ${JSON.stringify(SERVER)};
export const add = mutation(async ({ db }, { n }) => { await db.insert("items", { n }); });
export const count = query(async ({ db }) => (await db.query("items").collect()).length);`,
      environment: "isolate",
    },
  ]);
  const api = `http://127.0.0.1:${s.server.port}`;
  const raw = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${api}/api/run_test_function`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const tester = async (source: string, o: { key?: string; format?: string; extra?: object; path?: string } = {}) => {
    const r = await raw({
      adminKey: o.key ?? KEY,
      args: {},
      bundle: { path: o.path ?? "testQuery.js", source },
      format: o.format ?? "encoded_json",
      ...o.extra,
    });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const call = async (kind: string, path: string, args: object = {}) =>
    (await (
      await fetch(`${api}/api/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bunvex ${KEY}` },
        body: JSON.stringify({ path, args, format: "encoded_json" }),
      })
    ).json()) as { status: string; value?: unknown };
  return { api, raw, tester, call };
}

const wrapped = (body: string) => `import { query } from ${JSON.stringify(WRAPPERS)};
export default query({ handler: async (ctx) => { ${body} } });`;

describe("POST /api/run_test_function", () => {
  test("runs the default query against the deployment's data: value and log lines, encoded JSON", async () => {
    const d = await deployment();
    await d.call("mutation", "items:add", { n: 1 });
    await d.call("mutation", "items:add", { n: 2 });
    const r = await d.tester(
      wrapped(`const docs = await ctx.db.query("items").collect(); console.log("seen", docs.length);
        console.warn("careful"); return { ns: docs.map((x) => x.n), big: 5n };`),
    );
    expect(r).toEqual({
      status: 200,
      body: {
        status: "success",
        value: { ns: [1, 2], big: { $integer: "BQAAAAAAAAA=" } },
        logLines: ["[LOG] 'seen' 2", "[WARN] 'careful'"],
      },
    });
    // No log lines: the field is left out, as Convex's.
    expect((await d.tester(wrapped("return null;"))).body).toEqual({ status: "success", value: null });
    // Clean JSON when asked.
    expect((await d.tester(wrapped("return 5n;"), { format: "json" })).body).toEqual({
      status: "success",
      value: "5",
    });
  });

  test("the run is logged with the Tester caller (DV-253 resolved)", async () => {
    const d = await deployment();
    await d.tester(wrapped(`console.log("hi"); return 1;`));
    const r = await fetch(`${d.api}/api/stream_function_logs?cursor=0`, {
      headers: { authorization: `Bunvex ${KEY}` },
    });
    const entries = ((await r.json()) as { entries: any[] }).entries.filter((e) => e.kind === "Completion");
    expect(entries.at(-1)).toMatchObject({
      udfType: "Query",
      identifier: "testQuery",
      caller: "Tester",
      cachedResult: false,
      logLines: ["[LOG] 'hi'"],
      identityType: "instance_admin",
    });
  });

  test("uncached: a second run sees a write made in between; nothing is deployed", async () => {
    const d = await deployment();
    const q = wrapped(`return (await ctx.db.query("items").collect()).length;`);
    expect((await d.tester(q)).body.value).toBe(0);
    await d.call("mutation", "items:add", { n: 1 });
    expect((await d.tester(q)).body.value).toBe(1);
    // Another module at the same path, with the same arguments: its own result, not a cached one.
    expect((await d.tester(wrapped("return 1;"))).body.value).toBe(1);
    expect((await d.tester(wrapped("return 2;"))).body.value).toBe(2);
    // The tester's module is not a deployed function afterwards.
    const after = await d.call("query", "testQuery:default");
    expect(after.status).toBe("error");
  });

  test("a query cannot write: the run fails as the function's error, nothing is written", async () => {
    const d = await deployment();
    const r = await d.tester(wrapped(`await ctx.db.insert("items", { n: 9 }); return 1;`));
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("error");
    expect(r.body.errorMessage).toContain("Uncaught Error: queries cannot write");
    expect((await d.call("query", "items:count")).value).toBe(0);
    // A thrown error is the function's error, with its log lines.
    const thrown = await d.tester(wrapped(`console.log("before"); throw new Error("boom");`));
    expect(thrown.body.status).toBe("error");
    expect(thrown.body.errorMessage).toContain("Uncaught Error: boom");
    expect(thrown.body.logLines).toEqual(["[LOG] 'before'"]);
  });

  test("the module: only a default export, a query; Convex's codes and messages", async () => {
    const d = await deployment();
    const named = await d.tester(
      `import { query } from ${JSON.stringify(WRAPPERS)};
export const other = query({ handler: async () => 1 });
export default query({ handler: async () => 2 });`,
    );
    expect(named).toEqual({
      status: 400,
      body: { code: "InvalidTestQuery", message: "Only `export default` is supported." },
    });
    // Exports that are not functions are fine.
    expect(
      (
        await d.tester(`import { query } from ${JSON.stringify(WRAPPERS)};
export const n = 1;
export default query({ handler: async () => n });`)
      ).body,
    ).toEqual({ status: "success", value: 1 });
    expect(await d.tester("export default 1;")).toEqual({
      status: 400,
      body: { code: "InvalidTestQuery", message: "Default export is not a bunvex function." },
    });
    const mutation = await d.tester(
      `import { mutation } from ${JSON.stringify(SERVER)}; export default mutation({ handler: async () => 1 });`,
    );
    expect(mutation).toEqual({
      status: 400,
      body: { code: "UnsupportedTestQuery", message: "Mutations are not supported in the REPL yet." },
    });
    const action = await d.tester(
      `import { action } from ${JSON.stringify(SERVER)}; export default action({ handler: async () => 1 });`,
    );
    expect(action.body.message).toBe("Actions are not supported in the REPL yet.");
    // Analyzed alone: it cannot import the deployment's modules.
    const imports = await d.tester(`import { count } from "./items.js"; export default count;`);
    expect(imports.status).toBe(400);
    expect(imports.body.code).toBe("InvalidModules");
    expect(imports.body.message).toStartWith("Could not analyze the given module:\nFailed to analyze testQuery.js:");
    // An import that throws.
    const throws = await d.tester(`throw new Error("at import");`);
    expect(throws.body).toEqual({
      code: "InvalidModules",
      message: expect.stringContaining(
        "Could not analyze the given module:\nFailed to analyze testQuery.js: Uncaught Error: at import",
      ),
    });
    // The Node runtime is refused; so is a path that is not a module's.
    expect(
      await d.tester(wrapped("return 1;"), { extra: { bundle: { path: "t.js", source: "", environment: "node" } } }),
    ).toEqual({
      status: 400,
      body: { code: "InvalidTestQueryEnvironment", message: "Test queries must use the bunvex runtime." },
    });
    expect((await d.tester(wrapped("return 1;"), { path: "../t.js" })).body).toEqual({
      code: "BadBunvexModuleIdentifier",
      message: "../t.js is not a valid path to a bunvex module. Invalid path component ParentDir in ../t.js.",
    });
  });

  test("the admin key in the body: a missing, bad or foreign key is refused; a read-only key may test", async () => {
    const d = await deployment();
    const q = wrapped("return 1;");
    const missing = await d.raw({ args: {}, bundle: { path: "testQuery.js", source: q }, format: "json" });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { message: string }).message).toStartWith(
      "Failed to deserialize the JSON body into the target type: missing field `adminKey`",
    );
    const bad = await d.tester(q, { key: "nope" });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe("BadAdminKey");
    const foreign = await d.tester(q, { key: OTHER });
    expect(foreign.status).toBe(401);
    expect(foreign.body.code).toBe("BadAdminKey");
    // A header does not stand in for the body's key.
    const header = await d.raw(
      { adminKey: "", args: {}, bundle: { path: "testQuery.js", source: q }, format: "json" },
      { authorization: `Bunvex ${KEY}` },
    );
    expect(header.status).toBe(401);
    expect((await d.tester(q, { key: READ_ONLY })).body).toEqual({ status: "success", value: 1 });
    // `format` is required, and only POST is routed.
    const noFormat = await d.raw({ adminKey: KEY, args: {}, bundle: { path: "testQuery.js", source: q } });
    expect(noFormat.status).toBe(400);
    expect((await fetch(`${d.api}/api/run_test_function`)).status).toBe(405);
  });

  test("components: bunvex has none (DV-391)", async () => {
    const d = await deployment();
    expect(await d.tester(wrapped("return 1;"), { extra: { componentId: "abc" } })).toEqual({
      status: 400,
      body: { code: "ComponentsNotSupported", message: "bunvex does not have components yet." },
    });
    // No component (null or empty) is the app's root.
    expect((await d.tester(wrapped("return 1;"), { extra: { componentId: null } })).body.value).toBe(1);
  });
});

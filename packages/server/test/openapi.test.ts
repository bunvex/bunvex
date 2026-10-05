// The OpenAPI documents (STUDY-115), as Convex's: `/api/v1/openapi.json`, `/api/dashboard_openapi.json` and
// `/api/public_openapi.json`, OpenAPI 3.1 as pretty JSON, with no auth. Each document is checked for its
// structure; every documented route is called on a server with a request its schema allows, and the answer
// checked against its response schema (so a route cannot be documented without being served as documented);
// Convex's routes left out answer 404, as does any undocumented `/api/v1/` path; and the text is pinned by a
// JSON snapshot (test/fixtures/openapi/; `UPDATE_OPENAPI_SNAPSHOT=1` rewrites it).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { action, Functions, internalQuery, mutation, query } from "../src/functions.ts";
import {
  type ApiOperation,
  concretePath,
  isPlatformPath,
  OPENAPI_DOCS,
  OPENAPI_LEFT_OUT,
  OPENAPI_OPERATIONS,
  type OpenApiDocName,
  openApiDocument,
  openApiText,
} from "../src/openapi.ts";
import { createServer } from "../src/server.ts";

const SECRET = "0a".repeat(32);
const NAME = "openapi-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), memberId: 4 });
const DOCS = Object.keys(OPENAPI_DOCS) as OpenApiDocName[];
type Doc = Record<string, any>;

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

// ---------------------------------------------------------------- a small OpenAPI 3.1 checker

const METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

/** The structural errors of an OpenAPI 3.x document (the parts these documents use). */
function openApiErrors(doc: Doc): string[] {
  const errors: string[] = [];
  const fail = (where: string, what: string) => errors.push(`${where}: ${what}`);
  if (typeof doc.openapi !== "string" || !/^3\.\d+\.\d+$/.test(doc.openapi)) fail("openapi", "not 3.x.y");
  if (typeof doc.info?.title !== "string" || doc.info.title === "") fail("info.title", "missing");
  if (typeof doc.info?.version !== "string") fail("info.version", "missing");
  if (doc.info?.license && typeof doc.info.license.name !== "string") fail("info.license.name", "missing");
  for (const [i, s] of (doc.servers ?? []).entries()) {
    if (typeof s.url !== "string") fail(`servers[${i}].url`, "missing");
    for (const name of String(s.url).match(/\{[^}]+\}/g) ?? [])
      if (typeof s.variables?.[name.slice(1, -1)]?.default !== "string") fail(`servers[${i}]`, `${name} undefined`);
  }
  const schemas = doc.components?.schemas ?? {};
  const schemes = doc.components?.securitySchemes ?? {};
  for (const [name, s] of Object.entries<any>(schemes)) {
    if (!["apiKey", "http", "oauth2", "openIdConnect", "mutualTLS"].includes(s.type)) fail(`scheme ${name}`, "type");
    if (s.type === "apiKey" && (!["header", "query", "cookie"].includes(s.in) || typeof s.name !== "string"))
      fail(`scheme ${name}`, "apiKey needs in and name");
  }
  const checkRefs = (where: string, x: unknown) => {
    if (Array.isArray(x)) for (const [i, y] of x.entries()) checkRefs(`${where}[${i}]`, y);
    else if (x && typeof x === "object")
      for (const [k, y] of Object.entries(x)) {
        if (k === "$ref") {
          const m = /^#\/components\/schemas\/(.+)$/.exec(String(y));
          if (!m || !(m[1]! in schemas)) fail(where, `unresolved $ref ${String(y)}`);
        } else checkRefs(`${where}.${k}`, y);
      }
  };
  checkRefs("components", doc.components);
  const operationIds = new Set<string>();
  if (!doc.paths || typeof doc.paths !== "object") fail("paths", "missing");
  for (const [path, item] of Object.entries<any>(doc.paths ?? {})) {
    if (!path.startsWith("/")) fail(path, "does not start with /");
    const templated = (path.match(/\{\*?([^}]+)\}/g) ?? []).map((p) => p.replace(/^\{\*?|\}$/g, ""));
    for (const [method, op] of Object.entries<any>(item)) {
      const at = `${method.toUpperCase()} ${path}`;
      if (!METHODS.has(method)) fail(at, "unknown method");
      if (typeof op.operationId !== "string") fail(at, "no operationId");
      else if (operationIds.has(op.operationId)) fail(at, `duplicate operationId ${op.operationId}`);
      else operationIds.add(op.operationId);
      const params: any[] = op.parameters ?? [];
      for (const p of params) {
        if (!["query", "header", "path", "cookie"].includes(p.in)) fail(at, `parameter ${p.name}: bad in`);
        if (p.in === "path" && (p.required !== true || !templated.includes(p.name)))
          fail(at, `path parameter ${p.name} not required or not in the path`);
        if (!p.schema) fail(at, `parameter ${p.name}: no schema`);
      }
      for (const name of templated)
        if (!params.some((p) => p.in === "path" && p.name === name)) fail(at, `path parameter ${name} undeclared`);
      if (op.requestBody && !op.requestBody.content) fail(at, "requestBody without content");
      if (!op.responses || Object.keys(op.responses).length === 0) fail(at, "no responses");
      for (const [code, r] of Object.entries<any>(op.responses ?? {})) {
        if (!/^([1-5]\d\d|[1-5]XX|default)$/.test(code)) fail(at, `response code ${code}`);
        if (typeof r.description !== "string") fail(at, `response ${code} without description`);
      }
      for (const req of op.security ?? [])
        for (const name of Object.keys(req)) if (!(name in schemes)) fail(at, `unknown security scheme ${name}`);
      checkRefs(at, op);
    }
  }
  return errors;
}

// ---------------------------------------------------------------- a small JSON Schema checker

const resolve = (doc: Doc, schema: any): any =>
  schema.$ref ? resolve(doc, doc.components.schemas[schema.$ref.split("/").pop()]) : schema;

/**
 * Why `value` does not match `schema` (the JSON Schema keywords these documents use), or null. Stricter than
 * JSON Schema: an object may not have a field its schema does not name (`known`: the names an `allOf`'s other
 * branches give), so the server cannot answer more than the document says.
 */
function schemaError(doc: Doc, schema: any, value: unknown, at = "$", known = new Set<string>()): string | null {
  if (schema.$ref) return schemaError(doc, resolve(doc, schema), value, at, known);
  if (schema.type !== undefined) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    const typeOf =
      value === null
        ? "null"
        : Array.isArray(value)
          ? "array"
          : typeof value === "number"
            ? Number.isInteger(value)
              ? "integer"
              : "number"
            : typeof value;
    if (!types.includes(typeOf) && !(typeOf === "integer" && types.includes("number")))
      return `${at}: ${JSON.stringify(value)} is not ${types.join(" or ")}`;
  }
  if (schema.enum && !schema.enum.includes(value)) return `${at}: ${JSON.stringify(value)} not in ${schema.enum}`;
  if (typeof schema.minimum === "number" && typeof value === "number" && value < schema.minimum)
    return `${at}: below ${schema.minimum}`;
  if (schema.allOf) {
    const names = new Set(known);
    for (const s of schema.allOf) for (const k of Object.keys(resolve(doc, s).properties ?? {})) names.add(k);
    for (const s of schema.allOf) {
      const e = schemaError(doc, s, value, at, names);
      if (e) return e;
    }
  }
  if (schema.oneOf) {
    const errs = schema.oneOf.map((s: unknown) => schemaError(doc, s, value, at, known));
    const ok = errs.filter((e: string | null) => e === null).length;
    if (ok !== 1)
      return ok === 0 ? `${at}: no oneOf branch matches (${errs.join("; ")})` : `${at}: ${ok} oneOf branches match`;
  }
  if (Array.isArray(value) && schema.items)
    for (const [i, x] of value.entries()) {
      const e = schemaError(doc, schema.items, x, `${at}[${i}]`);
      if (e) return e;
    }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in o)) return `${at}: missing ${k}`;
    for (const [k, x] of Object.entries(o)) {
      const s = schema.properties?.[k] ?? schema.additionalProperties;
      if (s === false || (s === undefined && schema.properties && !known.has(k))) return `${at}: unexpected ${k}`;
      if (s && s !== true) {
        const e = schemaError(doc, s, x, `${at}.${k}`);
        if (e) return e;
      }
    }
  }
  return null;
}

describe("the documents' structure", () => {
  for (const name of DOCS)
    test(`${name} is valid OpenAPI 3.1`, () => {
      const doc = openApiDocument(name);
      expect(doc.openapi).toBe("3.1.0");
      expect(openApiErrors(doc)).toEqual([]);
    });

  test("the checker catches what it checks", () => {
    const doc = structuredClone(openApiDocument("platform")) as Doc;
    doc.paths["/get_log_stream/{id}"].get.parameters = [];
    doc.paths["/create_log_stream"].post.requestBody.content["application/json"].schema = {
      $ref: "#/components/schemas/Nope",
    };
    doc.paths["/pause_deployment"].post.operationId = "unpause_deployment";
    doc.paths["/unpause_deployment"].post.security = [{ "Deploy Key": [] }];
    expect(openApiErrors(doc)).toEqual([
      "GET /get_log_stream/{id}: path parameter id undeclared",
      "POST /create_log_stream.requestBody.content.application/json.schema: unresolved $ref #/components/schemas/Nope",
      "POST /unpause_deployment: duplicate operationId unpause_deployment",
      "POST /unpause_deployment: unknown security scheme Deploy Key",
    ]);
    expect(schemaError(doc, { $ref: "#/components/schemas/LogStreamStatus" }, { type: "active" })).toBeNull();
    expect(schemaError(doc, { $ref: "#/components/schemas/LogStreamStatus" }, { type: "gone" })).toContain("no oneOf");
    expect(schemaError(doc, { $ref: "#/components/schemas/UsageLimitConfigRequest" }, { metric: "x" })).toContain(
      "missing",
    );
  });

  test("Convex's paths and operation ids; bunvex's titles and its admin key scheme", () => {
    const platform = openApiDocument("platform") as Doc;
    expect(platform.info.title).toBe("bunvex Deployment API");
    expect(platform.servers[0].url).toBe("{deployment-url}/api/v1");
    expect(platform.components.securitySchemes).toEqual({
      "Admin Key": expect.objectContaining({ type: "apiKey", in: "header", name: "Authorization" }),
    });
    expect(platform.components.securitySchemes["Admin Key"].description).toContain("Bunvex <admin_key>");
    for (const item of Object.values<any>(platform.paths))
      for (const op of Object.values<any>(item)) expect(op.security).toEqual([{ "Admin Key": [] }]);
    // Convex's operations, but `get deployment info` (left out).
    expect(OPENAPI_OPERATIONS.map((op) => op.operationId)).toEqual([
      "update_environment_variables",
      "list_environment_variables",
      "list_audit_log_events",
      "get_current_usage",
      "list_usage_limits",
      "create_usage_limit",
      "update_usage_limit",
      "delete_usage_limit",
      "update_canonical_url",
      "get_canonical_urls",
      "list_log_streams",
      "get_log_stream",
      "delete_log_stream",
      "create_log_stream",
      "update_log_stream",
      "rotate_webhook_secret",
      "pause_deployment",
      "unpause_deployment",
      "data_sync",
      "list_active_syncs",
      "get_active_sync",
      "check_admin_key",
      "shapes2",
      "delete_tables",
      "delete_scheduled_functions_table",
      "public_query_get",
      "public_query_post",
      "public_get_query_ts",
      "public_query_at_ts_post",
      "public_query_batch_post",
      "public_mutation_post",
      "public_action_post",
      "public_function_post",
      "public_function_post_with_path",
    ]);
    expect(Object.keys((openApiDocument("public") as Doc).paths)).toContain("/run/{*functionIdentifier}");
    // bunvex's wire names (DV-278, DV-308).
    expect(platform.components.schemas.RequestDestination.enum).toEqual(["bunvexCloud", "bunvexSite"]);
    expect(platform.components.schemas.UsageLimitMetric.enum).toContain("actionComputeIsolateGbHours");
    for (const name of DOCS) expect(openApiText(name).toLowerCase()).not.toContain("convex");
  });

  test("a JSON snapshot of each document", () => {
    const dir = join(import.meta.dir, "fixtures", "openapi");
    for (const name of DOCS) {
      const file = join(dir, `${name}.json`);
      if (process.env.UPDATE_OPENAPI_SNAPSHOT) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, `${openApiText(name)}\n`);
      }
      expect(`${openApiText(name)}\n`).toBe(readFileSync(file, "utf8"));
    }
  });
});

// ---------------------------------------------------------------- the server

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: NAME, instanceSecret: SECRET },
  ).init();
  await engine.mutation((db) => db.insert("doomed", { x: 1 }));
  const functions = new Functions(engine).register("m", {
    echo: query((_ctx, { x }: { x: number }) => x),
    secret: internalQuery(() => "hidden"),
    fail: query(() => {
      throw new Error("nope");
    }),
    add: mutation(({ db }, { n }: { n: number }) => db.insert("items", { n })),
    shout: action((_ctx, { s }: { s: string }) => s.toUpperCase()),
  });
  const s = createServer({
    engine,
    functions,
    port: 0,
    // Never the real providers: a webhook's check gets a refusal.
    logSinks: { fetch: (async () => new Response(null, { status: 403 })) as unknown as typeof fetch },
  });
  stops.push(() => s.stop());
  await s.logSinksReady;
  return { engine, base: `http://127.0.0.1:${s.server.port}` };
}

const send = (base: string, path: string, init: { method?: string; body?: unknown; key?: string | null } = {}) =>
  fetch(`${base}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      ...(init.key === null ? {} : { authorization: `Bunvex ${init.key ?? KEY}` }),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

const isNoRoute = (status: number, text: string) => status === 404 && text.includes('"no route for ');

describe("served", () => {
  test("at Convex's three paths, with no auth, as pretty JSON text", async () => {
    const { base } = await setup();
    for (const name of DOCS) {
      const r = await send(base, OPENAPI_DOCS[name].url, { key: null });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      const text = await r.text();
      expect(text).toBe(JSON.stringify(openApiDocument(name), null, 2));
      expect(JSON.parse(text).paths).toBeDefined();
    }
    // A bad key does not matter either: nothing checks it.
    expect((await send(base, "/api/v1/openapi.json", { key: "nope" })).status).toBe(200);
    // HEAD has no body; another method is 405, as an axum `get` route; CORS as every `/api` route.
    const head = await fetch(`${base}/api/public_openapi.json`, { method: "HEAD" });
    expect([head.status, await head.text()]).toEqual([200, ""]);
    const post = await send(base, "/api/dashboard_openapi.json", { body: {} });
    expect([post.status, post.headers.get("allow")]).toEqual([405, "GET,HEAD"]);
    const cors = await fetch(`${base}/api/v1/openapi.json`, { headers: { origin: "https://app.example" } });
    expect(cors.headers.get("access-control-allow-origin")).toBe("https://app.example");
  });

  test("every documented route answers as documented", async () => {
    const { base } = await setup();
    const docs = Object.fromEntries(DOCS.map((d) => [d, openApiDocument(d) as Doc]));
    const called = new Set<string>();
    /** Call a documented route: the body must match its request schema, the answer its response schema. */
    const call = async (operationId: string, opts: { id?: string; query?: string; body?: unknown } = {}) => {
      const op = OPENAPI_OPERATIONS.find((o) => o.operationId === operationId) as ApiOperation;
      const doc = docs[op.doc]!;
      if (op.body) expect(schemaError(doc, { $ref: `#/components/schemas/${op.body}` }, opts.body)).toBeNull();
      const path = concretePath(op.doc, op.path, opts.id ?? "x");
      const r = await send(base, path + (opts.query ?? ""), { method: op.method.toUpperCase(), body: opts.body });
      const text = await r.text();
      if (r.status !== 200) throw new Error(`${operationId}: ${r.status} ${text}`);
      called.add(operationId);
      if (!op.response) return expect(text).toBe("");
      const value = JSON.parse(text);
      expect(schemaError(doc, op.response, value)).toBeNull();
      return value;
    };

    await call("update_environment_variables", { body: { changes: [{ name: "GREETING", value: "hi" }] } });
    expect((await call("list_environment_variables")).environmentVariables).toEqual({ GREETING: "hi" });
    await call("get_current_usage");
    const limit = (
      await call("create_usage_limit", {
        body: { metric: "functionCalls", window: "day", limitType: "warning", limit: 1_000_000, enabled: true },
      })
    ).usageLimit;
    await call("update_usage_limit", {
      id: limit.id,
      body: { metric: "functionCalls", window: "day", limitType: "warning", limit: 2_000_000, enabled: false },
    });
    expect((await call("list_usage_limits")).usageLimits).toHaveLength(1);
    await call("delete_usage_limit", { id: limit.id });
    await call("update_canonical_url", { body: { requestDestination: "bunvexCloud", url: "https://api.example.com" } });
    expect((await call("get_canonical_urls")).bunvexCloudUrl).toBe("https://api.example.com");
    const stream = await call("create_log_stream", {
      body: { logStreamType: "webhook", url: "https://hooks.example.com/in", format: "json" },
    });
    await call("create_log_stream", {
      body: { logStreamType: "datadog", siteLocation: "US1", ddApiKey: "k", ddTags: ["a:b"], service: null },
    });
    await call("update_log_stream", { id: stream.id, body: { logStreamType: "webhook", format: "jsonl" } });
    await call("rotate_webhook_secret", { id: stream.id });
    expect(await call("list_log_streams")).toHaveLength(2);
    await call("get_log_stream", { id: stream.id });
    await call("delete_log_stream", { id: stream.id });
    await call("pause_deployment");
    await call("unpause_deployment");
    const page = await call("data_sync", { body: { selection: { _other: "included" } } });
    await call("list_active_syncs", { query: "?limit=10" });
    await call("get_active_sync", { id: page.syncId });
    // Last, so it lists the events of every change above.
    const events = await call("list_audit_log_events", { query: "?from=0&limit=100" });
    expect(events.items.length).toBeGreaterThan(10);

    expect((await call("check_admin_key")).success).toBe(true);
    await call("shapes2");
    await call("delete_tables", { body: { tableNames: ["doomed"] } });
    await call("delete_scheduled_functions_table", { body: {} });

    expect(
      await call("public_query_get", { query: `?path=m:echo&args=${encodeURIComponent('{"x":1}')}&format=json` }),
    ).toEqual({ status: "success", value: 1 });
    expect(await call("public_query_post", { body: { path: "m:fail", args: {} } })).toMatchObject({
      status: "error",
    });
    const { ts } = await call("public_get_query_ts");
    await call("public_query_at_ts_post", { body: { path: "m:echo", args: { x: 2 }, ts } });
    expect(
      (await call("public_query_batch_post", { body: { queries: [{ path: "m:echo", args: { x: 3 } }] } })).results,
    ).toHaveLength(1);
    await call("public_mutation_post", { body: { path: "m:add", args: { n: 1 }, format: null } });
    await call("public_action_post", { body: { path: "m:shout", args: { s: "a" } } });
    expect(await call("public_function_post", { body: { path: "m:secret", args: {} } })).toMatchObject({
      value: "hidden",
    });
    expect(await call("public_function_post_with_path", { id: "m/echo", body: { args: { x: 4 } } })).toMatchObject({
      value: 4,
    });

    expect([...called].sort()).toEqual(OPENAPI_OPERATIONS.map((op) => op.operationId).sort());
  });

  test("the platform scheme is the server's: an admin key, not a user's token", async () => {
    const { base } = await setup();
    const path = "/api/v1/list_environment_variables";
    expect((await send(base, path)).status).toBe(200);
    expect((await fetch(`${base}${path}`, { headers: { authorization: `bunvex ${KEY}` } })).status).toBe(200);
    expect((await send(base, path, { key: null })).status).not.toBe(200);
    expect((await fetch(`${base}${path}`, { headers: { authorization: "Bearer abc" } })).status).not.toBe(200);
  });

  test("Convex's routes left out, and any undocumented /api/v1/ path, are 404", async () => {
    const { base } = await setup();
    for (const r of OPENAPI_LEFT_OUT) {
      expect(OPENAPI_OPERATIONS.some((op) => op.doc === r.doc && op.path === r.path)).toBe(false);
      const res = await send(base, concretePath(r.doc, r.path), {
        method: r.method.toUpperCase(),
        ...(r.method === "post" ? { body: {} } : {}),
      });
      expect(isNoRoute(res.status, await res.text())).toBe(true);
    }
    for (const path of ["/api/v1/nope", "/api/v1/list_log_streams/x", "/api/v1/data/sync/a/b", "/api/v1/"]) {
      expect(isPlatformPath(path)).toBe(false);
      const res = await send(base, path);
      expect(isNoRoute(res.status, await res.text())).toBe(true);
    }
    expect(isPlatformPath("/api/v1/data/sync/abc")).toBe(true);
    expect(isPlatformPath("/api/v1/openapi.json")).toBe(true);
  });
});

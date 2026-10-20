// HTTP mounts (STUDY-157 PR 4): Convex's Rust cases (crates/application/src/tests/http_action.rs at bea52bde0, with
// the component-tests projects `http_mount_routing`, `http_prefix_and_mount_routing` and `http_no_prefix_mounting`)
// rewritten for bunvex. A child's `http.js` mounted under a prefix, a grandchild under its parent's, the app's own
// `httpPrefix`, the catch-alls, the site URL with the prefix, and no user identity in a component's HTTP action.
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
import { type HttpNode, routeHttp } from "../src/http-actions.ts";
import { HttpRouter, httpActionGeneric } from "../src/router.ts";
import { createServer } from "../src/server.ts";

const SECRET = "ab".repeat(32);
const NAME = "component-http-test";
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
const route = (path: string, body: string, method = "GET") =>
  `http.route({ path: ${JSON.stringify(path)}, method: ${JSON.stringify(method)}, handler: httpAction(${body}) });`;

/** The app's definition: `httpComponent` mounted as `use` says, the app's own options as given. */
const appDefinition = (appOptions: string, useOptions: string) =>
  mod("bunvex.config.js", [
    'import { defineApp } from "bunvex/server";',
    `import httpComponent from "${dep("httpComponent")}";`,
    `const app = defineApp(${appOptions});`,
    `app.use(httpComponent${useOptions});`,
    "export default app;",
  ]);
const SCHEMA = mod("schema.js", ['import { defineSchema } from "bunvex/server";', "export default defineSchema({});"]);
const httpModule = (lines: string[]) =>
  mod("http.js", [
    'import { componentsGeneric, httpActionGeneric as httpAction, httpRouter } from "bunvex/server";',
    "const components = componentsGeneric();",
    "const http = httpRouter();",
    ...lines,
    "export default http;",
  ]);
/** Who the action runs as: the identity's subject, or the token's error. */
const WHOAMI =
  "async (ctx) => { try { return new Response(String((await ctx.auth.getUserIdentity())?.subject ?? null)); } catch (e) { return new Response('error: ' + e.message, { status: 401 }); } }";

// `http_mount_routing`'s app: a catch-all of its own.
const MOUNT_APP_HTTP = httpModule([
  'http.route({ pathPrefix: "/", method: "GET", handler: httpAction(async () => new Response("app custom 404", { status: 404 })) });',
  route("/whoami", WHOAMI),
]);
// `http_prefix_and_mount_routing`'s app: an echo under its prefix.
const PREFIX_APP_HTTP = httpModule([
  route("/echo", "async (_ctx, request) => new Response(await request.text())", "POST"),
]);

const HTTP_COMPONENT = {
  definitionPath: "httpComponent",
  definition: mod("bunvex.config.js", [
    'import { defineComponent } from "bunvex/server";',
    `import httpGrandchild from "${dep("httpGrandchild")}";`,
    'const component = defineComponent("httpComponent");',
    'component.use(httpGrandchild, { name: "httpGrandchild", httpPrefix: "/gc/" });',
    "export default component;",
  ]),
  dependencies: ["httpGrandchild"],
  schema: SCHEMA,
  functions: [
    httpModule([
      route("/hello", 'async () => new Response("hello from component")'),
      route("/site-url", 'async () => new Response(process.env.BUNVEX_SITE_URL ?? "not set")'),
      route(
        "/grandchild-greeting",
        "async (ctx) => new Response(await ctx.runQuery(components.httpGrandchild.public.greeting, {}))",
      ),
      route("/whoami", WHOAMI),
    ]),
  ],
  udfServerVersion: "1.46.0",
};
const HTTP_GRANDCHILD = {
  definitionPath: "httpGrandchild",
  definition: mod("bunvex.config.js", [
    'import { defineComponent } from "bunvex/server";',
    'export default defineComponent("httpGrandchild");',
  ]),
  dependencies: [] as string[],
  schema: SCHEMA,
  functions: [
    httpModule([
      route("/grandchild-hello", 'async () => new Response("hello from grandchild component")'),
      route("/site-url", "async () => new Response(process.env.BUNVEX_SITE_URL)"),
      'http.route({ pathPrefix: "/", method: "GET", handler: httpAction(async () => new Response("grandchild custom 404", { status: 404 })) });',
    ]),
    mod("public.js", [
      'import { query } from "bunvex/server";',
      'export const greeting = query({ args: {}, handler: async () => "hello from grandchild query" });',
    ]),
  ],
  udfServerVersion: "1.46.0",
};

/** A deployment of one of Convex's projects: the app's definition and `http.js` (none: no module). */
async function deployment(definition: ModuleSource, appHttp: ModuleSource | null) {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-component-http-"));
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
  const post = async (path: string, body: object) => {
    const r = await fetch(`${api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bunvex ${KEY}` },
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
      definition,
      dependencies: ["httpComponent"],
      schema: SCHEMA,
      changedModules: appHttp ? [appHttp] : [],
      unchangedModuleHashes: [],
      udfServerVersion: "1.46.0",
    },
    componentDefinitions: [HTTP_COMPONENT, HTTP_GRANDCHILD],
  });
  if (start.status !== 200) throw new Error(JSON.stringify(start.body));
  await post("/api/deploy2/wait_for_schema", {
    adminKey: KEY,
    schemaChange: start.body!.schemaChange,
    timeoutMs: 5000,
  });
  const finish = await post("/api/deploy2/finish_push", { adminKey: KEY, startPush: start.body, dryRun: false });
  if (finish.status !== 200) throw new Error(JSON.stringify(finish.body));
  /** An HTTP action request on the API port (`/http/...`): its status and body. */
  const get = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${api}/http${path}`, init);
    return { status: r.status, body: await r.text() };
  };
  return { api, get, post };
}

const DISABLED = "This bunvex deployment does not have HTTP actions enabled.";

describe("http_mount_routing: the component mounted at /api/, its grandchild at /gc/ under it", () => {
  const mounted = () => deployment(appDefinition("", ', { httpPrefix: "/api/" }'), MOUNT_APP_HTTP);

  test("a request under the mount reaches the child's route; outside it, the app's catch-all", async () => {
    const d = await mounted();
    expect(await d.get("/api/hello")).toEqual({ status: 200, body: "hello from component" });
    // test_http_mount_no_route_outside_mount, test_http_app_catch_all_handles_unmatched_routes
    expect(await d.get("/hello")).toEqual({ status: 404, body: "app custom 404" });
    expect(await d.get("/nonexistent")).toEqual({ status: 404, body: "app custom 404" });
  });

  test("the child's site URL carries its mount", async () => {
    const d = await mounted();
    expect((await d.get("/api/site-url")).body).toMatch(/^https?:\/\/[^/]+(?:\/http)?\/api$/);
    expect((await d.get("/api/gc/site-url")).body).toMatch(/^https?:\/\/[^/]+(?:\/http)?\/api\/gc$/);
  });

  test("a grandchild: reached through its parent's mount only, its own catch-all answering under it", async () => {
    const d = await mounted();
    expect(await d.get("/api/gc/grandchild-hello")).toEqual({ status: 200, body: "hello from grandchild component" });
    // test_http_grandchild_routes_not_mounted_outside_of_tree
    for (const path of ["/api/grandchild-hello", "/grandchild-hello"]) expect((await d.get(path)).status).toBe(404);
    // test_http_grandchild_catch_all_handles_unmatched_routes
    expect(await d.get("/api/gc/nonexistent")).toEqual({ status: 404, body: "grandchild custom 404" });
    // test_http_grandchild_explicitly_exposed_via_parent: the child's action calls its child's query.
    expect(await d.get("/api/grandchild-greeting")).toEqual({ status: 200, body: "hello from grandchild query" });
  });

  test("an unmatched path under the mount is the child's 404, not the app's catch-all", async () => {
    const d = await mounted();
    expect(await d.get("/api/nonexistent")).toEqual({ status: 404, body: "No matching routes found" });
  });

  test("the app's action sees a token's error; a component's action runs with no identity", async () => {
    const d = await mounted();
    const bad = { headers: { authorization: "Bearer not-a-token" } };
    const app = await d.get("/whoami", bad);
    expect(app.status).toBe(401);
    expect(app.body).toStartWith("error: ");
    // test_http_component_action_cannot_access_auth
    expect(await d.get("/api/whoami", bad)).toEqual({ status: 200, body: "null" });
  });
});

describe("http_prefix_and_mount_routing: the app's http.js under /api/, the component at /", () => {
  const prefixed = () => deployment(appDefinition('{ httpPrefix: "/api/" }', ', { httpPrefix: "/" }'), PREFIX_APP_HTTP);

  test("the app's route after its prefix; the child's at the root, its site URL the deployment's", async () => {
    const d = await prefixed();
    expect(await d.get("/api/echo", { method: "POST", body: "hello app" })).toEqual({ status: 200, body: "hello app" });
    expect(await d.get("/hello")).toEqual({ status: 200, body: "hello from component" });
    expect((await d.get("/site-url")).body).toMatch(/^https?:\/\/[^/]+(?:\/http)?$/);
  });
});

describe("http_no_prefix_mounting: the component used without a prefix", () => {
  test("its routes and its grandchild's are unreachable", async () => {
    const d = await deployment(appDefinition("", ""), null);
    // test_http_no_prefix_component_routes_not_accessible, test_http_no_prefix_grandchild_routes_not_accessible
    for (const path of ["/hello", "/gc/grandchild-hello", "/api/gc/grandchild-hello"])
      expect(await d.get(path)).toEqual({ status: 404, body: DISABLED });
  });

  test("a component's apiSpec lists its own routes", async () => {
    const d = await deployment(appDefinition("", ""), null);
    const list = await d.post("/api/query", { path: "_system/frontend/components:list", args: {}, format: "json" });
    const id = (list.body!.value as { id: string; path: string }[]).find((c) => c.path === "httpComponent")!.id;
    const spec = await d.post("/api/query", {
      path: "_system/cli/modules:apiSpec",
      args: { componentId: id },
      format: "json",
    });
    expect(
      (spec.body!.value as { functionType: string; method?: string; path?: string }[])
        .filter((e) => e.functionType === "HttpAction")
        .map((e) => `${e.method} ${e.path}`),
    ).toEqual(["GET /grandchild-greeting", "GET /hello", "GET /site-url", "GET /whoami"]);
  });
});

describe("routeHttp, as Convex's route_http_action", () => {
  const ok = httpActionGeneric(async () => new Response("ok"));
  const router = (routes: ({ path: string } | { pathPrefix: string })[]) => {
    const r = new HttpRouter();
    for (const spec of routes) r.route({ ...spec, method: "GET", handler: ok });
    return r;
  };
  const child: HttpNode = { router: router([{ path: "/x" }]), mounts: [], children: new Map() };
  const app = (routes: ({ path: string } | { pathPrefix: string })[], prefix: string | null = null) => ({
    router: router(routes),
    prefix,
    mounts: [["/m/", "c"]] as [string, string][],
    children: new Map([["c", child]]),
  });
  const where = (r: ReturnType<typeof routeHttp>) => r && [r.node === child ? "child" : "app", r.path];

  test("an exact route of http.js wins over a mount", () => {
    expect(where(routeHttp(app([{ path: "/m/x" }]), "/m/x", "GET"))).toEqual(["app", "/m/x"]);
  });

  test("the longest prefix wins, between http.js's prefix routes and the mounts", () => {
    expect(where(routeHttp(app([{ pathPrefix: "/m/deeper/" }]), "/m/deeper/x", "GET"))).toEqual(["app", "/m/deeper/x"]);
    expect(where(routeHttp(app([{ pathPrefix: "/" }]), "/m/x", "GET"))).toEqual(["child", "/x"]);
  });

  test("a tie goes to the mount (compared after it, as Convex's loop does)", () => {
    expect(where(routeHttp(app([{ pathPrefix: "/m/" }]), "/m/x", "GET"))).toEqual(["child", "/x"]);
  });

  test("the app's prefix is stripped for its http.js only; mounts match the whole path", () => {
    expect(where(routeHttp(app([{ path: "/x" }], "/api/"), "/api/x", "GET"))).toEqual(["app", "/x"]);
    expect(where(routeHttp(app([{ path: "/x" }], "/api/"), "/m/x", "GET"))).toEqual(["child", "/x"]);
    // Outside the prefix and every mount: nothing can answer.
    expect(routeHttp(app([{ path: "/x" }], "/api/"), "/x", "GET")).toBeNull();
  });

  test("HEAD routes as GET", () => {
    expect(where(routeHttp(app([]), "/m/x", "HEAD"))).toEqual(["child", "/x"]);
  });
});

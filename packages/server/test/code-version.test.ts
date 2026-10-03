// Code versions (STUDY-35): a push's modules loaded into their own `vm` context, analyzed as Convex's
// `analyze`, installed atomically, re-running exactly the subscriptions of changed modules, and freed once
// superseded.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { CodeVersion, InvalidModulesError, type ModuleSource } from "../src/code-version.ts";
import { Functions } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { add, history, syncUrl, v1Client } from "./v1-client.ts";

const SEED = Uint32Array.of(1, 2, 3, 4);
const AT = 1_700_000_000_000;
const load = (modules: ModuleSource[], opts: Partial<Parameters<typeof CodeVersion.load>[1]> = {}) =>
  CodeVersion.load(modules, { seed: SEED, timestamp: AT, ...opts });
const mod = (path: string, source: string, environment: "isolate" | "node" = "isolate"): ModuleSource => ({
  path,
  source,
  environment,
});
const failure = async (p: Promise<unknown>) =>
  p.then(
    () => "loaded",
    (e) =>
      e instanceof InvalidModulesError
        ? e.message
            .split("\n")
            .slice(1)
            .filter((l) => !/^\s+at /.test(l))
            .join("\n")
        : `other: ${e}`,
  );

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function server() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine);
  const s = createServer({ engine, functions, port: 0, redactLogsToClient: false });
  stops.push(s.stop);
  const api = `http://127.0.0.1:${s.server.port}`;
  const call = async (kind: string, path: string, args: object = {}) =>
    (await (
      await fetch(`${api}/api/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args, format: "convex_encoded_json" }),
      })
    ).json()) as { status: string; value?: unknown; errorMessage?: string; errorData?: unknown };
  return { engine, functions, s, api, call };
}

const APP_V1 = [
  mod(
    "messages.js",
    `import { query, mutation, internalQuery } from "@bunvex/server";
     import { v } from "@bunvex/values";
     export const list = query({ args: { tag: v.optional(v.string()) }, handler: async ({ db }) => (await db.query("items").collect()).map((d) => d.text) });
     export const add = mutation({ args: { text: v.string() }, returns: v.id("items"), handler: async ({ db }, { text }) => db.insert("items", { text, nested: [{ a: 1 }], bytes: new Uint8Array([1, 2]).buffer }) });
     export const secret = internalQuery(async () => "s");
     export const notAFunction = 42;`,
  ),
  mod("dir/other.js", `import { query } from "@bunvex/server"; export default query(async () => "other v1");`),
];

describe("loading and analysis", () => {
  test("functions are analyzed as Convex's AnalyzedModule; registry keys are module:name", async () => {
    const version = await load(APP_V1);
    expect([...version.functions.keys()].sort()).toEqual([
      "dir/other:default",
      "messages:add",
      "messages:list",
      "messages:secret",
    ]);
    const m = version.analysis["messages.js"]!;
    expect(m.functions.map((f) => [f.name, f.udfType, f.visibility.kind])).toEqual([
      ["add", "Mutation", "public"],
      ["list", "Query", "public"],
      ["secret", "Query", "internal"],
    ]);
    expect(JSON.parse(m.functions.find((f) => f.name === "list")!.args)).toEqual({
      type: "object",
      value: { tag: { fieldType: { type: "string" }, optional: true } },
    });
    expect(JSON.parse(m.functions.find((f) => f.name === "add")!.returns)).toEqual({ type: "id", tableName: "items" });
    expect(JSON.parse(m.functions.find((f) => f.name === "secret")!.args)).toEqual({ type: "any" });
    expect(version.moduleHashes.get("messages")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the umbrella's specifiers link to the same server modules", async () => {
    const umbrella = ["bunvex", "server"].join("/");
    const version = await load([
      mod("u.js", `import { query } from "${umbrella}"; export const q = query(async () => 1);`),
    ]);
    expect(version.functions.has("u:q")).toBe(true);
  });

  test("a real bundle: Bun.build with splitting, bunvex/* external, shared chunks linked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bunvex-app-"));
    dirs.push(dir);
    mkdirSync(join(dir, "lib"));
    writeFileSync(join(dir, "lib", "shared.ts"), `export const greet = (n: string) => "hello " + n;`);
    writeFileSync(
      join(dir, "a.ts"),
      `import { query } from "@bunvex/server"; import { greet } from "./lib/shared"; export const hi = query(async () => greet("a"));`,
    );
    writeFileSync(
      join(dir, "b.ts"),
      `import { query } from "@bunvex/server"; import { greet } from "./lib/shared"; export const hi = query(async () => greet("b"));`,
    );
    const out = await Bun.build({
      entrypoints: [join(dir, "a.ts"), join(dir, "b.ts")],
      root: dir,
      splitting: true,
      format: "esm",
      target: "browser",
      external: ["@bunvex/*"],
      naming: { entry: "[dir]/[name].js", chunk: "_deps/[hash].js" },
    });
    expect(out.success).toBe(true);
    const modules = await Promise.all(
      out.outputs.map(async (o) => mod(o.path.replace(/^\.\//, "").replace(`${dir}/`, ""), await o.text())),
    );
    expect(modules.some((m) => m.path.startsWith("_deps/"))).toBe(true);
    const version = await load(modules);
    const { functions, call } = await server();
    functions.install(version.functions, version.moduleHashes);
    expect((await call("query", "a:hi")).value).toBe("hello a");
    expect((await call("query", "b:hi")).value).toBe("hello b");
  });

  test('imports: only bunvex/*, the bundle\'s own modules, and builtins in "use node" files', async () => {
    expect(await failure(load([mod("x.js", `import _ from "lodash"; export const a = 1;`)]))).toBe(
      `Failed to analyze x.js: Could not resolve "lodash"`,
    );
    expect(await failure(load([mod("x.js", `import "./missing.js";`)]))).toMatch(/Could not resolve "\.\/missing\.js"/);
    expect(await failure(load([mod("x.js", `import fs from "node:fs"; export const a = fs;`)]))).toBe(
      `Failed to analyze x.js: "node:fs" is only available in "use node" files`,
    );
    const node = await load([
      mod(
        "n.js",
        `import { action } from "@bunvex/server"; import { readFileSync } from "node:fs"; export const read = action(async () => typeof readFileSync);`,
        "node",
      ),
    ]);
    expect(node.functions.has("n:read")).toBe(true);
    expect(
      await failure(
        load([mod("n.js", `import { query } from "@bunvex/server"; export const q = query(async () => 1);`, "node")]),
      ),
    ).toBe(`Failed to analyze n.js: \`q\` is a query, but "use node" files may only define actions`);
    expect(await failure(load([mod("a.js", `import "./b.js";`), mod("b.js", `export const x = 1;`, "node")]))).toMatch(
      /runs in the other runtime/,
    );
  });

  test("the import phase: deterministic Math.random and Date.now, no fetch, timers or randomness, a time limit", async () => {
    const src = `export const r = Math.random(); export const t = Date.now(); export const p = performance.now(); export const d = new Date().getTime();`;
    const a = await load([mod("m.js", src)]);
    const b = await load([mod("m.js", src)]);
    const ns = (x: CodeVersion) => x.modules.get("m.js")!.module.namespace as Record<string, number>;
    expect(ns(a).r).toBe(ns(b).r);
    expect([ns(a).t, ns(a).d, ns(a).p]).toEqual([AT, AT, 0]);
    expect(ns(await load([mod("m.js", src)], { seed: Uint32Array.of(9, 9, 9, 9) })).r).not.toBe(ns(a).r);
    expect(await failure(load([mod("m.js", `await fetch("http://127.0.0.1:1/");`)]))).toBe(
      "Failed to analyze m.js: Uncaught Error: fetch() unsupported at import time",
    );
    // As Convex (STUDY-66 §4): a timer returns, then fails the import; getRandomValues and randomUUID use the
    // seeded PRNG; crypto.subtle's randomness is refused.
    expect(await failure(load([mod("m.js", `try { setTimeout(() => {}, 1); } catch {}`)]))).toBe(
      "Failed to analyze m.js: Uncaught Error: setTimeout unsupported at import time",
    );
    const rand = `export const b = [...crypto.getRandomValues(new Uint8Array(4))]; export const u = crypto.randomUUID();`;
    const [ra, rb] = [await load([mod("m.js", rand)]), await load([mod("m.js", rand)])];
    expect(ra.modules.get("m.js")!.module.namespace).toEqual(rb.modules.get("m.js")!.module.namespace);
    expect(
      await failure(
        load([mod("m.js", `await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign"]);`)]),
      ),
    ).toBe("Failed to analyze m.js: Uncaught Error: Cannot use cryptographic randomness at import time");
    expect(await failure(load([mod("m.js", `throw new TypeError("bad module");`)]))).toBe(
      "Failed to analyze m.js: Uncaught TypeError: bad module",
    );
    // The frames are the app's only, not the server's.
    const full = await load([mod("m.js", `\nfunction f() { throw new Error("deep"); }\nf();`)]).catch(
      (e: Error) => e.message,
    );
    expect(full).toMatch(/at f \(m\.js:2:\d+\)/);
    expect(full).not.toMatch(/determinism\.ts|code-version\.ts|node:vm/);
    const t0 = performance.now();
    expect(await failure(load([mod("m.js", `while (true) {}`)], { importTimeoutMs: 200 }))).toMatch(/timed out/);
    expect(performance.now() - t0).toBeLessThan(2000);
    // The server's own globals are untouched by a context's determinism.
    expect(Date.now()).toBeGreaterThan(AT);
  });

  test("http.js and crons.js: their default exports, checked as Convex's", async () => {
    const http = `import { httpRouter, httpAction } from "@bunvex/server"; const h = httpRouter(); h.route({ path: "/hi", method: "GET", handler: httpAction(async () => new Response("hi")) }); export default h;`;
    const v1 = await load([mod("http.js", http)]);
    expect(v1.analysis["http.js"]!.httpRoutes).toEqual([{ path: "/hi", method: "GET" }]);
    expect(await failure(load([mod("http.js", `export const a = 1;`)]))).toBe(
      "Failed to analyze http.js: `http.js` must have a default export of a Router.",
    );
    expect(await failure(load([mod("http.js", `export default 1;`)]))).toBe(
      "Failed to analyze http.js: The default export of `http.js` is not a Router.",
    );
    const crons = (target: string) =>
      mod(
        "crons.js",
        `import { cronJobs } from "@bunvex/server"; const c = cronJobs(); c.interval("tick", { minutes: 5 }, "${target}"); export default c;`,
      );
    const jobs = mod(
      "jobs.js",
      `import { internalMutation, query } from "@bunvex/server"; export const tick = internalMutation(async () => {}); export const look = query(async () => 1);`,
    );
    const ok = await load([jobs, crons("jobs:tick")]);
    expect(ok.analysis["crons.js"]!.cronSpecs!.tick!.udfPath).toBe("jobs.js:tick");
    expect(await failure(load([jobs, crons("jobs:nope")]))).toBe(
      "The cron job 'tick' schedules a function that does not exist: jobs.js:nope",
    );
    expect(await failure(load([jobs, crons("jobs:look")]))).toMatch(/schedules a query function/);
    expect(await failure(load([mod("crons.js", `export default {};`)]))).toBe(
      "Failed to analyze crons.js: The default export of `crons.js` is not a Crons object.",
    );
  });
});

describe("running a code version", () => {
  test("values cross the context boundary: objects, arrays, bytes, errors", async () => {
    const { functions, call } = await server();
    const version = await load([
      ...APP_V1,
      mod(
        "edge.js",
        `import { query } from "@bunvex/server"; import { BunvexError, v } from "@bunvex/values";
         export const shapes = query(async () => ({ list: [1, { a: [2] }], bytes: new Uint8Array([7]).buffer, n: 1n }));
         export const fails = query(async () => { throw new BunvexError({ code: 42 }); });
         export const throws = query(async () => { throw new RangeError("out of range"); });
         export const time = query(async () => [Date.now() === new Date().getTime(), typeof Math.random()]);
         export const fetches = query(async () => fetch("http://127.0.0.1:1/"));
         export const bytesArg = query({ args: { b: v.bytes() }, handler: async (_c, { b }) => b.byteLength });`,
      ),
    ]);
    functions.install(version.functions, version.moduleHashes);
    expect((await call("mutation", "messages:add", { text: "one" })).status).toBe("success");
    expect((await call("query", "messages:list")).value).toEqual(["one"]);
    expect((await call("query", "edge:shapes")).value).toEqual({
      list: [1, { a: [2] }],
      bytes: { $bytes: "Bw==" },
      n: { $integer: "AQAAAAAAAAA=" },
    });
    expect(await call("query", "edge:fails")).toMatchObject({ status: "error", errorData: { code: 42 } });
    expect((await call("query", "edge:throws")).errorMessage).toContain("Uncaught RangeError: out of range");
    expect((await call("query", "edge:time")).value).toEqual([true, "number"]);
    expect((await call("query", "edge:fetches")).errorMessage).toContain("Can't use fetch() in queries");
    expect((await call("query", "edge:bytesArg", { b: { $bytes: "AQID" } })).value).toBe(3);
  });

  test("installing a version: every function at once; internal ones stay internal", async () => {
    const { functions, call } = await server();
    const version = await load(APP_V1);
    const changed = functions.install(version.functions, version.moduleHashes);
    expect([...changed].sort()).toEqual(["dir/other", "messages"]);
    expect((await call("query", "dir/other")).value).toBe("other v1");
    expect((await call("query", "messages:secret")).errorMessage).toContain("Could not find public function");
    const v2 = await load([
      APP_V1[0]!,
      mod("dir/other.js", `import { query } from "@bunvex/server"; export default query(async () => "other v2");`),
    ]);
    expect([...functions.install(v2.functions, v2.moduleHashes)]).toEqual(["dir/other"]);
    expect((await call("query", "dir/other")).value).toBe("other v2");
    const v3 = await load([APP_V1[0]!]);
    expect([...functions.install(v3.functions, v3.moduleHashes)]).toEqual(["dir/other"]);
    expect((await call("query", "dir/other")).errorMessage).toContain("Could not find public function");
  });

  test("a push re-runs exactly the subscriptions of changed modules; the cache serves the new code", async () => {
    const { s, call } = await server();
    const other = (n: number) =>
      mod("dir/other.js", `import { query } from "@bunvex/server"; export default query(async () => "other v${n}");`);
    await s.installCodeVersion(await load([APP_V1[0]!, other(1)]));
    expect((await call("query", "dir/other")).value).toBe("other v1"); // cached
    const c = await v1Client(syncUrl(s.server.port));
    c.modify([add(1, "dir/other"), add(2, "messages:list")]);
    await c.until(() => history(c.transitions(), 2).length);
    const executions = s.sync.stats.executions;
    await s.installCodeVersion(await load([APP_V1[0]!, other(2)]));
    await c.until(() => history(c.transitions(), 1).length === 2);
    expect(history(c.transitions(), 1)).toEqual(["other v1", "other v2"]);
    expect(history(c.transitions(), 2)).toEqual([[]]);
    expect(s.sync.stats.executions - executions).toBe(1); // only dir/other ran again
    expect((await call("query", "dir/other")).value).toBe("other v2");
  });

  test("http.js and crons.js go live with the version", async () => {
    const { s, engine } = await server();
    const http = (text: string) =>
      mod(
        "http.js",
        `import { httpRouter, httpAction } from "@bunvex/server"; const h = httpRouter(); h.route({ path: "/hi", method: "GET", handler: httpAction(async () => new Response("${text}")) }); export default h;`,
      );
    const jobs = mod(
      "jobs.js",
      `import { internalMutation } from "@bunvex/server"; export const tick = internalMutation(async () => {});`,
    );
    const crons = mod(
      "crons.js",
      `import { cronJobs } from "@bunvex/server"; const c = cronJobs(); c.interval("tick", { minutes: 5 }, "jobs:tick"); export default c;`,
    );
    const r1 = await s.installCodeVersion(await load([http("v1"), jobs, crons]));
    expect(r1.crons).toMatchObject({ added: ["tick"] });
    expect(await (await fetch(`http://127.0.0.1:${s.server.port}/http/hi`)).text()).toBe("v1");
    const r2 = await s.installCodeVersion(await load([http("v2"), jobs]));
    expect(r2.crons).toMatchObject({ deleted: ["tick"] });
    expect(await (await fetch(`http://127.0.0.1:${s.server.port}/http/hi`)).text()).toBe("v2");
    expect((await engine.query((db) => db.system.query("_scheduled_functions").collect())).length).toBe(0);
  });

  test("a request in flight finishes on the code it started with", async () => {
    let release!: () => void;
    const gate = new Promise<void>((ok) => {
      release = ok;
    });
    const hold = Bun.serve({ port: 0, fetch: async () => (await gate, new Response("done")) });
    stops.push(() => hold.stop(true));
    const { s, call } = await server();
    const act = (n: number) =>
      mod(
        "slow.js",
        `import { action } from "@bunvex/server"; export const run = action(async () => (await (await fetch("http://127.0.0.1:${hold.port}/")).text()) + " v${n}");`,
      );
    await s.installCodeVersion(await load([act(1)]));
    const inFlight = call("action", "slow:run");
    await Bun.sleep(50);
    await s.installCodeVersion(await load([act(2)]));
    release();
    expect((await inFlight).value).toBe("done v1");
    expect((await call("action", "slow:run")).value).toBe("done v2");
  });

  test("a superseded version is collected", async () => {
    const { s } = await server();
    const refs: WeakRef<object>[] = [];
    for (let i = 0; i < 5; i++) {
      const version = await load([
        mod(
          "m.js",
          `import { query } from "@bunvex/server"; export const q = query(async () => ${i}); export const big = "x".repeat(1 << 20);`,
        ),
      ]);
      refs.push(new WeakRef(version.modules.get("m.js")!.module.namespace as object));
      await s.installCodeVersion(version);
    }
    for (let i = 0; i < 20 && refs.slice(0, 4).some((r) => r.deref()); i++) {
      Bun.gc(true);
      await Bun.sleep(10);
    }
    expect(refs.slice(0, 4).map((r) => r.deref() === undefined)).toEqual([true, true, true, true]);
    expect(refs[4]!.deref()).toBeDefined();
  });
});

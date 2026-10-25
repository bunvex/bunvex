// Components under the function sandbox (STUDY-171 §15): `vm` against `process` with each component instance in the
// app's child (`shared`, what the executor does) and in a child of its own (`own`, the alternative), for an app that
// mounts the same component N times. The lines:
//
// - the latency of a call into a component, from the app's query, mutation and action, in-process through
//   `Functions` (no HTTP), one at a time; and of a component's HTTP route, over HTTP;
// - the time a push takes (start_push, wait_for_schema, finish_push over HTTP: the definitions analyzed, the
//   instances loaded and installed), the first and the later ones;
// - the time a restart takes to serve the deployed code (`codeReady`: the app's version and every instance loaded);
// - memory: the server's and its children's resident set and proportional set (Linux `smaps_rollup`) once the
//   calls have run.
//
//   bun packages/sandbox/bench/components.ts [instances=1,4,16] [calls=1000] [pushes=5] [--json]
//     [--modes=vm,shared,own]
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { adminKeyCipherKey, createServer, Functions, issueAdminKey } from "@bunvex/server";
import { provideProcessExecutor } from "@bunvex/server/executor";
import { type ComponentChildren, ProcessExecutor } from "../src/executor.ts";
import { TestBlobs } from "../test/fixtures/blobs.ts";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const JSON_OUT = process.argv.includes("--json");
const MODES = (process.argv.find((a) => a.startsWith("--modes="))?.slice(8) ?? "vm,shared,own").split(",") as Mode[];
const INSTANCES = (args[0] ?? "1,4,16").split(",").map(Number);
const CALLS = Number(args[1] ?? 1000);
const PUSHES = Number(args[2] ?? 5);
type Mode = "vm" | ComponentChildren;

let components: ComponentChildren = "shared";
const executors: ProcessExecutor[] = [];
provideProcessExecutor(() => {
  const e = new ProcessExecutor({ components });
  executors.push(e);
  return e;
});

const SECRET = "be".repeat(32);
const NAME = "component-bench";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
const SERVER = JSON.stringify(["bunvex", "server"].join("/"));
const VALUES = JSON.stringify(["bunvex", "values"].join("/"));
const mod = (path: string, source: string) => ({ path, source, environment: "isolate" as const });
const dep = (path: string) => `./_componentDeps/${Buffer.from(path).toString("base64url")}`;

const definition = (n: number) =>
  mod(
    "bunvex.config.js",
    `import { defineApp } from ${SERVER};
import counter from ${JSON.stringify(dep("counter"))};
const app = defineApp();
${Array.from({ length: n }, (_, i) => `app.use(counter, { name: "c${i}"${i === 0 ? ', httpPrefix: "/c/"' : ""} });`).join("\n")}
export default app;`,
  );
const APP = mod(
  "app.js",
  `import { action, componentsGeneric, mutation, query } from ${SERVER};
import { v } from ${VALUES};
const c = componentsGeneric().c0.lib;
export const empty = query({ args: { i: v.number() }, handler: async (ctx, { i }) => i });
export const into = query({ args: { i: v.number() }, handler: async (ctx, { i }) => ctx.runQuery(c.echo, { i }) });
export const into10 = query({ args: { i: v.number() }, handler: async (ctx, { i }) => { let s = 0; for (let k = 0; k < 10; k++) s += await ctx.runQuery(c.echo, { i: k }); return s + i; } });
export const write = mutation({ args: { i: v.number() }, handler: async (ctx, { i }) => ctx.runMutation(c.add, { i }) });
export const fromAction = action({ args: { i: v.number() }, handler: async (ctx, { i }) => ctx.runQuery(c.echo, { i }) });
`,
);
const COUNTER = {
  definitionPath: "counter",
  definition: mod(
    "bunvex.config.js",
    `import { defineComponent } from ${SERVER};\nexport default defineComponent("counter");`,
  ),
  dependencies: [] as string[],
  schema: mod(
    "schema.js",
    `import { defineSchema, defineTable } from ${SERVER};\nimport { v } from ${VALUES};\nexport default defineSchema({ items: defineTable({ i: v.number() }) });`,
  ),
  functions: [
    mod(
      "lib.js",
      `import { mutation, query } from ${SERVER};
import { v } from ${VALUES};
export const echo = query({ args: { i: v.number() }, handler: async (ctx, { i }) => i });
export const add = mutation({ args: { i: v.number() }, handler: async (ctx, { i }) => { await ctx.db.insert("items", { i }); return i; } });
`,
    ),
    mod(
      "http.js",
      `import { httpActionGeneric as httpAction, httpRouter } from ${SERVER};
const http = httpRouter();
http.route({ path: "/hello", method: "GET", handler: httpAction(async () => new Response("hello")) });
export default http;
`,
    ),
  ],
  udfServerVersion: "1.46.0",
};

const q = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;
const median = (xs: number[]) => q(xs, 0.5);

/** A process's resident and proportional set, in MiB (`smaps_rollup`, Linux; `ps` elsewhere, no PSS). */
function memory(pid: number): { rss: number; pss: number | null } {
  try {
    const t = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(t)?.[1] ?? 0);
    return { rss: kb("Rss") / 1024, pss: kb("Pss") / 1024 };
  } catch {
    const out = new TextDecoder().decode(Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)]).stdout).trim();
    return { rss: Number(out) / 1024, pss: null };
  }
}

async function open(dir: string, store: TestBlobs, sandbox: "vm" | "process") {
  const engine = await new Engine(defineSchema({}), new SqlitePersistence(join(dir, "db.sqlite"), { durable: true }), {
    instanceName: NAME,
    instanceSecret: SECRET,
    storedSchema: true,
  }).init();
  const functions = new Functions(engine);
  const started = performance.now();
  const s = createServer({
    engine,
    functions,
    port: 0,
    deployable: true,
    functionSandbox: sandbox,
    functionSandboxIsolation: "none",
    moduleStorage: store,
  });
  await s.codeReady;
  const readyMs = performance.now() - started;
  const executor = sandbox === "process" ? executors.at(-1)! : null;
  const api = `http://127.0.0.1:${s.server.port}`;
  const post = async (path: string, body: object) => {
    const r = await fetch(`${api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bunvex ${KEY}` },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    if (r.status !== 200) throw new Error(`${path}: ${r.status} ${text}`);
    return text ? (JSON.parse(text) as Record<string, unknown>) : null;
  };
  const push = async (n: number) => {
    const t = performance.now();
    const start = (await post("/api/deploy2/start_push", {
      adminKey: KEY,
      functions: "bunvex",
      nodeDependencies: [],
      appDefinition: {
        definition: definition(n),
        dependencies: ["counter"],
        schema: null,
        changedModules: [APP],
        unchangedModuleHashes: [],
        udfServerVersion: "1.46.0",
      },
      componentDefinitions: [COUNTER],
    }))!;
    await post("/api/deploy2/wait_for_schema", { adminKey: KEY, schemaChange: start.schemaChange, timeoutMs: 20_000 });
    await post("/api/deploy2/finish_push", { adminKey: KEY, startPush: start, dryRun: false });
    return performance.now() - t;
  };
  const stop = async () => {
    await s.shutdown();
  };
  return { s, engine, functions, executor, api, push, readyMs, stop };
}

type Lat = { p50: number; mean: number; p99: number };
/** Every call's argument is new: no query result is served from the cache. */
let unique = 0;
async function latency(run: (i: number) => Promise<unknown>, n: number): Promise<Lat> {
  for (let w = 0; w < Math.min(100, n); w++) await run(++unique);
  const us: number[] = [];
  for (let c = 0; c < n; c++) {
    const i = ++unique;
    const t = performance.now();
    await run(i);
    us.push((performance.now() - t) * 1000);
  }
  return { p50: q(us, 0.5), mean: us.reduce((a, b) => a + b, 0) / us.length, p99: q(us, 0.99) };
}

type Row = Record<string, unknown>;
const rows: Row[] = [];
for (const n of INSTANCES)
  for (const mode of MODES) {
    components = mode === "vm" ? "shared" : mode;
    const sandbox = mode === "vm" ? "vm" : "process";
    const dir = mkdtempSync(join(tmpdir(), "bunvex-component-bench-"));
    const store = new TestBlobs();
    let d = await open(dir, store, sandbox);
    const pushes = [await d.push(n)];
    for (let p = 1; p < PUSHES; p++) pushes.push(await d.push(n));
    // A restart: the store reopened, the deployed code (the app and every instance) loaded before it serves.
    await d.stop();
    const restarts: number[] = [];
    for (let r = 0; r < 3; r++) {
      d = await open(dir, store, sandbox);
      restarts.push(d.readyMs);
      if (r < 2) await d.stop();
    }
    const f = d.functions;
    const lat = {
      "app query, empty": await latency((i) => f.runQuery("app:empty", { i }), CALLS),
      "app query, 1 runQuery into a component": await latency((i) => f.runQuery("app:into", { i }), CALLS),
      "app query, 10 runQuery into a component": await latency((i) => f.runQuery("app:into10", { i }), CALLS / 4),
      "app mutation, 1 runMutation into a component (insert)": await latency(
        (i) => f.runMutation("app:write", { i }),
        CALLS,
      ),
      "app action, 1 runQuery into a component": await latency((i) => f.runAction("app:fromAction", { i }), CALLS),
      "a component's HTTP route (over HTTP)": await latency(
        async () => (await fetch(`${d.api}/http/c/hello`)).text(),
        CALLS,
      ),
    };
    const children = d.executor ? await d.executor.children() : [];
    const server = memory(process.pid);
    const kids = children.map((c) => ({ pid: c.pid, versions: c.versions, ...memory(c.pid) }));
    const sum = (k: "rss" | "pss") => kids.reduce((a, c) => a + (c[k] ?? 0), 0);
    const row: Row = {
      instances: n,
      mode,
      firstPushMs: pushes[0],
      laterPushMs: median(pushes.slice(1)),
      restartMs: median(restarts),
      latencyUs: lat,
      children: kids.length,
      childVersions: kids.map((c) => c.versions),
      serverRssMiB: server.rss,
      serverPssMiB: server.pss,
      childrenRssMiB: sum("rss"),
      childrenPssMiB: kids.some((c) => c.pss === null) ? null : sum("pss"),
    };
    rows.push(row);
    await d.stop();
    rmSync(dir, { recursive: true, force: true });
    if (JSON_OUT) console.log(JSON.stringify(row));
    else {
      console.log(
        `\n${n} instance(s), ${mode}: push ${pushes[0]!.toFixed(0)} ms first, ${(row.laterPushMs as number).toFixed(0)} ms later; restart ${(row.restartMs as number).toFixed(0)} ms; ${kids.length} child(ren) ${JSON.stringify(row.childVersions)}; server RSS ${server.rss.toFixed(1)} MiB, children RSS ${sum("rss").toFixed(1)} MiB, PSS ${row.childrenPssMiB === null ? "-" : (row.childrenPssMiB as number).toFixed(1)} MiB`,
      );
      for (const [k, v] of Object.entries(lat))
        console.log(`  ${k}: ${v.p50.toFixed(0)} / ${v.mean.toFixed(0)} / ${v.p99.toFixed(0)} µs`);
    }
  }
process.exit(0);

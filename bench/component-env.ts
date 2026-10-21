// The nested-call path with a component's own `process.env` (STUDY-171 §15.7, Q-PR7-1): an app mounting one component
// whose `KEY` is bound to the app's `APPKEY`, its functions reading `process.env.KEY`. Each line in-process through
// `Functions` (no HTTP), one call at a time, each with a new argument (no cache hit): p50 / mean / p99 µs.
//
//   bun bench/component-env.ts [calls=2000] [--sandbox=vm|process]
//
// Under `process` (the function sandbox's child) the server needs components under `process` (STUDY-171 §15, #822).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { adminKeyCipherKey, createServer, Functions, issueAdminKey } from "bunvex/server";
import { MemoryBlobStore } from "../packages/file-storage/src/index.ts";

const CALLS = Number(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? 2000);
const SANDBOX = (process.argv.find((a) => a.startsWith("--sandbox="))?.slice(10) ?? "vm") as "vm" | "process";
if (SANDBOX === "process") {
  const { provideProcessExecutor } = await import("../packages/server/src/function-executor.ts");
  const { createProcessExecutor } = await import("../packages/sandbox/src/executor.ts");
  provideProcessExecutor(createProcessExecutor);
}

const SECRET = "c3".repeat(32);
const NAME = "component-env-bench";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
const SERVER = JSON.stringify(["bunvex", "server"].join("/"));
const VALUES = JSON.stringify(["bunvex", "values"].join("/"));
const mod = (path: string, source: string) => ({ path, source, environment: "isolate" as const });
const dep = (path: string) => `./_componentDeps/${Buffer.from(path).toString("base64url")}`;

const DEFINITION = mod(
  "bunvex.config.js",
  `import { defineApp } from ${SERVER};
import { v } from ${VALUES};
import envc from ${JSON.stringify(dep("envc"))};
const app = defineApp({ env: { APPKEY: v.optional(v.string()) } });
app.use(envc, { env: { KEY: app.env.APPKEY } });
export default app;`,
);
const APP = mod(
  "app.js",
  `import { componentsGeneric, createFunctionHandle, mutation, query } from ${SERVER};
import { v } from ${VALUES};
const c = componentsGeneric().envc.lib;
export const empty = query({ args: { i: v.number() }, handler: async (ctx, { i }) => i });
export const own = query({ args: { i: v.number() }, handler: async (ctx, { i }) => (process.env.APPKEY ?? "").length + i });
export const into = query({ args: { i: v.number() }, handler: async (ctx, { i }) => ctx.runQuery(c.key, { i }) });
export const into10 = query({ args: { i: v.number() }, handler: async (ctx, { i }) => { let s = 0; for (let k = 0; k < 10; k++) s += await ctx.runQuery(c.key, { i: k }); return s + i; } });
export const app10 = query({ args: { i: v.number() }, handler: async (ctx, { i }) => { let s = 0; for (let k = 0; k < 10; k++) s += await ctx.runQuery("app:own", { i: k }); return s + i; } });
export const write = mutation({ args: { i: v.number() }, handler: async (ctx, { i }) => ctx.runMutation(c.keyMut, { i }) });
export const back = query({ args: { i: v.number() }, handler: async (ctx, { i }) => ctx.runQuery(c.call, { h: await createFunctionHandle("app:own"), i }) });
`,
);
const ENVC = {
  definitionPath: "envc",
  definition: mod(
    "bunvex.config.js",
    `import { defineComponent } from ${SERVER};
import { v } from ${VALUES};
export default defineComponent("envc", { env: { KEY: v.optional(v.string()) } });`,
  ),
  dependencies: [] as string[],
  schema: null,
  functions: [
    mod(
      "lib.js",
      `import { mutation, query } from ${SERVER};
import { v } from ${VALUES};
export const key = query({ args: { i: v.number() }, handler: async (ctx, { i }) => (process.env.KEY ?? "").length + i });
export const keyMut = mutation({ args: { i: v.number() }, handler: async (ctx, { i }) => (process.env.KEY ?? "").length + i });
export const call = query({ args: { h: v.string(), i: v.number() }, handler: async (ctx, { h, i }) => ctx.runQuery(h, { i }) });
`,
    ),
  ],
  udfServerVersion: "1.46.0",
};

const q = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;

const dir = mkdtempSync(join(tmpdir(), "bunvex-component-env-bench-"));
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
  functionSandbox: SANDBOX,
  functionSandboxIsolation: "none",
  moduleStorage: new MemoryBlobStore(),
});
await s.codeReady;
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
await engine.mutation((db) => engine.environment.update(db, [{ name: "APPKEY", value: "app-key" }]));
const start = (await post("/api/deploy2/start_push", {
  adminKey: KEY,
  functions: "bunvex",
  nodeDependencies: [],
  appDefinition: {
    definition: DEFINITION,
    dependencies: ["envc"],
    schema: null,
    changedModules: [APP],
    unchangedModuleHashes: [],
    udfServerVersion: "1.46.0",
  },
  componentDefinitions: [ENVC],
}))!;
await post("/api/deploy2/wait_for_schema", { adminKey: KEY, schemaChange: start.schemaChange, timeoutMs: 20_000 });
await post("/api/deploy2/finish_push", { adminKey: KEY, startPush: start, dryRun: false });

let unique = 0;
async function latency(run: (i: number) => Promise<unknown>, n: number) {
  for (let w = 0; w < Math.min(200, n); w++) await run(++unique);
  const us: number[] = [];
  for (let c = 0; c < n; c++) {
    const i = ++unique;
    const t = performance.now();
    await run(i);
    us.push((performance.now() - t) * 1000);
  }
  return { p50: q(us, 0.5), mean: us.reduce((a, b) => a + b, 0) / us.length, p99: q(us, 0.99) };
}

const lines: [string, (i: number) => Promise<unknown>, number][] = [
  ["app query, empty", (i) => functions.runQuery("app:empty", { i }), CALLS],
  ["app query, 1 runQuery into the component", (i) => functions.runQuery("app:into", { i }), CALLS],
  ["app query, 10 runQuery into the component", (i) => functions.runQuery("app:into10", { i }), CALLS / 4],
  ["app query, 10 runQuery into the app (no switch)", (i) => functions.runQuery("app:app10", { i }), CALLS / 4],
  ["app mutation, 1 runMutation into the component", (i) => functions.runMutation("app:write", { i }), CALLS],
  ["app query → component → app by handle", (i) => functions.runQuery("app:back", { i }), CALLS],
];
console.log(`sandbox ${SANDBOX}, ${CALLS} calls (a quarter for the 10-call lines); p50 / mean / p99 µs`);
for (const [name, run, n] of lines) {
  const l = await latency(run, n);
  console.log(`  ${name}: ${l.p50.toFixed(0)} / ${l.mean.toFixed(0)} / ${l.p99.toFixed(0)}`);
}
await s.shutdown();
rmSync(dir, { recursive: true, force: true });
process.exit(0);

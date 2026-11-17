// What a client receives is the same whether a call ran on an execution worker or on the main thread (STUDY-194
// §11.5's hardening). The differential check of the preload compares a worker's outcome text with an in-thread run's;
// a value can still differ after that text, where the main thread reads it (a WebSocket mutation that returned
// `undefined` was read as a session replay). Here two deployments of one app, one with no workers and one with a
// worker, answer the same generated calls: values with `undefined` and `null` at the top and nested, bytes, bigints,
// special floats, odd field names, returned or thrown as an error's data, through HTTP and the WebSocket, as queries
// and as mutations with and without writes. Every response, the function log and the execution counts must match.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { MemoryBlobStore } from "@bunvex/file-storage";
import type { v1 } from "@bunvex/protocol";
import fc from "fast-check";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import type { ModuleSource } from "../src/code-version.ts";
import { Functions } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { add, syncUrl, v1Client } from "./v1-client.ts";

/** How many cases a property runs: `base` × BUNVEX_PROPERTY_MULTIPLIER, as `packages/core/test/property-runs.ts`. */
const runs = (base: number) => base * Math.max(1, Number(process.env.BUNVEX_PROPERTY_MULTIPLIER ?? 1));

const SECRET = "ab".repeat(32);
const NAME = "worker-boundary-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });

const mod = (path: string, source: string): ModuleSource => ({ path, source, environment: "isolate" });

const SCHEMA = mod(
  "schema.js",
  `import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";
export default defineSchema({ rows: defineTable({ k: v.string() }) });`,
);

// A value's spec, as JSON: what the functions build and return (or throw), so that both deployments build the same
// value and only the boundary can make them differ.
const APP = mod(
  "b.js",
  `import { mutation, query } from "@bunvex/server";
import { BunvexError, v } from "@bunvex/values";
const build = (s) => {
  switch (s[0]) {
    case "u": return undefined;
    case "n": return null;
    case "t": return true;
    case "F": return false;
    case "s": return s[1];
    case "f": return s[1] === "NaN" ? NaN : s[1] === "Inf" ? Infinity : s[1] === "-Inf" ? -Infinity : s[1] === "-0" ? -0 : s[1];
    case "i": return BigInt(s[1]);
    case "b": return new Uint8Array(s[1]).buffer;
    case "a": return s[1].map(build);
    case "o": return Object.fromEntries(s[1].map(([k, x]) => [k, build(x)]));
  }
  throw new Error("unknown spec " + JSON.stringify(s));
};
const value = (s) => build(JSON.parse(s));
export const q = query({ args: { s: v.string() }, handler: (_ctx, { s }) => value(s) });
export const logged = query({ args: { s: v.string() }, handler: (_ctx, { s }) => { console.log("got", value(s)); return null; } });
export const qe = query({ args: { s: v.string() }, handler: (_ctx, { s }) => { throw new BunvexError(value(s)); } });
export const m = mutation({ args: { s: v.string() }, handler: async (ctx, { s }) => { await ctx.db.insert("rows", { k: s }); return value(s); } });
export const m0 = mutation({ args: { s: v.string() }, handler: (_ctx, { s }) => value(s) });
export const me = mutation({ args: { s: v.string() }, handler: async (ctx, { s }) => { await ctx.db.insert("rows", { k: s }); throw new BunvexError(value(s)); } });`,
);

type Spec =
  | ["u"]
  | ["n"]
  | ["t"]
  | ["F"]
  | ["s", string]
  | ["f", number | string]
  | ["i", string]
  | ["b", number[]]
  | ["a", Spec[]]
  | ["o", [string, Spec][]];

const key = fc.oneof(
  fc.constantFrom("a", "b", "_x", "$x", "", "é", "a".repeat(70), "__proto__", "constructor", "x y"),
  fc.string({ maxLength: 6 }),
);
const leaf: fc.Arbitrary<Spec> = fc.oneof(
  fc.constant<Spec>(["u"]),
  fc.constant<Spec>(["n"]),
  fc.constantFrom<Spec>(["t"], ["F"]),
  fc.oneof(fc.string({ maxLength: 8 }), fc.constantFrom("\u0000", "😀", "\ud800")).map((s): Spec => ["s", s]),
  fc
    .oneof(fc.double(), fc.constantFrom("NaN", "Inf", "-Inf", "-0"))
    .map(
      (x): Spec => ["f", typeof x === "number" && (Number.isNaN(x) || !Number.isFinite(x) || Object.is(x, -0)) ? 0 : x],
    ),
  fc
    .oneof(fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }), fc.constantFrom(2n ** 63n, -(2n ** 63n) - 1n))
    .map((i): Spec => ["i", i.toString()]),
  fc.uint8Array({ maxLength: 6 }).map((b): Spec => ["b", [...b]]),
);
const { spec } = fc.letrec<{ spec: Spec }>((tie) => ({
  spec: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    leaf,
    fc.array(tie("spec"), { maxLength: 4 }).map((a): Spec => ["a", a]),
    fc.array(fc.tuple(key, tie("spec")), { maxLength: 4 }).map((o): Spec => ["o", o]),
  ),
}));

const dirs: string[] = [];
const stops: (() => unknown)[] = [];

async function deployment(workers: number) {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-worker-boundary-"));
  dirs.push(dir);
  const engine = await new Engine(
    defineSchema({}),
    new SqlitePersistence(join(dir, "db.sqlite"), { durable: true }),
    // The main thread's deployment runs its calls as production does: not through the codec, which the preload
    // turns on for every engine of the tests (`roundTripCallsByDefault`).
    { instanceName: NAME, instanceSecret: SECRET, storedSchema: true, ...(workers === 0 ? { callCodec: false } : {}) },
  ).init();
  const functions = new Functions(engine);
  const s = createServer({
    engine,
    functions,
    port: 0,
    deployable: true,
    moduleStorage: new MemoryBlobStore(),
    redactLogsToClient: false,
    executionWorkers: workers,
  });
  await s.codeReady;
  stops.push(() => s.shutdown());
  const api = `http://127.0.0.1:${s.server.port}`;
  const post = async (path: string, body: object, admin = false) => {
    const r = await fetch(`${api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(admin ? { authorization: `Bunvex ${KEY}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const start = (
    await post(
      "/api/deploy2/start_push",
      {
        adminKey: KEY,
        functions: "bunvex",
        nodeDependencies: [],
        appDefinition: {
          definition: null,
          dependencies: [],
          schema: SCHEMA,
          changedModules: [APP],
          unchangedModuleHashes: [],
          udfServerVersion: "1.46.0",
        },
        componentDefinitions: [],
      },
      true,
    )
  ).body;
  if (!start.schemaChange) throw new Error(JSON.stringify(start));
  await post(
    "/api/deploy2/wait_for_schema",
    { adminKey: KEY, schemaChange: start.schemaChange, timeoutMs: 10000 },
    true,
  );
  const finish = (await post("/api/deploy2/finish_push", { adminKey: KEY, startPush: start, dryRun: false }, true))
    .body;
  if (finish.code) throw new Error(JSON.stringify(finish));
  const pool = s.queryWorkers;
  // The first call starts the worker; the next ones run on it once it is ready. Both deployments make it, so their
  // function logs match.
  await post("/api/query", { path: "b:q", args: { s: '["n"]' }, format: "json" });
  if (workers > 0) {
    for (let i = 0; i < 300 && pool!.ready === 0; i++) await Bun.sleep(10);
    if (pool!.ready === 0) throw new Error("no execution worker started");
  }
  const ws = await v1Client(syncUrl(s.server.port));
  stops.push(() => ws.ws.close());
  const logs = async () => {
    const r = await fetch(`${api}/api/stream_function_logs?cursor=0`, { headers: { authorization: `Bunvex ${KEY}` } });
    return ((await r.json()) as { entries: Record<string, unknown>[] }).entries;
  };
  const executions = async () =>
    (await (await fetch(`${api}/metrics`)).text())
      .split("\n")
      .filter((l) => l.startsWith("bunvex_udf_executions_total"));
  return { post, ws, logs, executions, answered: () => pool?.counts.answered ?? 0 };
}

let here: Awaited<ReturnType<typeof deployment>>;
let there: Awaited<ReturnType<typeof deployment>>;
beforeAll(async () => {
  here = await deployment(0);
  there = await deployment(1);
}, 60_000);
afterAll(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** What changes from run to run whatever ran the call: times, ids, versions. */
const TIMES = new Set([
  "timestamp",
  "executionTime",
  "executionTimestamp",
  "userExecutionTime",
  "ts",
  "requestId",
  "executionId",
  "startVersion",
  "endVersion",
]);
const normal = (x: unknown): unknown =>
  JSON.parse(
    JSON.stringify(x, (k, v) =>
      TIMES.has(k)
        ? undefined
        : typeof v === "bigint"
          ? `${v}n`
          : typeof v === "string"
            ? v.replace(/\[Request ID: [0-9a-f]+\]/g, "[Request ID]")
            : v,
    ),
  );

let queryId = 0;
let requestId = 0;

/** One call through every path a client has, on one deployment: what the client received. */
async function received(d: typeof here, s: string, qid: number, rid: number) {
  const out: Record<string, unknown> = {};
  for (const path of ["b:q", "b:qe", "b:logged"])
    out[`http ${path}`] = await d.post("/api/query", { path, args: { s }, format: "json" });
  for (const path of ["b:m", "b:m0", "b:me"])
    out[`http ${path}`] = await d.post("/api/mutation", { path, args: { s }, format: "json" });
  const before = d.ws.transitions().length;
  d.ws.modify([add(qid, "b:q", { s }), add(qid + 1, "b:qe", { s })]);
  const t = await d.ws.until(() =>
    d.ws
      .transitions()
      .slice(before)
      .find((x) => x.modifications.some((m) => "queryId" in m && m.queryId === qid)),
  );
  out["ws query"] = t.modifications.filter((m) => "queryId" in m && (m.queryId === qid || m.queryId === qid + 1));
  d.ws.modify([
    { type: "Remove", queryId: qid },
    { type: "Remove", queryId: qid + 1 },
  ]);
  for (const [i, path] of ["b:m", "b:m0", "b:me"].entries()) {
    d.ws.mutate(rid + i, path, { s });
    out[`ws ${path}`] = await d.ws.until(() =>
      d.ws.responses().find((r: v1.MutationResponse) => r.requestId === rid + i),
    );
  }
  return normal(out);
}

describe("a client receives the same from a worker as from the main thread", () => {
  test("generated values, returned and thrown, through HTTP and the WebSocket, as queries and mutations", async () => {
    await fc.assert(
      fc.asyncProperty(spec, async (sp) => {
        const s = JSON.stringify(sp);
        queryId += 2;
        requestId += 3;
        const qid = queryId;
        const rid = requestId;
        const answered = there.answered();
        const a = await received(here, s, qid, rid);
        const b = await received(there, s, qid, rid);
        expect(b).toEqual(a);
        // Every call of the worker's deployment ran on its worker: 3 HTTP queries, 3 HTTP mutations, 2 subscriptions
        // and 3 WebSocket mutations (a query answered from the cache runs nowhere).
        expect(there.answered() - answered).toBeGreaterThan(0);
      }),
      {
        numRuns: runs(40),
        // Every run starts with the cases that crossed wrong before: nothing returned (#1076), bytes in an error's
        // data, a value that is none (a bigint out of range, `undefined` in an array).
        examples: [
          [["u"]],
          [["n"]],
          [["b", [1, 2]]],
          [["i", (2n ** 63n).toString()]],
          [["a", [["u"]]]],
          [["o", [["a", ["u"]]]]],
        ],
      },
    );
    // The same entries; not in the same order, as the two queries of one subscription change run concurrently.
    const entries = async (d: typeof here) =>
      ((normal(await d.logs()) as unknown[]).map((e) => JSON.stringify(e)) as string[]).sort();
    expect(await entries(there)).toEqual(await entries(here));
    expect(await there.executions()).toEqual(await here.executions());
  }, 300_000);
});

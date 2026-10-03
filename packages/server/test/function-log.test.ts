// The function execution log and its stream routes (STUDY-47), as Convex's `FunctionExecutionLog` and
// `logs.rs`: one Completion per execution with its fields, an action's lines as Progress events, nested
// calls with their parent, OCC attempts, the request filter, the long poll and the ring's size.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { makeFunctionReference } from "@bunvex/protocol";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { cronJobs, cronSpecs } from "../src/cron.ts";
import { CronJobExecutor } from "../src/cron-executor.ts";
import { FunctionLog, type Part, wsRequestId } from "../src/function-log.ts";
import { action, Functions, internalMutation, mutation, query } from "../src/functions.ts";
import { httpAction, httpRouter } from "../src/router.ts";
import { createServer } from "../src/server.ts";
import { syncUrl, v1Client } from "./v1-client.ts";

const SECRET = "4361726e697461732c206c69746572616c6c79206d65616e696e6720226c6974";
const NAME = "carnitas";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: NAME, instanceSecret: SECRET, occInitialBackoffMs: 1, occMaxBackoffMs: 2 },
  ).init();
  const id = await engine.mutation((db) => db.insert("items", { n: 0 }));
  let attempts = 0;
  const functions = new Functions(engine).register("m", {
    hello: query(async ({ db }, { who }: { who: string }) => {
      console.log("hello", who);
      await db.query("items").collect();
      return `hi ${who}`;
    }),
    fails: mutation(() => {
      console.warn("about to fail");
      throw new Error("nope");
    }),
    write: mutation(async ({ db }) => {
      await db.insert("items", { n: 1 });
      return null;
    }),
    // Loses its first attempt: a rival write lands between its read and its commit.
    contended: mutation(async ({ db }) => {
      console.log(`attempt ${attempts}`);
      await db.get(id as never);
      if (attempts++ === 0) await engine.mutation((d) => d.patch(id as never, { n: 2 }), "m:rival");
      await db.patch(id as never, { n: 3 });
    }),
    worker: action(async (ctx) => {
      console.log("working");
      const r = await ctx.runQuery("m:hello" as never, { who: "action" });
      console.info("done");
      return r;
    }),
    tick: internalMutation(() => {
      console.log("tick");
    }),
    later: mutation(({ scheduler }) => scheduler.runAfter(0, "m:tick" as never, {})),
  });
  const http = httpRouter();
  http.route({
    path: "/ping",
    method: "GET",
    handler: httpAction(async () => {
      console.log("pinged");
      return new Response("pong", { status: 201 });
    }),
  });
  const server = createServer({ engine, functions, port: 0, redactLogsToClient: false, http });
  stops.push(server.stop);
  const api = `http://127.0.0.1:${server.server!.port}`;
  const call = async (kind: string, path: string, args: object = {}) =>
    (await fetch(`${api}/api/${kind}`, { method: "POST", body: JSON.stringify({ path, args }) })).json() as any;
  const stream = async (route: string, query: string, headers: Record<string, string> = {}) => {
    const r = await fetch(`${api}${route}?${query}`, { headers: { authorization: `Bunvex ${KEY}`, ...headers } });
    return { status: r.status, body: (await r.json()) as any };
  };
  return { server, call, stream, api, id, site: `http://127.0.0.1:${server.site!.port}` };
}

const completions = (entries: any[]) => entries.filter((e) => e.kind === "Completion");

test("a query's Completion: Convex's fields, in Convex's order, with its lines and usage", async () => {
  const { call, stream } = await setup();
  const before = Date.now() / 1000;
  expect((await call("query", "m:hello", { who: "ada" })).value).toBe("hi ada");
  const { status, body } = await stream("/api/stream_function_logs", "cursor=0");
  expect(status).toBe(200);
  const [c] = completions(body.entries);
  expect(Object.keys(c)).toEqual([
    "kind",
    "udfType",
    "componentPath",
    "identifier",
    "logLines",
    "timestamp",
    "cachedResult",
    "caller",
    "parentExecutionId",
    "executionTime",
    "userExecutionTime",
    "success",
    "error",
    "requestId",
    "executionId",
    "usageStats",
    "returnBytes",
    "occInfo",
    "willRetry",
    "executionTimestamp",
    "identityType",
    "environment",
  ]);
  expect(c).toMatchObject({
    udfType: "Query",
    componentPath: null,
    identifier: "m:hello",
    // No client header: Convex's pretty strings.
    logLines: ["[LOG] 'hello' 'ada'"],
    cachedResult: false,
    caller: "HttpApi",
    parentExecutionId: null,
    success: null,
    error: null,
    occInfo: null,
    willRetry: false,
    identityType: "unknown",
    environment: "isolate",
  });
  expect(c.requestId).toMatch(/^[0-9a-f]{16}$/);
  expect(c.executionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(c.timestamp).toBeGreaterThanOrEqual(c.executionTimestamp);
  expect(c.executionTimestamp).toBeGreaterThanOrEqual(before - 1);
  expect(c.usageStats.databaseReadDocuments).toBe(1);
  expect(c.usageStats.databaseReadBytes).toBeGreaterThan(0);
  expect(c.returnBytes).toBeGreaterThan(0);
  expect(body.newCursor).toBeGreaterThan(0);

  // The same query again is a cache hit: logged, with the stored lines and no reads.
  await call("query", "m:hello", { who: "ada" });
  const again = await stream("/api/stream_function_logs", `cursor=${body.newCursor}`);
  const [hit] = completions(again.body.entries);
  expect(hit.cachedResult).toBe(true);
  expect(hit.logLines).toEqual(["[LOG] 'hello' 'ada'"]);
  expect(hit.usageStats.databaseReadDocuments).toBe(0);
});

test("the CLI and the dashboard get structured lines; a failure's error; writes in usage", async () => {
  const { call, stream } = await setup();
  await call("mutation", "m:fails");
  await call("mutation", "m:write");
  const { body } = await stream("/api/stream_function_logs", "cursor=0", { "bunvex-client": "npm-cli-1.0.0" });
  const [failed, wrote] = completions(body.entries);
  expect(failed.logLines).toEqual([
    { messages: ["'about to fail'"], isTruncated: false, timestamp: expect.any(Number), level: "WARN" },
  ]);
  expect(failed.error).toMatch(/^Uncaught Error: nope\n/);
  expect(failed.returnBytes).toBeNull();
  expect(wrote.usageStats.databaseWriteDocuments).toBe(1);
  expect(wrote.usageStats.databaseWriteBytes).toBeGreaterThan(0);
  // stream_udf_execution always sends strings.
  const udf = await stream("/api/stream_udf_execution", "cursor=0", { "bunvex-client": "dashboard-1.0.0" });
  expect(completions(udf.body.entries)[0].logLines).toEqual(["[WARN] 'about to fail'"]);
});

test("an action: its lines as Progress, its Completion without them; the query it ran as a child", async () => {
  const { call, stream } = await setup();
  expect((await call("action", "m:worker")).value).toBe("hi action");
  const { body } = await stream("/api/stream_function_logs", "cursor=0");
  const kinds = body.entries.map((e: any) => `${e.kind}:${e.identifier}`);
  expect(kinds).toEqual(["Progress:m:worker", "Completion:m:hello", "Progress:m:worker", "Completion:m:worker"]);
  const [p1, child, p2, done] = body.entries;
  expect(p1.logLines).toEqual(["[LOG] 'working'"]);
  expect(p2.logLines).toEqual(["[INFO] 'done'"]);
  expect(Object.keys(p1)).toEqual([
    "kind",
    "udfType",
    "componentPath",
    "identifier",
    "timestamp",
    "logLines",
    "requestId",
    "executionId",
  ]);
  expect(p1.executionId).toBe(done.executionId);
  expect(p1.timestamp).toBe(done.executionTimestamp);
  expect(done.logLines).toEqual([]);
  expect(child.caller).toBe("Action");
  expect(child.parentExecutionId).toBe(done.executionId);
  expect(child.requestId).toBe(done.requestId);
  expect(child.logLines).toEqual(["[LOG] 'hello' 'action'"]);
  // stream_udf_execution: Completions only, the action's with its own lines (not its child's).
  const udf = await stream("/api/stream_udf_execution", "cursor=0");
  expect(udf.body.entries.map((e: any) => e.identifier)).toEqual(["m:hello", "m:worker"]);
  expect(udf.body.entries[1].logLines).toEqual(["[LOG] 'working'", "[INFO] 'done'"]);
});

test("an HTTP action: its route, the HttpEndpoint caller and its status", async () => {
  const { site, stream } = await setup();
  expect((await fetch(`${site}/ping`)).status).toBe(201);
  const { body } = await stream("/api/stream_function_logs", "cursor=0");
  const [progress, done] = body.entries;
  expect(progress).toMatchObject({ kind: "Progress", udfType: "HttpAction", identifier: "GET /ping" });
  expect(done).toMatchObject({
    kind: "Completion",
    udfType: "HttpAction",
    identifier: "GET /ping",
    caller: "HttpEndpoint",
    success: { status: "201" },
    logLines: [],
  });
});

test("a lost OCC attempt is its own Completion with occInfo and willRetry", async () => {
  const { call, stream, id } = await setup();
  await call("mutation", "m:contended");
  const { body } = await stream("/api/stream_function_logs", "cursor=0");
  const [lost, won] = completions(body.entries);
  expect(lost).toMatchObject({
    identifier: "m:contended",
    willRetry: true,
    logLines: ["[LOG] 'attempt 0'"],
    occInfo: { tableName: "items", documentId: id, writeSource: "m:rival", componentPath: null, retryCount: 0 },
  });
  expect(lost.error).toContain("changed while this mutation was being run");
  expect(won).toMatchObject({ willRetry: false, occInfo: null, error: null, logLines: ["[LOG] 'attempt 1'"] });
  expect(won.executionId).toBe(lost.executionId);
});

test("scheduled runs: the Scheduler caller, unknown identity, lines captured", async () => {
  const { call, stream } = await setup();
  await call("mutation", "m:later");
  let tick: any;
  for (let i = 0; i < 200 && !tick; i++) {
    const { body } = await stream("/api/stream_function_logs", "cursor=0");
    tick = completions(body.entries).find((c: any) => c.identifier === "m:tick");
    if (!tick) await Bun.sleep(10);
  }
  expect(tick).toMatchObject({ caller: "Scheduler", identityType: "unknown", logLines: ["[LOG] 'tick'"] });
});

test("WebSocket requests: Convex's request id, the SyncWorker caller, and the request filter", async () => {
  const { server, stream } = await setup();
  const sessionId = crypto.randomUUID();
  const c = await v1Client(syncUrl(server.server!.port), sessionId);
  c.mutate(7, "m:fails");
  c.mutate(8, "m:write");
  await c.until(() => c.responses().length === 2);
  c.ws.close();
  const all = await stream("/api/stream_function_logs", "cursor=0");
  const [failed] = completions(all.body.entries);
  expect(failed.caller).toBe("SyncWorker");
  expect(failed.requestId).toBe(wsRequestId(sessionId, 7));
  const one = await stream("/api/stream_function_logs", `cursor=0&sessionId=${sessionId}&clientRequestCounter=8`);
  expect(one.body.entries.map((e: any) => e.identifier)).toEqual(["m:write"]);
});

test("Convex's request id for a WebSocket request: SHA-256 of `<session>|<counter>`, 16 hex digits", () => {
  // sha256("abc|1") = 0f5d2e8f…
  const expected = new Bun.CryptoHasher("sha256").update("abc|1").digest("hex").slice(0, 16);
  expect(wsRequestId("abc", 1)).toBe(expected);
  expect(wsRequestId("abc", 1)).toHaveLength(16);
});

test("system functions are not logged; reading needs ViewLogs; a bad cursor is BadQueryArgs", async () => {
  const { api, call, stream } = await setup();
  await call("query", "_system/cli/tables:default");
  const r = await fetch(`${api}/api/app_metrics/stream_function_logs?cursor=0`);
  expect(r.status).toBe(403);
  await call("query", "m:hello", { who: "x" });
  const { body } = await stream("/api/app_metrics/stream_function_logs", "cursor=0");
  expect(body.entries.map((e: any) => e.identifier)).toEqual(["m:hello"]);
  const bad = await stream("/api/stream_function_logs", "");
  expect(bad.status).toBe(400);
  expect(bad.body.code).toBe("BadQueryArgs");
});

test("the long poll: a waiting request answers as soon as something is logged", async () => {
  const { call, stream } = await setup();
  await call("query", "m:hello", { who: "early" });
  const head = (await stream("/api/stream_function_logs", "cursor=0")).body.newCursor;
  const waiting = stream("/api/stream_function_logs", `cursor=${head}`);
  await Bun.sleep(30);
  await call("mutation", "m:write");
  const { body } = await waiting;
  expect(body.entries.map((e: any) => e.identifier)).toEqual(["m:write"]);
  expect(body.newCursor).toBeGreaterThan(head);
});

test("FunctionLog: strictly increasing cursors, the newest parts kept, an empty answer after the timeout", async () => {
  const log = new FunctionLog(3);
  const part = (identifier: string): Part => ({
    kind: "Progress",
    udfType: "Action",
    identifier,
    timestamp: 0,
    logLines: [],
    requestId: "r",
    executionId: "e",
    root: true,
  });
  for (const id of ["a", "b", "c", "d"]) log.append(part(id));
  const { parts, newCursor } = await log.after(0, 10);
  expect(parts.map((p) => p.identifier)).toEqual(["b", "c", "d"]);
  const cursors = new Set<number>();
  const log2 = new FunctionLog();
  for (let i = 0; i < 50; i++) {
    log2.append(part("x"));
    cursors.add(log2.headCursor);
  }
  expect(cursors.size).toBe(50);
  expect(await log.after(newCursor, 10)).toEqual({ parts: [], newCursor });
});

test("cron runs: the Cron caller, unknown identity, lines captured", async () => {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", {
    tick: internalMutation(() => {
      console.log("cron tick");
    }),
  });
  const log = new FunctionLog();
  functions.functionLog = log;
  const c = cronJobs();
  c.interval("every second", { seconds: 1 }, makeFunctionReference<"mutation">("m:tick") as never);
  const ex = new CronJobExecutor(
    engine,
    functions,
    cronSpecs(c, (id, name) => functions.cronTarget(id, name)),
    {
      cronSplaySeconds: 0,
    },
  );
  stops.push(() => ex.stop());
  await ex.start();
  const { parts } = await log.after(0, 5000);
  expect(parts[0]).toMatchObject({
    kind: "Completion",
    identifier: "m:tick",
    caller: "Cron",
    identityType: "unknown",
    logLines: [expect.objectContaining({ level: "LOG", messages: ["'cron tick'"] })],
  });
});

test("a function's lines are not printed to the server's own output (as Convex); others still are", async () => {
  const root = new URL("..", import.meta.url).pathname;
  // The modules come by environment variable, so the script holds no import of a path.
  const script = `
    const { defineSchema, Engine } = await import("@bunvex/core");
    const { MemoryPersistence } = await import("@bunvex/core/persistence/memory");
    const { Functions, query } = await import(process.env.FUNCTIONS);
    const { collectLogs } = await import(process.env.LOGS);
    const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
    const functions = new Functions(engine).register("m", { q: query(() => { console.log("INSIDE-FUNCTION"); console.trace("INSIDE-TRACE"); return 1; }) });
    const r = await collectLogs(() => functions.runQuery("m:q", {}));
    console.log("OUTSIDE", JSON.stringify(r.logLines.length));
    process.exit(0);
  `;
  const env = { ...process.env, FUNCTIONS: `${root}src/functions.ts`, LOGS: `${root}src/logs.ts` };
  const p = Bun.spawn(["bun", "-e", script], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  expect(out + err).not.toContain("INSIDE-");
  expect(out).toContain("OUTSIDE 2");
});

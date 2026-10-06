// `console.log` of an engine object never prints the engine's state (inspect.ts in @bunvex/core). Function
// code holds engine objects — `ctx.db`, `ctx.db.system`, a query at any stage, a table scope — and their
// log lines reach the caller (`logLines`), the function log (the dashboard, `bunvex logs`) and the log
// streams. Opened by object-inspect, a transaction printed the catalog, the store's state and the writes of
// other transactions, ~32 KB a line. Everything else prints as Convex's console prints it
// (npm-packages/udf-runtime/src/02_console.ts: object-inspect, depth 5, cycles as `[Circular]`).
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { action, Functions, mutation, query } from "../src/functions.ts";
import { MAX_LOG_LINE_LENGTH } from "../src/logs.ts";
import { httpAction, httpRouter } from "../src/router.ts";
import { createServer } from "../src/server.ts";
import { syncUrl, v1Client } from "./v1-client.ts";

const SECRET = "5e".repeat(32);
const NAME = "console-leak";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
/** Written by another transaction before each call: it must never show up in a log line. */
const OTHER_TX = "OTHER_TX_WRITE_7f3a";
/** What an opened engine object prints: the catalog, the store, its commits, the system tables. */
const INTERNALS = /catalog|persistence|commits|_tables|_index|leaseScope|readSet|OTHER_TX_WRITE/;

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

/** Log `label` then `value`, as an app does. */
const show = (label: string, value: unknown) => console.log(label, value);

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: NAME, instanceSecret: SECRET },
  ).init();
  await engine.mutation((db) => db.insert("items", { n: 1, secret: OTHER_TX }));
  const functions = new Functions(engine).register("m", {
    query: query(async (ctx: any) => {
      show("ctx", ctx);
      show("db", ctx.db);
      show("system", ctx.db.system);
      show("system query", ctx.db.system.query("_storage"));
      show("table", ctx.db.table("items"));
      show("query", ctx.db.query("items"));
      show(
        "withIndex",
        ctx.db.query("items").withIndex("by_n", (q: any) => q.gt("n", 0)),
      );
      show("order", ctx.db.query("items").order("desc"));
      show("full scan", ctx.db.query("items").fullTableScan());
      await ctx.db
        .query("items")
        .filter((q: any) => {
          show("filter q", q);
          return q.eq(q.field("n"), 1);
        })
        .collect();
      show("auth", ctx.auth);
      show("storage", ctx.storage);
      show("meta", ctx.meta);
      show("nested", { a: [{ b: { db: ctx.db } }] });
      show("error", Object.assign(new Error("with a db"), { db: ctx.db }));
      show("map", new Map([["db", ctx.db]]));
      return null;
    }),
    reader: query(async (ctx: any) => {
      show("reader db", ctx.db);
      show("reader table", ctx.db.table("items"));
      return null;
    }),
    mutation: mutation(async (ctx: any) => {
      show("ctx", ctx);
      show("db", ctx.db);
      show("table", ctx.db.table("items"));
      show("scheduler", ctx.scheduler);
      show("storage", ctx.storage);
      // A query run inside the mutation sees a reader view (a Proxy) of the same transaction.
      await ctx.runQuery("m:reader", {});
      return null;
    }),
    action: action(async (ctx: any) => {
      show("ctx", ctx);
      show("storage", ctx.storage);
      show("scheduler", ctx.scheduler);
      show("auth", ctx.auth);
      return null;
    }),
  });
  const http = httpRouter();
  http.route({
    path: "/log",
    method: "GET",
    handler: httpAction(async (ctx: any) => {
      show("http ctx", ctx);
      return new Response("ok");
    }),
  });
  const server = createServer({ engine, functions, port: 0, redactLogsToClient: false, http });
  stops.push(server.stop);
  const api = `http://127.0.0.1:${server.server!.port}`;
  const call = async (kind: string, path: string) =>
    (
      await fetch(`${api}/api/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args: {} }),
      })
    ).json() as Promise<{ status: string; logLines: string[] }>;
  return { engine, server, api, call, functions, site: `http://127.0.0.1:${server.site!.port}` };
}

function expectOpaque(lines: string[]) {
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line).not.toMatch(INTERNALS);
    expect(line.length).toBeLessThan(2000);
    expect(line).not.toContain("(truncated due to length)");
  }
}

test("a query's engine objects print by name: ctx.db, ctx.db.system, queries at every stage, a table", async () => {
  const { call } = await setup();
  const r = await call("query", "m:query");
  expect(r.status).toBe("success");
  expectOpaque(r.logLines);
  const line = (label: string) => r.logLines.find((l) => l.startsWith(`[LOG] '${label}' `));
  expect(line("db")).toBe("[LOG] 'db' Tx {…}");
  expect(line("system")).toBe("[LOG] 'system' SystemReader {…}");
  expect(line("system query")).toBe("[LOG] 'system query' VirtualQueryInitializer {…}");
  expect(line("table")).toBe("[LOG] 'table' TableReader {…}");
  // As Convex's classes: db.query(t) is a QueryInitializerImpl, and every operator returns a QueryImpl.
  expect(line("query")).toBe("[LOG] 'query' QueryInitializerImpl {…}");
  for (const q of ["withIndex", "order", "full scan"]) expect(line(q)).toBe(`[LOG] '${q}' QueryImpl {…}`);
  // The rest of the context prints as Convex's: its plain objects and functions.
  expect(line("ctx")).toContain("db: Tx {…}");
  expect(line("ctx")).toContain("getUserIdentity: [Function: getUserIdentity]");
  expect(line("auth")).toBe("[LOG] 'auth' {\n  getUserIdentity: [Function: getUserIdentity]\n}");
  expect(line("nested")).toContain("db: Tx {…}");
  expect(line("error")).toBe("[LOG] 'error' { [Error: with a db] db: Tx {…} }"); // object-inspect's own form
  expect(line("map")).toBe("[LOG] 'map' Map (1) {\n  'db' => Tx {…}\n}");
});

test("a mutation's, a nested query's (a reader view of the mutation), an action's and an HTTP action's", async () => {
  const { call, site } = await setup();
  const m = await call("mutation", "m:mutation");
  expect(m.status).toBe("success");
  expectOpaque(m.logLines);
  expect(m.logLines).toContain("[LOG] 'db' Tx {…}");
  expect(m.logLines).toContain("[LOG] 'table' TableWriter {…}");
  // A Proxy over the transaction prints the same, without going through its traps.
  expect(m.logLines).toContain("[LOG] 'reader db' Tx {…}");
  expect(m.logLines).toContain("[LOG] 'reader table' TableReader {…}");
  const a = await call("action", "m:action");
  expect(a.status).toBe("success");
  expectOpaque(a.logLines);
  expect((await fetch(`${site}/log`)).status).toBe(200);
});

test("the function log (dashboard, `bunvex logs`, log streams) and the sync protocol get the same lines", async () => {
  const { call, api, server, site } = await setup();
  await call("mutation", "m:mutation");
  await fetch(`${site}/log`);
  const c = await v1Client(syncUrl(server.server!.port));
  stops.push(() => c.ws.close());
  c.mutate(1, "m:mutation");
  const [response] = await c.until(() => c.responses().length > 0 && c.responses());
  expect(response!.success).toBe(true);
  expectOpaque(response!.logLines);
  expect(response!.logLines).toContain("[LOG] 'db' Tx {…}");
  const r = await fetch(`${api}/api/stream_function_logs?cursor=0`, { headers: { authorization: `Bunvex ${KEY}` } });
  const { entries } = (await r.json()) as { entries: { logLines?: unknown[]; logLine?: unknown }[] };
  const text = JSON.stringify(entries);
  expect(text).toContain("Tx {…}");
  expect(text).toContain("http ctx");
  expect(text).not.toMatch(INTERNALS);
});

test("app values print as Convex prints them: class instances opened, cycles, depth, huge values cut", async () => {
  const persistence = await MemoryPersistence.open(null, { durable: false });
  const engine = await new Engine(defineSchema({}), persistence).init();
  class Point {
    constructor(
      readonly x: number,
      readonly y: number,
    ) {}
  }
  const functions = new Functions(engine).register("m", {
    values: query(() => {
      console.log(new Point(1, 2));
      const cycle: Record<string, unknown> = { a: 1 };
      cycle.self = cycle;
      console.log(cycle);
      console.log({ l1: { l2: { l3: { l4: { l5: { l6: 1 } } } } } });
      console.log(Array.from({ length: 1_000 }, (_, i) => ({ i, s: "x".repeat(100) }))); // ~120 KB rendered
      return null;
    }),
  });
  const server = createServer({ engine, functions, port: 0, redactLogsToClient: false });
  stops.push(server.stop);
  const r = (await (
    await fetch(`http://127.0.0.1:${server.server!.port}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "m:values", args: {} }),
    })
  ).json()) as { logLines: string[] };
  const [point, cycle, deep, huge] = r.logLines;
  expect(point).toBe("[LOG] Point {\n  x: 1,\n  y: 2\n}");
  expect(cycle).toBe("[LOG] {\n  a: 1,\n  self: [Circular]\n}");
  expect(deep).toContain("l5: [Object]"); // object-inspect's default depth, as Convex's console
  expect(huge!.endsWith(" (truncated due to length)")).toBe(true);
  expect(new TextEncoder().encode(huge!).length).toBeLessThanOrEqual(
    "[LOG] ".length + MAX_LOG_LINE_LENGTH + " (truncated due to length)".length,
  );
});

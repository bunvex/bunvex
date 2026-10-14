// An error the engine throws into pushed code (STUDY-150): the app sees the frames of its own call, as Convex's
// syscall errors (`performAsyncSyscall`, made again in the app's code), never the server's. Through `deployCode`,
// in pushed code's realm: what the client gets, what `error.stack` reads (and the app returns or logs), the HTTP
// action's trace, a scheduled job's error and the log stream; and the context still behaves as the server's (query
// builders, async iteration, `paginate`, `db.system`, `instanceof BunvexError`).
import { afterEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { Functions } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const SECRET = "4361726e697461732c206c69746572616c6c79206d65616e696e6720226c6974";
const NAME = "carnitas";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
const SERVER = JSON.stringify(["bunvex", "server"].join("/"));
const VALUES = JSON.stringify(["bunvex", "values"].join("/"));
const REPO = resolve(import.meta.dir, "../../..");
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

/** A server's frame or path, anywhere in a text. */
const leaks = (t: string) =>
  t.includes(REPO) ||
  /packages\/(core|server|values)\/|node_modules\/|bunvex-runtime:|bunvex:\/v\d|\(node:|\(native|processTicksAndRejections/.test(
    t,
  );

// Each case makes the engine throw (or the app throw, for the last three); `ctx` is a mutation's or an action's.
const CASES = `
const cases = {
  patchCreationTime: async (ctx) => { const id = await ctx.db.insert("items", { k: 1 }); await ctx.db.patch(id, { _creationTime: 1 }); },
  replaceId: async (ctx) => { const id = await ctx.db.insert("items", { k: 1 }); const o = await ctx.db.insert("items", { k: 2 }); await ctx.db.replace(id, { _id: o }); },
  newTableName: async (ctx) => { await ctx.db.insert("9lives", { k: 1 }); },
  notAnObject: async (ctx) => { await ctx.db.insert("items", 5); },
  systemTable: async (ctx) => { await ctx.db.insert("_storage", {}); },
  badId: async (ctx) => { await ctx.db.get("nope"); },
  badIndex: async (ctx) => { await ctx.db.query("items").withIndex("nope").collect(); },
  badRange: async (ctx) => { await ctx.db.query("items").withIndex("by_creation_time", (q) => q.eq("nope", 1)).collect(); },
  dollarField: async (ctx) => { await ctx.db.insert("items", { $x: 1 }); },
  badPaginate: async (ctx) => { await ctx.db.query("items").paginate({ numItems: -1, cursor: null }); },
  scheduleMissing: async (ctx) => { await ctx.scheduler.runAfter(0, "nope:x", {}); },
  storageBadId: async (ctx) => { await ctx.storage.getUrl("nope"); },
  appError: async () => { throw new Error("mine"); },
  appTypeError: async () => { null.x; },
  appBunvexError: async () => { throw new BunvexError({ mine: 1 }); },
};
const actionCases = {
  runQueryMissing: async (ctx) => { await ctx.runQuery("nope:x", {}); },
  runQueryThrows: async (ctx) => { await ctx.runQuery("m:throws", {}); },
  scheduleMissing: cases.scheduleMissing,
  appError: cases.appError,
  appBunvexError: cases.appBunvexError,
};
`;
const MUTATION_CASES = [
  "patchCreationTime",
  "replaceId",
  "newTableName",
  "notAnObject",
  "systemTable",
  "badId",
  "badIndex",
  "badRange",
  "dollarField",
  "badPaginate",
  "scheduleMissing",
  "storageBadId",
  "appError",
  "appTypeError",
  "appBunvexError",
];
const ACTION_CASES = ["runQueryMissing", "runQueryThrows", "scheduleMissing", "appError", "appBunvexError"];

const exportsOf = (kind: "mutation" | "action", cases: string) => `
export const uncaught = ${kind}(async (ctx, { c }) => { await ${cases}[c](ctx); });
export const caught = ${kind}(async (ctx, { c }) => {
  try { await ${cases}[c](ctx); } catch (e) { return { name: e.name, message: e.message, stack: String(e.stack) }; }
});
export const logged = ${kind}(async (ctx, { c }) => {
  try { await ${cases}[c](ctx); } catch (e) { console.log(e); console.error(e.stack); console.log({ e }); }
});`;

async function deployment() {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false }), {
    instanceName: NAME,
    instanceSecret: SECRET,
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
      path: "m.js",
      environment: "isolate",
      source: `import { mutationGeneric as mutation, queryGeneric as query, internalMutationGeneric } from ${SERVER};
import { BunvexError } from ${VALUES};
${CASES}
${exportsOf("mutation", "cases")}
export const throws = query(async () => { throw new BunvexError({ code: 7 }); });
export const failsLater = internalMutationGeneric(async (ctx) => { await cases.patchCreationTime(ctx); });
export const scheduleFailing = mutation(async (ctx) => ctx.scheduler.runAfter(0, "m:failsLater", {}));
export const jobs = query(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
class FooError extends BunvexError {}
export const context = mutation(async (ctx) => {
  for (let i = 0; i < 3; i++) await ctx.db.insert("items", { i });
  let iterated = 0;
  for await (const d of ctx.db.query("items")) iterated += d.i;
  const page = await ctx.db.query("items").order("desc").paginate({ numItems: 2, cursor: null });
  const ranged = await ctx.db.query("items").withIndex("by_creation_time", (q) => q.gt("_creationTime", 0)).take(2);
  const first = await ctx.db.query("items").filter((q) => q.eq(q.field("i"), 2)).first();
  const system = await ctx.db.system.query("_scheduled_functions").collect();
  let caught;
  try { throw new FooError("foo"); } catch (e) { caught = [e instanceof FooError, e instanceof BunvexError, e.name, e.data]; }
  return { iterated, page: page.page.length, done: page.isDone, ranged: ranged.length, first: first.i, system: system.length, caught };
});`,
    },
    {
      path: "a.js",
      environment: "isolate",
      source: `import { actionGeneric as action } from ${SERVER};
import { BunvexError } from ${VALUES};
${CASES}
${exportsOf("action", "actionCases")}
export const nested = action(async (ctx) => {
  try { await ctx.runQuery("m:throws", {}); } catch (e) { return [e instanceof BunvexError, e.data, e.message.split("\\n")[0]]; }
});`,
    },
    {
      path: "n.js",
      environment: "node",
      source: `"use node";
import { actionGeneric as action } from ${SERVER};
import { BunvexError } from ${VALUES};
${CASES}
${exportsOf("action", "actionCases")}
export const nested = action(async (ctx) => {
  try { await ctx.runQuery("m:throws", {}); } catch (e) { return [e instanceof BunvexError, e.data, e.message.split("\\n")[0]]; }
});`,
    },
    {
      path: "http.js",
      environment: "isolate",
      source: `import { httpRouter, httpActionGeneric } from ${SERVER};
const http = httpRouter();
http.route({ path: "/fail", method: "GET", handler: httpActionGeneric(async (ctx) => {
  await ctx.runMutation("m:uncaught", { c: "patchCreationTime" });
  return new Response("unreachable");
}) });
http.route({ path: "/schedule", method: "GET", handler: httpActionGeneric(async (ctx) => {
  await ctx.scheduler.runAfter(0, "nope:x", {});
  return new Response("unreachable");
}) });
export default http;`,
    },
  ]);
  const api = `http://127.0.0.1:${s.server.port}`;
  const call = async (kind: string, path: string, args: object = {}) =>
    (await (
      await fetch(`${api}/api/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args, format: "json" }),
      })
    ).json()) as { status: string; value?: unknown; errorMessage?: string; logLines?: string[] };
  const logs = async () =>
    JSON.stringify(
      await (
        await fetch(`${api}/api/stream_function_logs?cursor=0`, { headers: { authorization: `Bunvex ${KEY}` } })
      ).json(),
    );
  return { call, logs, site: `http://127.0.0.1:${s.site!.port}` };
}

const RUNS = [
  ...MUTATION_CASES.map((c) => ["mutation", "m", c] as const),
  ...ACTION_CASES.map((c) => ["action", "a", c] as const),
  ...ACTION_CASES.map((c) => ["action", "n", c] as const),
];

test("no answer, `error.stack`, log line, trace or job error holds a frame or a path of the server's own", async () => {
  const { call, logs, site } = await deployment();
  for (const [kind, module, c] of RUNS)
    for (const fn of ["uncaught", "caught", "logged"]) {
      const text = JSON.stringify(await call(kind, `${module}:${fn}`, { c }));
      expect({ fn: `${module}:${fn}`, c, text, leaks: leaks(text) }).toEqual({
        fn: `${module}:${fn}`,
        c,
        text,
        leaks: false,
      });
    }
  for (const route of ["/fail", "/schedule"]) {
    const r = await fetch(`${site}${route}`);
    const text = await r.text();
    expect({ route, status: r.status, leaks: leaks(text) }).toEqual({ route, status: 500, leaks: false });
  }
  await call("mutation", "m:scheduleFailing");
  let jobs: { state: { kind: string; error?: string } }[] = [];
  for (let i = 0; i < 200 && !jobs.some((j) => j.state.kind === "failed"); i++) {
    await Bun.sleep(10);
    jobs = (await call("query", "m:jobs")).value as typeof jobs;
  }
  const failed = jobs.find((j) => j.state.kind === "failed")!;
  expect(failed.state.error).toMatch(/^Uncaught Error: Provided creation time .*\n {4}at async /);
  expect(leaks(JSON.stringify(jobs))).toBe(false);
  const streamed = await logs();
  expect(streamed).toContain("Provided creation time");
  expect(leaks(streamed)).toBe(false);
});

test("uncaught: the frames of the app's call, `at async` where it awaited a failed syscall", async () => {
  const { call } = await deployment();
  const message = async (path: string, c: string, kind = "mutation") =>
    (await call(kind, path, { c })).errorMessage!.replace(/^\[Request ID: [0-9a-f]{16}\] Server Error\n/, "");
  // Refused after `db.patch` awaited its read: Convex's async syscall error, raised again where the app awaited.
  expect(await message("m:uncaught", "patchCreationTime")).toMatch(
    /^Uncaught Error: Provided creation time [\d.]+ doesn't match '_creationTime' field in .*\n {4}at async <anonymous> \(m\.js:\d+:\d+\)\n {4}at async <anonymous> \(m\.js:\d+:\d+\)\n$/,
  );
  expect(await message("a:uncaught", "scheduleMissing", "action")).toMatch(
    /^Uncaught Error: Attempted to schedule function at nonexistent path: nope\.js\n {4}at async <anonymous> \(a\.js:\d+:\d+\)\n {4}at async <anonymous> \(a\.js:\d+:\d+\)\n$/,
  );
  // Refused before the call returned: the app's frames where it made the call, as Convex's synchronous checks.
  expect(await message("m:uncaught", "systemTable")).toMatch(
    /^Uncaught Error: System tables \(prefixed with `_`\) are read-only\.\n {4}at <anonymous> \(m\.js:\d+:\d+\)\n {4}at <anonymous> \(m\.js:\d+:\d+\)\n$/,
  );
});

test("caught: a V8 `error.stack` is the app's frames alone; a Node one, `Error: <message>` and the frames", async () => {
  const { call } = await deployment();
  const caught = async (path: string, c: string, kind = "mutation") =>
    (await call(kind, path, { c })).value as { name: string; message: string; stack: string };
  const v8 = await caught("m:caught", "patchCreationTime");
  expect(v8.name).toBe("Error");
  expect(v8.stack).toMatch(/^ {4}at async <anonymous> \(m\.js:\d+:\d+\)\n {4}at async <anonymous> \(m\.js:\d+:\d+\)$/);
  const own = await caught("m:caught", "appError");
  expect(own.stack).toMatch(/^ {4}at appError \(m\.js:\d+:\d+\)\n {4}at <anonymous> \(m\.js:\d+:\d+\)$/);
  const app = await caught("m:caught", "appBunvexError");
  expect(app.stack).toMatch(/^ {4}at appBunvexError \(m\.js:\d+:\d+\)\n {4}at <anonymous> \(m\.js:\d+:\d+\)$/);
  const node = await caught("n:caught", "scheduleMissing", "action");
  expect(node.stack).toMatch(
    /^Error: Attempted to schedule function at nonexistent path: nope\.js\n {4}at async <anonymous> \(n\.js:\d+:\d+\)\n {4}at async <anonymous> \(n\.js:\d+:\d+\)$/,
  );
  const nodeOwn = await caught("n:caught", "appBunvexError", "action");
  expect(nodeOwn.stack).toMatch(/^Error: \{"mine":1\}\n {4}at appBunvexError \(n\.js:\d+:\d+\)\n/);
});

test("the context still behaves as the server's: builders, iteration, paginate, db.system, BunvexError", async () => {
  const { call } = await deployment();
  expect((await call("mutation", "m:context")).value).toEqual({
    iterated: 3,
    page: 2,
    done: false,
    ranged: 2,
    first: 2,
    system: 0,
    caught: [true, true, "BunvexError", "foo"],
  });
  // A nested call's BunvexError, made by the server, is the app's `BunvexError` too, data and display kept.
  for (const path of ["a:nested", "n:nested"])
    expect((await call("action", path)).value).toEqual([true, { code: 7 }, 'Uncaught BunvexError: {"code":7}']);
});

// The dashboard's server source (@bunvex/dashboard-source, STUDY-149 PR 4) against a live bunvex server in this
// process: the contract suite's functions, runner, metrics, snapshots, authentication and deployment features
// (environment variables changed), then what the contract does not pin down — the function list's mapping and
// its order, a push heard by `watchFunctions`, the runner as an admin and acting as a user on clients of its own,
// a watched query following its data, custom test queries, the environment variables kept live, the URLs.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { describeDataSourceContract } from "@bunvex/dashboard/contract";
import type { DataSourceError, FunctionRun, LogEntry } from "@bunvex/dashboard/data-source";
import { createServerDataSource, type ServerDataSource } from "@bunvex/dashboard-source";
import { type LiveServer, startLiveServer, until } from "./live-server.ts";

const INSTANCE = "dashboard-source-functions";
let srv: LiveServer;
const sources: ServerDataSource[] = [];
const open = (adminKey = srv.adminKey) => {
  const s = createServerDataSource({ url: srv.url, adminKey, logs: { firstAnswerMs: 500 } });
  sources.push(s);
  return s;
};

const MODULES = [
  {
    path: "schema.js",
    source: `import { defineSchema, defineTable } from "@bunvex/server";
      import { v } from "@bunvex/values";
      export default defineSchema({ messages: defineTable({ body: v.string() }) });`,
  },
  {
    path: "messages.js",
    source: `import { action, internalQuery, mutation, query } from "@bunvex/server";
      import { v } from "@bunvex/values";
      export const send = mutation({ args: { body: v.string() }, handler: async ({ db }, { body }) => {
        console.info("sending", body);
        await db.insert("messages", { body });
        return body.length;
      } });
      export const list = query({ args: { limit: v.optional(v.number()) }, handler: async ({ db }, { limit }) => {
        console.log("listing");
        return (await db.query("messages").collect()).slice(0, limit ?? 100).map((m) => m.body);
      } });
      export const whoami = query({ args: {}, handler: async ({ auth }) => {
        const user = await auth.getUserIdentity();
        return user && { subject: user.subject, name: user.name ?? null };
      } });
      export const secret = internalQuery({ args: { n: v.int64() }, returns: v.int64(), handler: async (_c, { n }) => n * 2n });
      export const loose = query(async () => 1);
      export const act = action({ args: {}, handler: async () => { console.warn("acting"); return "acted"; } });
      export const fails = mutation({ args: {}, handler: async () => { throw new Error("it failed"); } });`,
  },
  {
    path: "dir/nested.js",
    source: `import { query } from "@bunvex/server";
      export default query(async () => "nested");`,
  },
  {
    path: "http.js",
    source: `import { httpAction, httpRouter } from "@bunvex/server";
      const http = httpRouter();
      http.route({ path: "/hello", method: "GET", handler: httpAction(async () => {
        console.log("saying hi");
        return new Response("hi");
      }) });
      export default http;`,
  },
];

beforeAll(async () => {
  srv = await startLiveServer(INSTANCE, MODULES);
  await srv.call("mutation", "messages:send", { body: "first" });
});

afterAll(async () => {
  await Promise.all(sources.map((s) => s.close()));
  srv.stop();
});

describeDataSourceContract("@bunvex/dashboard-source on a live server (functions and settings)", () => open(), {
  only: ["functions", "run", "metrics", "snapshot", "auth", "deploymentFeatures"],
  run: { query: "messages:list", args: { limit: 5 }, misfitArgs: { limit: "five" } },
  environmentVariables: { write: true },
  snapshots: { export: true, import: { table: "imported" } },
});

/** A watcher's next delivery. */
const next = <T>(watch: (onValue: (v: T) => void, onError: (e: DataSourceError) => void) => () => void) =>
  new Promise<T>((resolve, reject) => {
    const off = watch(
      (v) => {
        off();
        resolve(v);
      },
      (e) => {
        off();
        reject(e);
      },
    );
  });

const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: DataSourceError) => e,
  );

describe("the Functions screen (modules:listForAllComponents)", () => {
  test("queries, mutations and actions at module:name, with visibility, line and validators; HTTP routes by route", async () => {
    const fns = await open().listFunctions();
    expect(fns.map((f) => f.path).sort()).toEqual([
      "GET /hello",
      "dir/nested:default",
      "messages:act",
      "messages:fails",
      "messages:list",
      "messages:loose",
      "messages:secret",
      "messages:send",
      "messages:whoami",
    ]);
    const by = Object.fromEntries(fns.map((f) => [f.path, f]));
    expect(by["messages:secret"]).toMatchObject({ kind: "query", visibility: "internal" });
    expect(by["messages:secret"]!.args).toEqual({
      type: "object",
      value: { n: { fieldType: { type: "bigint" }, optional: false } },
    });
    expect(by["messages:secret"]!.returns).toEqual({ type: "bigint" });
    expect(by["messages:act"]).toMatchObject({ kind: "action", visibility: "public" });
    // no validator declared: none listed (it accepts anything)
    expect(by["messages:loose"]!.args).toBeUndefined();
    expect(by["messages:loose"]!.returns).toBeUndefined();
    // a push without source maps records no positions, so no lines (the oracle test has them, from the CLIs)
    expect(fns.every((f) => f.line === undefined)).toBe(true);
  });

  test("an HTTP action: listed under its module, its log lines and metrics under the same name; never run", async () => {
    const src = open();
    const route = (await src.listFunctions()).find((f) => f.kind === "httpAction");
    expect(route).toEqual({ path: "GET /hello", kind: "httpAction", module: "http", visibility: "public" });
    const end = Date.now() + 60_000;
    const w = { start: end - 10 * 60_000, end, numBuckets: 10 };
    const seen: LogEntry[] = [];
    const off = src.watchLogs(
      { function: "GET /hello" },
      (e) => seen.push(...e),
      () => {},
    );
    await src.listLogs({ numItems: 1, cursor: null });
    expect(await (await fetch(`${srv.url}/http/hello`)).text()).toBe("hi");
    await until(() => seen.some((e) => e.execution), "the HTTP action's outcome line");
    off();
    // the Logs screen and the Functions screen's logs name it as the list does
    expect(seen.every((e) => e.function?.path === "GET /hello" && e.function.kind === "httpAction")).toBe(true);
    expect(seen.some((e) => e.message === "saying hi")).toBe(true);
    // its statistics, as Convex's: the server reads a route's metrics with its udfType
    const calls = (await src.functionRate!("GET /hello", "invocations", w)).reduce((n, b) => n + (b.value ?? 0), 0);
    expect(Math.round(calls)).toBeGreaterThanOrEqual(1);
    expect((await src.latencyPercentiles!("GET /hello", [50], w))[0]!.series.some((b) => b.value !== null)).toBe(true);
    // the runner offers queries, mutations and actions only
    expect((await failure(src.runFunction!("GET /hello", {})))?.code).toBe("invalid_request");
  });

  test("a push is heard by watchFunctions, and the list then has the new function", async () => {
    const src = open();
    await src.listFunctions();
    const heard = next<void>((onChange, onError) => src.watchFunctions!(() => onChange(), onError));
    await srv.push([
      ...MODULES,
      {
        path: "later.js",
        source: `import { query } from "@bunvex/server"; export const added = query(async () => 2);`,
      },
    ]);
    await heard;
    expect((await src.listFunctions()).map((f) => f.path)).toContain("later:added");
  });
});

describe("the runner (a client of its own, acting as a user)", () => {
  test("a query: its value and log lines; a mutation; an action; an internal query with int64", async () => {
    const src = open();
    const q = await src.runFunction!("messages:list", {});
    expect(q.value).toEqual(expect.arrayContaining(["first"]));
    expect(q.logLines).toEqual([{ level: "info", message: "'listing'" }]);
    const m = await src.runFunction!("messages:send", { body: "hello" });
    expect(m.value).toBe(5);
    expect(m.logLines).toEqual([{ level: "info", message: "'sending' 'hello'" }]);
    expect((await src.runFunction!("messages:act", {})).value).toBe("acted");
    const big = await src.runFunction!("messages:secret", { n: { $integer: "BQAAAAAAAAA=" } });
    expect(big.value).toEqual({ $integer: "CgAAAAAAAAA=" }); // 5n * 2n
  });

  test("what a function throws is the run's error, not a rejection", async () => {
    const r = await open().runFunction!("messages:fails", {});
    expect(r.value).toBeUndefined();
    expect(r.error?.message).toContain("it failed");
  });

  test("acting as a user: the function sees the identity; the admin alone sees none", async () => {
    const src = open();
    const identity = { subject: "user|1", issuer: "https://issuer.example", name: "Ada" };
    expect((await src.runFunction!("messages:whoami", {}, { identity })).value).toEqual({
      subject: "user|1",
      name: "Ada",
    });
    expect((await src.runFunction!("messages:whoami", {})).value).toBeNull();
    // both at once, on their own clients
    const [as, admin] = await Promise.all([
      src.runFunction!("messages:whoami", {}, { identity: { ...identity, name: "Bea" } }),
      src.runFunction!("messages:whoami", {}),
    ]);
    expect(as.value).toEqual({ subject: "user|1", name: "Bea" });
    expect(admin.value).toBeNull();
  });

  test("a read-only key runs queries only, and cannot act as a user", async () => {
    const src = open(srv.readOnlyKey);
    expect((await src.runFunction!("messages:list", {})).error).toBeUndefined();
    expect((await failure(src.runFunction!("messages:send", { body: "no" })))?.code).toBe("unauthorized");
    expect(
      (await failure(src.runFunction!("messages:whoami", {}, { identity: { subject: "s", issuer: "i" } })))?.code,
    ).toBe("unauthorized");
  });

  test("a watched query follows its data, as the identity asked; it stops when unsubscribed", async () => {
    const src = open();
    const runs: FunctionRun[] = [];
    const off = src.watchFunction!(
      "messages:list",
      { limit: 100 },
      (r) => runs.push(r),
      () => {},
    );
    await until(() => runs.length === 1, "the first run");
    await srv.call("mutation", "messages:send", { body: "watched" });
    await until(() => runs.length === 2, "the run after a write");
    expect(runs[1]!.value).toEqual(expect.arrayContaining(["watched"]));
    off();
    await srv.call("mutation", "messages:send", { body: "unwatched" });
    await Bun.sleep(100);
    expect(runs).toHaveLength(2);
    const who = await next<FunctionRun>((onRun, onError) =>
      src.watchFunction!("messages:whoami", {}, onRun, onError, { identity: { subject: "u2", issuer: "i" } }),
    );
    expect(who.value).toEqual({ subject: "u2", name: null });
  });

  test("an unknown function is not_found; a mutation cannot be watched", async () => {
    const src = open();
    expect((await failure(src.runFunction!("messages:nope", {})))?.code).toBe("not_found");
    const e = await failure(next((onRun, onError) => src.watchFunction!("messages:send", {}, onRun, onError)));
    expect(e?.code).toBe("invalid_request");
  });
});

describe("custom test queries (/api/run_test_function)", () => {
  test("the deployment's data, its log lines; a read-only key may run them", async () => {
    const code =
      'export default query({ handler: async (ctx) => { console.log("counting"); return (await ctx.db.query("messages").collect()).length > 0; } });';
    for (const src of [open(), open(srv.readOnlyKey)]) {
      const r = await src.runTestQuery!(code);
      expect(r.value).toBe(true);
      expect(r.logLines).toEqual([{ level: "info", message: "'counting'" }]);
    }
  });

  test("a module that does not load, and a write, are the run's errors", async () => {
    const src = open();
    expect((await src.runTestQuery!("export default query({")).error?.message).toBeTruthy();
    const w = await src.runTestQuery!(
      'export default query({ handler: async (ctx) => ctx.db.insert("messages", { body: "x" }) });',
    );
    expect(w.error).toBeDefined();
  });

  test("a wrong key is refused", async () => {
    const e = await failure(open(`${srv.adminKey}x`).runTestQuery!("export default query(async () => 1);"));
    expect(e?.code).toBe("unauthorized");
  });
});

describe("Settings", () => {
  test("environment variables: a change from elsewhere (the CLI's route) is heard; a bad name names it", async () => {
    const src = open();
    await src.listEnvironmentVariables!();
    const heard = next<void>((onChange, onError) => src.watchEnvironmentVariables!(() => onChange(), onError));
    const res = await fetch(`${srv.url}/api/update_environment_variables`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bunvex ${srv.adminKey}` },
      body: JSON.stringify({ changes: [{ name: "FROM_CLI", value: "1" }] }),
    });
    expect(res.status).toBe(200);
    await heard;
    expect(await src.listEnvironmentVariables!()).toContainEqual({ name: "FROM_CLI", value: "1" });
    const bad = await failure(src.updateEnvironmentVariables!([{ name: "9lives", value: "x" }]));
    expect(bad?.code).toBe("invalid_request");
    expect(bad?.message).toContain("9lives");
  });

  test("the deployment's URLs (cloudUrl, siteUrl)", async () => {
    const d = await open().getDeployment();
    expect(d.url).toBe(srv.url);
    // this server answers no HTTP actions on a port of its own
    expect(d.httpActionsUrl).toBeUndefined();
  });
});

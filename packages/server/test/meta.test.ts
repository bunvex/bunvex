// `ctx.meta` (STUDY-44), as Convex's: the function's metadata (its stripped name, kind, visibility), the
// transaction's metrics (under a nested call's limits too), the deployment's, the snapshot timestamp (which
// makes a query time-dependent), and the request's — over HTTP, over the sync protocol, from a scheduled
// function and the functions it calls; each method only where Convex has it.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine, MAX_CACHE_AGE_MS } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { action, Functions, internalMutation, internalQuery, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { startIssuer } from "./issuer.ts";
import { v1Client } from "./v1-client.ts";

const SECRET = "7b".repeat(32);
const NAME = "meta-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

type Meta = Record<string, (() => unknown) | undefined>;
const methods = (meta: Meta) => Object.keys(meta).sort();

async function setup(opts: { skew?: { ms: number } } = {}) {
  const issuer = await startIssuer();
  stops.push(issuer.stop);
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()), out: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    {
      instanceName: NAME,
      instanceSecret: SECRET,
      ...(opts.skew ? { cacheClock: () => Date.now() + opts.skew!.ms } : {}),
    },
  ).init();
  let snapshotRuns = 0;
  const functions = new Functions(engine)
    .register("m", {
      q: query(async ({ meta }) => ({
        methods: methods(meta as unknown as Meta),
        fn: await meta.getFunctionMetadata(),
        deployment: await meta.getDeploymentMetadata(),
        metrics: await meta.getTransactionMetrics(),
      })),
      hidden: internalQuery(async ({ meta }) => (await meta.getFunctionMetadata()).visibility),
      snapshot: query(async ({ meta }) => {
        snapshotRuns++;
        return meta.getSnapshotTs().toString();
      }),
      metricsInside: internalQuery(async ({ db, meta }) => {
        await db.query("items").collect();
        return meta.getTransactionMetrics();
      }),
      limited: mutation(async ({ db, runQuery }) => {
        await db.insert("out", { n: 1 });
        return runQuery("m:metricsInside", {}, { transactionLimits: { documentsRead: 5, databaseQueries: 3 } });
      }),
      m: mutation(async ({ meta, runQuery }) => ({
        methods: methods(meta as unknown as Meta),
        fn: await meta.getFunctionMetadata(),
        request: await meta.getRequestMetadata(),
        snapshotTs: meta.getSnapshotTs().toString(),
        nestedSnapshot: await runQuery("m:snapshot", {}),
      })),
      record: internalMutation(async ({ db, meta }) => {
        await db.insert("out", { request: await meta.getRequestMetadata() });
      }),
      a: action(async ({ meta, runMutation }) => {
        await runMutation("m:record", {});
        return {
          methods: methods(meta as unknown as Meta),
          fn: await meta.getFunctionMetadata(),
          request: await meta.getRequestMetadata(),
        };
      }),
      schedule: mutation(async ({ scheduler }) => {
        await scheduler.runAfter(0, "m:a", {});
      }),
    })
    .register("dir/mod", { default: query(async ({ meta }) => (await meta.getFunctionMetadata()).name) });
  const { httpRouter, httpAction } = await import("../src/router.ts");
  const http = httpRouter();
  http.route({
    path: "/meta",
    method: "GET",
    handler: httpAction(async ({ meta }) =>
      Response.json({ fn: await meta.getFunctionMetadata(), request: await meta.getRequestMetadata() }),
    ),
  });
  const { server, stop } = createServer({
    engine,
    functions,
    http,
    port: 0,
    auth: { providers: [{ domain: issuer.url, applicationID: "app" }] },
  });
  stops.push(stop);
  const api = `http://127.0.0.1:${server.port}`;
  const call = async (kind: string, path: string, headers: Record<string, string> = {}) => {
    const r = await fetch(`${api}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ path, args: {} }),
    });
    return ((await r.json()) as { value: Record<string, unknown> }).value;
  };
  return { engine, functions, issuer, server, call, runs: () => snapshotRuns };
}

test("function, deployment and transaction metadata; each method only where Convex has it", async () => {
  const t = await setup();
  const q = (await t.functions.runQuery("m:q", {})) as Record<string, unknown>;
  expect(q.methods).toEqual(["getDeploymentMetadata", "getFunctionMetadata", "getSnapshotTs", "getTransactionMetrics"]);
  expect(q.fn).toEqual({ name: "m:q", componentPath: "", type: "query", visibility: "public" });
  expect(q.deployment).toEqual({ name: NAME, region: null, class: "s16" });
  expect((q.metrics as Record<string, unknown>).documentsWritten).toEqual({ used: 0, remaining: 16000 });
  expect((q.metrics as Record<string, unknown>).filesRead).toEqual({ used: 0, remaining: 10 });
  expect(await t.functions.runQuery("m:hidden", {}, false)).toBe("internal");
  // A default export is named by its module alone.
  expect(await t.functions.runQuery("dir/mod", {})).toBe("dir/mod");
  const m = (await t.functions.runMutation("m:m", {})) as Record<string, unknown>;
  expect(m.methods).toEqual([
    "getDeploymentMetadata",
    "getFunctionMetadata",
    "getRequestMetadata",
    "getSnapshotTs",
    "getTransactionMetrics",
  ]);
  expect(m.fn).toEqual({ name: "m:m", componentPath: "", type: "mutation", visibility: "public" });
  // The snapshot in nanoseconds, shared with a nested query.
  expect(m.nestedSnapshot).toBe(m.snapshotTs);
  expect(BigInt(m.snapshotTs as string)).toBeLessThanOrEqual(t.engine.committer.visibleTs);
  expect(BigInt(m.snapshotTs as string)).toBeGreaterThan(BigInt(Date.now() - 60_000) * 1_000_000n);
  const a = (await t.functions.runAction("m:a", {})) as Record<string, unknown>;
  expect(a.methods).toEqual(["getDeploymentMetadata", "getFunctionMetadata", "getRequestMetadata"]);
  expect((a.fn as Record<string, unknown>).type).toBe("action");
});

test("the metrics follow a nested call's lowered limits", async () => {
  const t = await setup();
  await t.engine.mutation((db) => db.insert("items", { n: 1 }));
  const metrics = (await t.functions.runMutation("m:limited", {})) as Record<
    string,
    { used: number; remaining: number }
  >;
  expect(metrics.documentsRead).toEqual({ used: 1, remaining: 4 });
  expect(metrics.documentsWritten).toEqual({ used: 1, remaining: 15999 });
  expect(metrics.databaseQueries!.used + metrics.databaseQueries!.remaining).toBeLessThan(4096);
});

test("getSnapshotTs makes a query time-dependent, as Date.now()", async () => {
  const skew = { ms: 0 };
  const t = await setup({ skew });
  await t.functions.runQuery("m:snapshot", {});
  await t.functions.runQuery("m:snapshot", {});
  expect(t.runs()).toBe(1);
  skew.ms = MAX_CACHE_AGE_MS + 1000;
  await t.functions.runQuery("m:snapshot", {});
  expect(t.runs()).toBe(2);
});

test("request metadata over HTTP: x-forwarded-for, the user agent, a request id, the user's token", async () => {
  const t = await setup();
  const token = await t.issuer.sign({ sub: "ada" });
  const user = (await t.call("mutation", "m:m", {
    authorization: `Bearer ${token}`,
    "x-forwarded-for": "203.0.113.7, 10.0.0.1",
    "user-agent": "tester/1",
  })) as { request: Record<string, unknown> };
  expect(user.request).toMatchObject({
    ip: "203.0.113.7",
    userAgent: "tester/1",
    scheduledFunctionId: null,
    authToken: token,
  });
  expect(user.request.requestId).toMatch(/^[0-9a-f]{16}$/);
  // An admin key has no token; without x-forwarded-for, the connection's address.
  const admin = (await t.call("mutation", "m:m", { authorization: `Bunvex ${KEY}` })) as {
    request: Record<string, unknown>;
  };
  expect(admin.request.authToken).toBeNull();
  expect(admin.request.ip).toMatch(/127\.0\.0\.1/);
  // An action and the mutation it calls share the request.
  const act = (await t.call("action", "m:a", { "user-agent": "tester/2" })) as { request: Record<string, unknown> };
  const recorded = (await t.engine.query((db) => db.query("out").collect())) as unknown as {
    request: Record<string, unknown>;
  }[];
  expect(recorded.at(-1)!.request).toEqual(act.request);
});

test("request metadata over the sync protocol, and from a scheduled function and what it calls", async () => {
  const t = await setup();
  const c = await v1Client(`ws://127.0.0.1:${t.server.port}/api/1.0.0/sync`);
  stops.push(() => c.ws.close());
  c.mutate(1, "m:m");
  const r = await c.until(() => c.responses()[0]);
  const request = (r as unknown as { result: { request: Record<string, unknown> } }).result.request;
  expect(request).toMatchObject({
    ip: expect.stringMatching(/127\.0\.0\.1/),
    authToken: null,
    scheduledFunctionId: null,
  });
  await t.functions.runMutation("m:schedule", {});
  const jobs = (await t.engine.query((db) => db.system.query("_scheduled_functions").collect())) as { _id: string }[];
  let recorded: { request: Record<string, unknown> }[] = [];
  for (let i = 0; i < 200 && recorded.length === 0; i++) {
    await Bun.sleep(10);
    recorded = (await t.engine.query((db) => db.query("out").collect())) as unknown as typeof recorded;
  }
  // The scheduled action's id reaches the mutation it called.
  expect(recorded[0]!.request).toMatchObject({ ip: null, userAgent: null, scheduledFunctionId: jobs[0]!._id });
});

test("an HTTP action's meta: named `http`, with its request", async () => {
  const t = await setup();
  const r = (await (
    await fetch(`http://127.0.0.1:${t.server.port}/http/meta`, { headers: { "user-agent": "browser/1" } })
  ).json()) as { fn: unknown; request: Record<string, unknown> };
  expect(r.fn).toEqual({ name: "http", componentPath: "", type: "action", visibility: "public" });
  expect(r.request).toMatchObject({ userAgent: "browser/1", authToken: null, scheduledFunctionId: null });
});

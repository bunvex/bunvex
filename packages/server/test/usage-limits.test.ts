// Usage limits (STUDY-61), as Convex's open-source backend: the meter (UTC day and month), the
// `/api/v1/*usage*` routes and their checks, and the worker that disables the deployment while a `disable`
// limit is reached (functions fail with Convex's message) and enables it again, with the audit events.
import { afterEach, describe, expect, test } from "bun:test";
import { DEPLOYMENT_AUDIT_LOG_TABLE, defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { UsageMeter } from "../src/usage-limits.ts";

const SECRET = "9e".repeat(32);
const NAME = "usage-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), memberId: 5 });
const READ_ONLY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), readOnly: true });
const DISABLED =
  "This deployment has been disabled because it exceeded a configured usage limit. Update or disable the usage limit in the deployment settings to resume function execution.";

describe("the meter", () => {
  test("UTC day and month windows; a new day starts at 0, the month goes on; compute in GB-seconds", () => {
    let now = Date.UTC(2026, 9, 3, 23, 59);
    const m = new UsageMeter(() => now);
    m.recordExecution({
      udfType: "Mutation",
      environment: "isolate",
      executionTime: 2,
      userExecutionTime: 2,
      memoryMb: 64,
      databaseIoBytes: 100,
    });
    expect([m.usage("functionCalls", "day"), m.usage("queryMutationComputeGbHours", "day")]).toEqual([1, 0.125]);
    expect(m.usage("databaseIoGb", "month")).toBe(100);
    now = Date.UTC(2026, 9, 4, 0, 1);
    m.record("functionCalls", 1);
    expect([m.usage("functionCalls", "day"), m.usage("functionCalls", "month")]).toEqual([1, 2]);
    // A late sample of yesterday: not today's, still this month's.
    m.record("functionCalls", 1, Date.UTC(2026, 9, 3, 23, 0));
    expect([m.usage("functionCalls", "day"), m.usage("functionCalls", "month")]).toEqual([1, 3]);
    m.recordExecution({
      udfType: "Action",
      environment: "isolate",
      executionTime: 1,
      userExecutionTime: 0.5,
      memoryMb: 64,
      databaseIoBytes: 0,
    });
    expect([m.usage("actionComputeConvexGbHours", "day"), m.usage("actionComputeCpuGbHours", "day")]).toEqual([
      0.0625, 0.03125,
    ]);
  });
});

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: NAME, instanceSecret: SECRET },
  ).init();
  const functions = new Functions(engine).register("m", {
    add: mutation(({ db }) => db.insert("items", {})),
    count: query(async ({ db }) => (await db.query("items").collect()).length),
    uploadUrl: mutation(({ storage }) => storage.generateUploadUrl()),
    urlOf: query(({ storage }, { id }: { id: string }) => storage.getUrl(id as never)),
  });
  const s = createServer({
    engine,
    functions,
    port: 0,
    usageLimitIntervalMs: 3_600_000,
    fileStorage: new MemoryBlobStore(),
  });
  stops.push(() => s.stop());
  const api = `http://127.0.0.1:${s.server.port}/api`;
  const call = async (kind: string, path: string, args: object = {}) =>
    (await (await fetch(`${api}/${kind}`, { method: "POST", body: JSON.stringify({ path, args }) })).json()) as {
      status: string;
      value?: any;
      errorMessage?: string;
    };
  const req = async (path: string, body?: unknown, key = KEY) => {
    const r = await fetch(`${api}/v1/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bunvex ${key}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  const audit = async () =>
    ((await engine.query((db) => db.asSystem(() => db.query(DEPLOYMENT_AUDIT_LOG_TABLE).collect()))) as any[]).map(
      (e) => [e.action, e.metadata],
    );
  return { engine, s, call, req, audit };
}

test("get_current_usage: every metric with its unit, this process's day and month, seed pending", async () => {
  const t = await setup();
  await t.call("mutation", "m:add");
  await t.call("query", "m:count");
  const u = (await t.req("get_current_usage")).body;
  expect(u.seedStatus).toBe("pending");
  expect(Object.keys(u.metrics)).toEqual([
    "actionComputeConvexGbHours",
    "actionComputeCpuGbHours",
    "actionComputeNodeJsGbHours",
    "aiGatewayCostDollars",
    "dataEgressGb",
    "databaseIoGb",
    "functionCalls",
    "queryMutationComputeGbHours",
    "searchQueryGb",
  ]);
  expect(u.metrics.functionCalls).toEqual({ unit: "calls", usage: { current_day: 2, current_month: 2 } });
  expect(u.metrics.queryMutationComputeGbHours.unit).toBe("GB-hours");
  // Compute can round to 0 for calls under a millisecond; the meter test checks the arithmetic.
  expect(u.metrics.queryMutationComputeGbHours.usage.current_day).toBeGreaterThanOrEqual(0);
  expect(u.metrics.databaseIoGb.usage.current_day).toBeGreaterThan(0);
  expect((await t.req("get_current_usage", undefined, READ_ONLY)).status).toBe(200);
});

test("create, list, update, delete: Convex's shapes, checks, errors and audit events", async () => {
  const t = await setup();
  const limit = { metric: "functionCalls", window: "day", limitType: "disable", limit: 100, enabled: true };
  const created = await t.req("create_usage_limit", limit);
  expect(created.status).toBe(200);
  const id = created.body.usageLimit.id;
  expect(created.body).toEqual({ usageLimit: { id, ...limit } });
  expect((await t.req("list_usage_limits")).body).toEqual({ usageLimits: [{ id, ...limit }] });
  expect(await t.req("create_usage_limit", limit)).toEqual({
    status: 400,
    body: {
      code: "DuplicateUsageLimit",
      message: "A usage limit already exists for this metric, window, and limit type.",
    },
  });
  expect((await t.req("create_usage_limit", { ...limit, limit: 0 })).body).toEqual({
    code: "InvalidUsageLimit",
    message: "Usage limits must have a positive limit.",
  });
  expect((await t.req("create_usage_limit", { ...limit, metric: "nope" })).body.code).toBe("BadJsonBody");
  expect((await t.req("create_usage_limit", limit, READ_ONLY)).body.code).toBe("OperationNotPermitted");
  // Below the usage so far (enabled only).
  await t.call("mutation", "m:add");
  await t.call("mutation", "m:add");
  const below = { metric: "functionCalls", window: "month", limitType: "warning", limit: 1, enabled: true };
  expect((await t.req("create_usage_limit", below)).body).toEqual({
    code: "UsageLimitBelowCurrentUsage",
    message:
      "Usage limit of 1 is below the current month usage of 2 for functionCalls. Set the limit at or above the current usage.",
  });
  expect((await t.req("create_usage_limit", { ...below, enabled: false })).status).toBe(200);
  const updated = await t.req(`update_usage_limit/${id}`, { ...limit, limit: 200 });
  expect(updated.body.usageLimit.limit).toBe(200);
  expect((await t.req("update_usage_limit/abc", limit)).body).toEqual({
    code: "InvalidId",
    message: "Invalid ID for table _usage_limits",
  });
  expect((await t.req(`delete_usage_limit/${id}`, {})).status).toBe(200);
  expect(await t.req(`delete_usage_limit/${id}`, {})).toEqual({
    status: 404,
    body: { code: "UsageLimitNotFound", message: "The usage limit couldn't be found." },
  });
  const events = await t.audit();
  expect(events.map(([a]) => a)).toEqual([
    "create_usage_limit",
    "create_usage_limit",
    "update_usage_limit",
    "delete_usage_limit",
  ]);
  expect(events[2][1]).toMatchObject({ id, previous: { limit: 100n }, current: { limit: 200n } });
});

test("a reached disable limit disables the deployment until the limit is lifted; warnings only report", async () => {
  const t = await setup();
  await t.call("mutation", "m:add");
  const disable = { metric: "functionCalls", window: "day", limitType: "disable", limit: 3, enabled: true };
  const warn = { ...disable, limitType: "warning", limit: 2 };
  const { id } = (await t.req("create_usage_limit", disable)).body.usageLimit;
  const w = (await t.req("create_usage_limit", warn)).body.usageLimit.id;
  await t.call("mutation", "m:add"); // 2 calls: the warning is reached
  await t.s.usageLimitWorker.wake();
  expect((await t.call("query", "m:count")).status).toBe("success"); // 3: still running until evaluated
  await t.s.usageLimitWorker.wake();
  const refused = await t.call("mutation", "m:add");
  expect(refused.status).toBe("error");
  expect(refused.errorMessage).toEndWith(`${DISABLED}\n`);
  expect((await t.req("get_current_usage")).status).toBe(200);
  // Raised: enabled again.
  await t.req(`update_usage_limit/${id}`, { ...disable, limit: 10 });
  await t.s.usageLimitWorker.wake();
  expect((await t.call("mutation", "m:add")).status).toBe("success");
  const events = (await t.audit()).filter(
    ([a]) => a === "usage_limit_exceeded" || a === "change_usage_limit_stop_state",
  );
  expect(events).toEqual([
    ["usage_limit_exceeded", { id: w, config: { ...warn, limit: 2n } }],
    ["usage_limit_exceeded", { id, config: { ...disable, limit: 3n } }],
    ["change_usage_limit_stop_state", { old_state: "none", new_state: "disabled" }],
    ["change_usage_limit_stop_state", { old_state: "disabled", new_state: "none" }],
  ]);
});

test("the function log's memoryUsedMb is Convex's isolate heap", async () => {
  const t = await setup();
  await t.call("mutation", "m:add");
  const c = (t.s.functionLog as any).parts.at(-1).part;
  expect(c.usageStats.memoryUsedMb).toBe(64);
});

test("file uploads and downloads count as calls, a download's bytes as egress", async () => {
  const t = await setup();
  const url = (await t.call("mutation", "m:uploadUrl")).value as string;
  const { storageId } = (await (await fetch(url, { method: "POST", body: "hello" })).json()) as { storageId: string };
  const fileUrl = (await t.call("query", "m:urlOf", { id: storageId })).value as string;
  expect(await (await fetch(fileUrl)).text()).toBe("hello");
  const u = (await t.req("get_current_usage")).body.metrics;
  // uploadUrl, urlOf, the upload and the download.
  expect(u.functionCalls.usage.current_day).toBe(4);
  expect(u.dataEgressGb.usage.current_day).toBe(5 / 2 ** 30);
});

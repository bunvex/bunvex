// Log streams (STUDY-59), as Convex's: the `/api/v1/*_log_stream*` API with its checks, audit events and
// answers; the worker that verifies, starts and fails sinks; webhook delivery (V2 JSON, json / jsonl,
// topics, the HMAC signature) and the local sink; the events functions, the audit log and the scheduler send.
import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEPLOYMENT_AUDIT_LOG_TABLE, defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { Functions, mutation } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const SECRET = "7c".repeat(32);
const NAME = "sinks-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), memberId: 2 });
const READ_ONLY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), readOnly: true });

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

const until = async <T>(f: () => T | undefined | false | Promise<T | undefined | false>, what = "condition") => {
  for (let i = 0; i < 400; i++) {
    const x = await f();
    if (x) return x;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** A webhook endpoint: records each request; `status` decides the answer. */
function receiver() {
  const got: { body: string; signature: string | null; contentType: string | null }[] = [];
  let status = 200;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      got.push({
        body: await req.text(),
        signature: req.headers.get("x-webhook-signature"),
        contentType: req.headers.get("content-type"),
      });
      return new Response(null, { status });
    },
  });
  stops.push(() => server.stop(true));
  const events = () =>
    got.flatMap((g) => (g.body.startsWith("[") ? JSON.parse(g.body) : g.body.split("\n").map((l) => JSON.parse(l))));
  return { url: `http://127.0.0.1:${server.port}/hook`, got, events, setStatus: (s: number) => (status = s) };
}

async function setup(opts: { localLogSink?: string; engine?: Engine; fetch?: typeof fetch } = {}) {
  const engine =
    opts.engine ??
    (await new Engine(
      defineSchema({ items: defineTable(v.any()) }),
      await MemoryPersistence.open(null, { durable: false }),
      { instanceName: NAME, instanceSecret: SECRET },
    ).init());
  const functions = new Functions(engine).register("m", {
    add: mutation(async ({ db }) => {
      console.log("adding", 1);
      return db.insert("items", {});
    }),
    fail: mutation(() => {
      throw new Error("nope");
    }),
  });
  const s = createServer({
    engine,
    functions,
    port: 0,
    ...(opts.localLogSink ? { localLogSink: opts.localLogSink } : {}),
    logSinks: {
      aggregationMs: 20,
      webhookBackoffMs: [1, 2],
      localBackoffMs: [1, 2],
      providerBackoffMs: [1, 2],
      random: () => 0,
      // Never the real providers: a test that does not route them gets a refusal.
      fetch: opts.fetch ?? ((async () => new Response(null, { status: 403 })) as unknown as typeof fetch),
    },
  });
  stops.push(() => s.stop());
  await s.logSinksReady;
  const api = `http://127.0.0.1:${s.server.port}/api`;
  const req = async (path: string, body?: unknown, key = KEY) => {
    const r = await fetch(`${api}/v1/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bunvex ${key}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  const call = (path: string) =>
    fetch(`${api}/mutation`, { method: "POST", body: JSON.stringify({ path, args: {} }) }).then((r) => r.json());
  const status = async (id: string) => (await req(`get_log_stream/${id}`)).body?.status;
  const audit = async () =>
    ((await engine.query((db) => db.asSystem(() => db.query(DEPLOYMENT_AUDIT_LOG_TABLE).collect()))) as any[]).map(
      (e) => [e.action, e.metadata],
    );
  return { engine, s, req, call, status, audit };
}

test("a webhook stream: created, verified and signed; functions' events as V2 JSON Lines", async () => {
  const hook = receiver();
  const t = await setup();
  const created = await t.req("create_log_stream", { logStreamType: "webhook", url: hook.url, format: "jsonl" });
  expect(created.status).toBe(200);
  const { id, hmacSecret } = created.body;
  expect(created.body.logStreamType).toBe("webhook");
  expect(hmacSecret).toMatch(/^[0-9a-f]{32}$/);
  await until(async () => (await t.status(id))?.type === "active", "the stream to be active");
  // The verification event, signed with the secret over the exact body.
  const first = hook.got[0]!;
  expect(first.signature).toBe(`sha256=${createHmac("sha256", hmacSecret).update(first.body).digest("hex")}`);
  expect(first.contentType).toBe("application/json");
  expect(JSON.parse(first.body)).toMatchObject({
    topic: "verification",
    message: "Log stream connection test",
    deployment: { deployment_name: NAME },
  });
  await t.call("m:add");
  await t.call("m:fail");
  const events = await until(() => {
    const e = hook.events();
    return e.filter((x) => x.topic === "function_execution").length >= 2 && e;
  }, "the function events");
  // `jsonl`: one object per line, no array.
  expect(hook.got.every((g) => g.body.startsWith("{"))).toBe(true);
  expect(hook.got.some((g) => g.body.includes("\n"))).toBe(true);
  const console_ = events.find((e) => e.topic === "console")!;
  expect(console_).toMatchObject({
    topic: "console",
    function: { path: "m.js:add", type: "mutation", cached: null, mutation_queue_length: null },
    log_level: "LOG",
    message: "'adding' 1",
    is_truncated: false,
    system_code: null,
  });
  const execs = events.filter((e) => e.topic === "function_execution");
  expect(execs.map((e) => [e.function.path, e.status, e.run_reason])).toEqual([
    ["m.js:add", "success", "httpApi"],
    ["m.js:fail", "failure", "httpApi"],
  ]);
  expect(execs[1].error_message).toContain("nope");
  expect(Object.keys(execs[0].usage)).toContain("database_write_documents");
  // Exceptions only go to the local sink (and error trackers).
  expect(events.some((e) => e._topic === "_exception")).toBe(false);
  expect(await t.audit()).toEqual([["create_integration", { id, type: "webhook" }]]);
});

test("topics: only those subscribed (verification always); json format; the audit log streamed", async () => {
  const hook = receiver();
  const t = await setup();
  const { id } = (
    await t.req("create_log_stream", { logStreamType: "webhook", url: hook.url, format: "json", topics: ["audit_log"] })
  ).body;
  await until(async () => (await t.status(id))?.type === "active");
  await t.call("m:add");
  await t.req(`rotate_webhook_secret/${id}`, {});
  const events = await until(() => {
    const e = hook.events();
    return e.some((x) => x.topic === "audit_log") && e;
  }, "the audit event");
  expect(events.map((e) => e.topic).sort()).toEqual(["audit_log", "verification"]);
  // `json`: every body is a JSON array.
  expect(hook.got.every((g) => g.body.startsWith("["))).toBe(true);
  const a = events.find((e) => e.topic === "audit_log");
  expect(a.audit_log_action).toBe("update_integration");
  expect(JSON.parse(a.audit_log_metadata)).toEqual({ id, type: "webhook" });
});

test("a failing verification fails the stream with Convex's reason; an update verifies again", async () => {
  const hook = receiver();
  hook.setStatus(404);
  const t = await setup();
  const { id } = (await t.req("create_log_stream", { logStreamType: "webhook", url: hook.url, format: "json" })).body;
  const failed = await until(async () => {
    const s = await t.status(id);
    return s?.type === "failed" && s;
  });
  expect(failed.reason).toBe("endpoint rejected the request with 404 Not Found");
  hook.setStatus(503);
  await t.req(`update_log_stream/${id}`, { logStreamType: "webhook", format: "jsonl" });
  const again = await until(async () => {
    const s = await t.status(id);
    return s?.type === "failed" && s;
  });
  expect(again.reason).toBe("gave up after 3 attempts, last failure: endpoint returned 503 Service Unavailable");
  hook.setStatus(200);
  await t.req(`update_log_stream/${id}`, { logStreamType: "webhook" });
  await until(async () => (await t.status(id))?.type === "active");
});

test("the API's checks and errors", async () => {
  const hook = receiver();
  const t = await setup();
  const create = (b: object, key?: string) => t.req("create_log_stream", { logStreamType: "webhook", ...b }, key);
  expect(await create({ url: "nope", format: "json" })).toEqual({
    status: 400,
    body: { code: "InvalidWebhookUrl", message: "The URL passed was invalid" },
  });
  expect((await create({ url: hook.url, format: "json", topics: [] })).body.code).toBe("EmptyLogTopics");
  expect((await create({ url: hook.url, format: "json", topics: ["exception"] })).body).toEqual({
    code: "InvalidLogTopic",
    message: "Log stream topic `exception` cannot be subscribed to",
  });
  expect((await create({ url: hook.url, format: "json", topics: ["custom_audit"] })).status).toBe(403);
  expect((await create({ url: hook.url })).body).toEqual({ code: "BadJsonBody", message: "missing field `format`" });
  expect((await create({ url: hook.url, format: "json" }, READ_ONLY)).body.code).toBe("OperationNotPermitted");
  const { id } = (await create({ url: hook.url, format: "json" })).body;
  expect(await create({ url: hook.url, format: "json" })).toEqual({
    status: 409,
    body: { code: "LogStreamAlreadyExists", message: "Webhook log stream already exists for this deployment" },
  });
  expect((await t.req(`update_log_stream/${id}`, { logStreamType: "sentry" })).body).toEqual({
    code: "LogStreamTypeMismatch",
    message: "Cannot update a Webhook log stream with arguments for a different log stream type",
  });
  expect((await t.req("get_log_stream/abc")).body.code).toBe("InvalidLogStreamId");
  expect((await t.req("create_log_stream", { logStreamType: "sentry", dsn: "x" })).body.code).toBe("InvalidSentryDsn");
  expect(
    (
      await t.req("create_log_stream", {
        logStreamType: "axiom",
        apiKey: "k",
        datasetName: "d",
        attributes: [],
        ingestUrl: "https://x",
      })
    ).body.code,
  ).toBe("InvalidAxiomIngestUrl");
  // Another type: stored and listed (no API key); here its endpoint refuses the key.
  const dd = await t.req("create_log_stream", {
    logStreamType: "datadog",
    siteLocation: "EU",
    ddApiKey: "secret",
    ddTags: ["a"],
  });
  const ddStatus = await until(async () => {
    const s = await t.status(dd.body.id);
    return s?.type === "failed" && s;
  });
  expect(ddStatus.reason).toBe("endpoint rejected the request with 403 Forbidden");
  const list = (await t.req("list_log_streams")).body;
  expect(list.map((x: any) => x.logStreamType).sort()).toEqual(["datadog", "webhook"]);
  expect(list.find((x: any) => x.logStreamType === "datadog")).not.toHaveProperty("ddApiKey");
  expect((await t.req(`rotate_webhook_secret/${dd.body.id}`, {})).body.code).toBe("NoSecretToRotate");
  // Delete: gone from the table once the worker ran; 404 after.
  expect((await t.req(`delete_log_stream/${id}`, {})).status).toBe(200);
  expect((await t.req(`get_log_stream/${id}`)).status).toBe(404);
  await until(async () => (await t.req("list_log_streams")).body.length === 1, "the row to go");
  expect((await t.audit()).map(([a]) => a)).toEqual(["create_integration", "create_integration", "delete_integration"]);
});

test("the local sink: every event as a V2 line, exceptions too, kept across a restart without verifying", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-sink-"));
  const path = join(dir, "logs.jsonl");
  const t = await setup({ localLogSink: path });
  await t.call("m:add");
  await t.call("m:fail");
  const lines = await until(() => {
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {}
    const ls = text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    return ls.some((l) => l._topic === "_exception") && ls;
  }, "the local log lines");
  expect(lines.map((l) => l.topic ?? l._topic)).toEqual([
    "console",
    "function_execution",
    "function_execution",
    "_exception",
  ]);
  // The local sink is not in the API.
  expect((await t.req("list_log_streams")).body).toEqual([]);
  // A webhook made active, then a restart on the same store: started again without verification.
  const hook = receiver();
  const { id } = (await t.req("create_log_stream", { logStreamType: "webhook", url: hook.url, format: "json" })).body;
  await until(async () => (await t.status(id))?.type === "active");
  const verifications = hook.got.length;
  t.s.stop();
  const again = await setup({ engine: t.engine });
  await until(async () => (await again.status(id))?.type === "active");
  expect(hook.got.length).toBe(verifications);
});

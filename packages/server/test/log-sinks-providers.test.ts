// The provider log stream sinks (STUDY-70), as Convex's: Datadog, Axiom, Sentry, PostHog Logs and PostHog
// Error Tracking — URLs, headers, payloads, batching, verification, failures — through the whole pipeline
// (a stream created over the API, functions that log and fail), against a fetch that records each request.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { BunvexError, v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { Functions, mutation } from "../src/functions.ts";
import { parseDsn, sizedBatches } from "../src/log-sinks-providers.ts";
import { createServer } from "../src/server.ts";

const SECRET = "d4".repeat(32);
const NAME = "sinks-providers";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), memberId: 3 });

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

type Sent = { url: string; headers: Record<string, string>; body: string };

/** A fetch that records requests; `answer` decides the status (and headers) by URL. */
function recorder(answer: (url: string) => number | Response = () => 200) {
  const sent: Sent[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    sent.push({ url, headers, body: String(init?.body ?? "") });
    const a = answer(url);
    return typeof a === "number" ? new Response(null, { status: a }) : a;
  }) as unknown as typeof fetch;
  return { sent, fetch: f };
}

const until = async <T>(f: () => T | undefined | false | Promise<T | undefined | false>, what = "condition") => {
  for (let i = 0; i < 400; i++) {
    const x = await f();
    if (x) return x;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
};

async function setup(sinkFetch: typeof fetch) {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: NAME, instanceSecret: SECRET },
  ).init();
  const functions = new Functions(engine).register("m", {
    add: mutation(async ({ db }) => {
      console.warn("careful");
      return db.insert("items", {});
    }),
    fail: mutation(() => {
      throw new BunvexError({ code: 7 });
    }),
  });
  const s = createServer({
    engine,
    functions,
    port: 0,
    logSinks: { aggregationMs: 20, providerBackoffMs: [1, 2], random: () => 0, fetch: sinkFetch },
  });
  stops.push(() => s.stop());
  await s.logSinksReady;
  const api = `http://127.0.0.1:${s.server.port}/api`;
  const req = async (path: string, body?: unknown) => {
    const r = await fetch(`${api}/v1/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bunvex ${KEY}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  };
  const call = (path: string) => fetch(`${api}/mutation`, { method: "POST", body: JSON.stringify({ path, args: {} }) });
  const create = async (body: object) => {
    const { id } = await req("create_log_stream", body);
    const status = await until(async () => {
      const s = (await req(`get_log_stream/${id}`)).status;
      return s.type !== "pending" && s;
    }, "the stream to start");
    return { id, status };
  };
  return { create, call };
}

describe("Datadog", () => {
  test("verification and events: Convex's URL, headers and wrapper, bunvex's names; no exceptions", async () => {
    const r = recorder(() => 202);
    const t = await setup(r.fetch);
    const { status } = await t.create({
      logStreamType: "datadog",
      siteLocation: "EU",
      ddApiKey: "dd-key",
      ddTags: ["a", "b"],
    });
    expect(status).toEqual({ type: "active" });
    const [verify] = r.sent;
    expect(verify!.url).toBe("https://http-intake.logs.datadoghq.eu/api/v2/logs");
    expect(verify!.headers).toMatchObject({
      "dd-api-key": "dd-key",
      "content-type": "application/json",
      "user-agent": "Bunvex/1.0",
    });
    expect(JSON.parse(verify!.body)).toEqual([
      expect.objectContaining({
        ddsource: "bunvex",
        ddtags: "a,b",
        hostname: NAME,
        service: null,
        topic: "verification",
        deployment: expect.objectContaining({ deployment_name: NAME }),
      }),
    ]);
    await t.call("m:add");
    await t.call("m:fail");
    const events = await until(() => {
      const all = r.sent.slice(1).flatMap((x) => JSON.parse(x.body));
      return all.filter((e: any) => e.topic === "function_execution").length >= 2 && all;
    });
    expect(events.map((e: any) => e.topic).sort()).toEqual(["console", "function_execution", "function_execution"]);
  });

  test("a refused key fails at once", async () => {
    const r = recorder(() => 403);
    const t = await setup(r.fetch);
    expect(
      (await t.create({ logStreamType: "datadog", siteLocation: "US1", ddApiKey: "k", ddTags: [] })).status,
    ).toEqual({
      type: "failed",
      reason: "endpoint rejected the request with 403 Forbidden",
    });
    expect(r.sent.length).toBe(1);
  });

  test("a 503 gives up after 6 attempts", async () => {
    const r = recorder(() => 503);
    const t = await setup(r.fetch);
    expect(
      (await t.create({ logStreamType: "datadog", siteLocation: "US1", ddApiKey: "k", ddTags: [] })).status,
    ).toEqual({
      type: "failed",
      reason: "gave up after 6 attempts, last failure: endpoint returned 503 Service Unavailable",
    });
    expect(r.sent.length).toBe(6);
    expect(r.sent[0]!.url).toBe("https://http-intake.logs.datadoghq.com/api/v2/logs");
  });

  test("batches of at most 1000 entries and 4 MiB, brackets and commas counted", () => {
    expect(
      sizedBatches(
        Array.from({ length: 1001 }, () => "{}"),
        1000,
        1 << 30,
      ).map((b) => JSON.parse(b).length),
    ).toEqual([1000, 1]);
    // 10 bytes each: [a] is 12 bytes, [a,b] 23.
    const ten = Array.from({ length: 4 }, () => `"${"x".repeat(8)}"`);
    expect(sizedBatches(ten, 1000, 23).length).toBe(2);
    expect(sizedBatches(ten, 1000, 22).length).toBe(4);
    // Bytes, not characters: "é" is 2 bytes, so 5 characters weigh 10.
    expect(
      sizedBatches(
        Array.from({ length: 4 }, () => `"${"é".repeat(4)}"`),
        1000,
        22,
      ).length,
    ).toBe(4);
  });
});

describe("Axiom", () => {
  test("the default and edge URLs, Bearer auth, events nested under `data` with sorted attributes", async () => {
    const r = recorder(() => 200);
    const t = await setup(r.fetch);
    await t.create({
      logStreamType: "axiom",
      apiKey: "ax",
      datasetName: "logs",
      attributes: [
        { key: "z", value: "1" },
        { key: "a", value: "2" },
        { key: "z", value: "3" },
      ],
    });
    const [verify] = r.sent;
    expect(verify!.url).toBe("https://api.axiom.co/v1/datasets/logs/ingest");
    expect(verify!.headers.authorization).toBe("Bearer ax");
    const [item] = JSON.parse(verify!.body);
    expect(Object.keys(item.attributes)).toEqual(["a", "z"]);
    expect(item).toMatchObject({
      data: { topic: "verification" },
      attributes: { a: "2", z: "3" },
      deployment: { deployment_name: NAME },
    });
    expect(item._time).toBe(item.data.timestamp);
  });

  test("an edge ingest URL", async () => {
    const r = recorder(() => 200);
    const t = await setup(r.fetch);
    await t.create({
      logStreamType: "axiom",
      apiKey: "ax",
      datasetName: "logs",
      attributes: [],
      ingestUrl: "https://eu-central-1.aws.edge.axiom.co",
    });
    expect(r.sent[0]!.url).toBe("https://eu-central-1.aws.edge.axiom.co/v1/ingest/logs");
  });
});

describe("Sentry", () => {
  test("no request to verify; one envelope per exception with Convex's event shape; status ignored", async () => {
    const r = recorder(() => 500);
    const t = await setup(r.fetch);
    const { status } = await t.create({
      logStreamType: "sentry",
      dsn: "http://pub:sec@127.0.0.1:9/42",
      tags: { team: "core", func: "overridden" },
    });
    expect(status).toEqual({ type: "active" });
    expect(r.sent).toEqual([]);
    await t.call("m:add"); // not an exception: never sent
    await t.call("m:fail");
    await until(() => r.sent.length === 1);
    const [env] = r.sent;
    expect(env!.url).toBe("http://127.0.0.1:9/api/42/envelope/");
    expect(env!.headers["x-sentry-auth"]).toMatch(
      /^Sentry sentry_key=pub, sentry_version=7, sentry_timestamp=[\d.]+, sentry_client=bunvex\/unknown, sentry_secret=sec$/,
    );
    expect(env!.headers["content-type"]).toBeUndefined();
    const [head, item, body, end] = env!.body.split("\n");
    expect(end).toBe("");
    expect(JSON.parse(item!)).toEqual({ type: "event", length: Buffer.byteLength(body!) });
    const event = JSON.parse(body!);
    expect(JSON.parse(head!)).toEqual({ event_id: event.event_id });
    expect(event.event_id).toMatch(/^[0-9a-f]{32}$/);
    expect(event).not.toHaveProperty("level");
    expect(event).toMatchObject({
      platform: "node",
      server_name: NAME,
      tags: { team: "core", func: "m.js:fail", func_type: "mutation", func_runtime: "default" },
      contexts: { BunvexError: { type: "unknown", data: { code: 7 } } },
      sdk: { name: "bunvex", version: "unknown" },
    });
    const exception = event.exception.values[0];
    expect(exception.type).toBe("Error");
    // Oldest first: the throw site, in this file, is the last frame.
    expect(exception.stacktrace.frames.at(-1).filename).toEndWith("log-sinks-providers.test.ts");
    // The 500 was not retried.
    await Bun.sleep(100);
    expect(r.sent.length).toBe(1);
  });

  test("a 429 turns sends off for 60 s", async () => {
    const r = recorder(() => 429);
    const t = await setup(r.fetch);
    await t.create({ logStreamType: "sentry", dsn: "https://k@o1.ingest.example.io/42" });
    await t.call("m:fail");
    await until(() => r.sent.length === 1);
    await t.call("m:fail");
    await Bun.sleep(150);
    expect(r.sent.length).toBe(1);
  });

  test("Sentry's DSN rules: any project segment, a path prefix", () => {
    expect(parseDsn("https://k@o1.ingest.sentry.io/42").envelopeUrl).toBe(
      "https://o1.ingest.sentry.io/api/42/envelope/",
    );
    expect(parseDsn("https://k@h.io/prefix/abc").envelopeUrl).toBe("https://h.io/prefix/api/abc/envelope/");
    expect(() => parseDsn("https://h.io/42")).toThrow();
  });
});

describe("PostHog", () => {
  test("Logs: /decide verification once; OTLP records with severities and bunvex's attribute names", async () => {
    const r = recorder(() => 200);
    const t = await setup(r.fetch);
    await t.create({ logStreamType: "postHogLogs", apiKey: "ph", host: "http://127.0.0.1:7" });
    const [verify] = r.sent;
    expect(verify!.url).toBe("http://127.0.0.1:7/decide?v=3");
    expect(verify!.headers.authorization).toBeUndefined();
    expect(JSON.parse(verify!.body)).toEqual({ api_key: "ph", distinct_id: "bunvex-verification" });
    await t.call("m:add");
    await t.call("m:fail");
    const records = await until(() => {
      const all = r.sent.slice(1).flatMap((x) => JSON.parse(x.body).resourceLogs[0].scopeLogs[0].logRecords as any[]);
      return all.length >= 3 && all;
    });
    const posted = r.sent[1]!;
    expect(posted.url).toBe("http://127.0.0.1:7/i/v1/logs");
    expect(posted.headers.authorization).toBe("Bearer ph");
    const doc = JSON.parse(posted.body).resourceLogs[0];
    expect(doc.resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: NAME } },
      { key: "bunvex.deployment.name", value: { stringValue: NAME } },
    ]);
    expect(doc.scopeLogs[0].scope).toEqual({ name: "bunvex" });
    const warn = records.find((x: any) => x.severityText === "WARN");
    expect(warn.severityNumber).toBe(13);
    expect(JSON.parse(warn.body.stringValue)).toMatchObject({ topic: "console", message: "'careful'" });
    expect(warn.timeUnixNano).toBe(`${BigInt(JSON.parse(warn.body.stringValue).timestamp) * 1_000_000n}`);
    expect(warn.attributes.map((a: any) => a.key)).toEqual([
      "bunvex.topic",
      "bunvex.function.path",
      "bunvex.function.type",
    ]);
    const failed = records.find((x: any) => x.severityText === "ERROR");
    expect(failed.severityNumber).toBe(17);
  });

  test("a refused token fails verification after one request", async () => {
    const r = recorder(() => 401);
    const t = await setup(r.fetch);
    expect(
      (await t.create({ logStreamType: "postHogLogs", apiKey: "bad", host: "http://127.0.0.1:7" })).status,
    ).toEqual({
      type: "failed",
      reason: "Failed to verify PostHog project token: endpoint rejected the request with 401 Unauthorized",
    });
    expect(r.sent.length).toBe(1);
  });

  test("Error Tracking: $exception captures with bunvex's properties, only exceptions", async () => {
    const r = recorder(() => 200);
    const t = await setup(r.fetch);
    await t.create({ logStreamType: "postHogErrorTracking", apiKey: "pe", host: "http://127.0.0.1:8" });
    await t.call("m:add");
    await t.call("m:fail");
    const post = await until(() => r.sent.find((x) => x.url.endsWith("/i/v0/e/")));
    expect(post.url).toBe("http://127.0.0.1:8/i/v0/e/");
    const body = JSON.parse(post.body);
    expect(body.api_key).toBe("pe");
    expect(body.batch).toHaveLength(1);
    const [capture] = body.batch;
    expect(capture.event).toBe("$exception");
    expect(capture.distinct_id).toBe(NAME);
    expect(capture.timestamp).toMatch(/\+00:00$/);
    expect(capture.properties).toMatchObject({
      $exception_level: "error",
      $exception_types: ["Error"],
      $lib: "bunvex",
      bunvex_function: "m.js:fail",
      bunvex_function_type: "mutation",
      bunvex_function_runtime: "default",
      bunvex_deployment: NAME,
    });
    expect(capture.properties.$exception_list[0]).toMatchObject({
      type: "Error",
      mechanism: { handled: false, type: "generic" },
      stacktrace: { type: "raw" },
    });
  });
});

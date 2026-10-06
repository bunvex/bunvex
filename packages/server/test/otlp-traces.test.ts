// Traces over OTLP (STUDY-131 AD-26): an in-process collector receives what the server exports and checks
// the OTLP/HTTP JSON shape, the span tree of a request and of a sync re-run, sampling, `traceparent`
// continuation, the bounded queue, retries and the flush on close; and the OpenTelemetry environment
// variables that configure it.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine, NO_TRACER, newSpanId, newTraceId, Span, Tracer } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { cronJobs } from "../src/cron.ts";
import { Functions, mutation, query } from "../src/functions.ts";
import { encodeTraces, OTLP_DEFAULTS, type OtlpConfig, OtlpExporter, tracingFromEnv } from "../src/otlp.ts";
import { createServer } from "../src/server.ts";
import { add, syncUrl, v1Client } from "./v1-client.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

// ------------------------------------------------------------------------------------------- the collector

type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceState?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: Record<string, unknown> }[];
  status?: { code: number; message?: string };
};
type Received = { method: string; path: string; headers: Headers; body: Record<string, unknown> };

/** An OTLP/HTTP receiver in process: it keeps every request, and answers with `respond` (default 200 `{}`). */
function collector(respond: (n: number) => Response = () => Response.json({})) {
  const received: Received[] = [];
  let n = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      received.push({
        method: req.method,
        path: new URL(req.url).pathname,
        headers: req.headers,
        body: JSON.parse(await req.text()),
      });
      return respond(n++);
    },
  });
  cleanups.push(() => server.stop(true));
  const spans = () =>
    received.flatMap((r) =>
      (r.body.resourceSpans as { scopeSpans: { spans: OtlpSpan[] }[] }[]).flatMap((rs) =>
        rs.scopeSpans.flatMap((ss) => ss.spans),
      ),
    );
  return { url: `http://127.0.0.1:${server.port}/v1/traces`, received, spans };
}

/** An attribute's value, decoded from its `AnyValue`. */
function attr(s: OtlpSpan, key: string): unknown {
  const v = s.attributes.find((a) => a.key === key)?.value;
  if (!v) return undefined;
  if ("intValue" in v) return Number(v.intValue);
  return v.stringValue ?? v.boolValue ?? v.doubleValue;
}

/**
 * Every field as the OTLP specification's JSON mapping writes it (opentelemetry-proto
 * `ExportTraceServiceRequest`): lowerCamelCase names, hex ids, integer enums, int64 as decimal strings, and
 * each attribute value one of the `AnyValue` kinds with its own JSON type. No field outside the proto.
 */
function checkShape(body: Record<string, unknown>) {
  expect(Object.keys(body)).toEqual(["resourceSpans"]);
  for (const rs of body.resourceSpans as Record<string, unknown>[]) {
    for (const k of Object.keys(rs)) expect(["resource", "scopeSpans", "schemaUrl"]).toContain(k);
    const resource = rs.resource as { attributes: OtlpSpan["attributes"] };
    checkAttributes(resource.attributes);
    for (const ss of rs.scopeSpans as Record<string, unknown>[]) {
      for (const k of Object.keys(ss)) expect(["scope", "spans", "schemaUrl"]).toContain(k);
      expect((ss.scope as { name: string }).name).toBe("bunvex");
      for (const s of ss.spans as OtlpSpan[]) {
        for (const k of Object.keys(s))
          expect([
            "traceId",
            "spanId",
            "parentSpanId",
            "traceState",
            "name",
            "kind",
            "startTimeUnixNano",
            "endTimeUnixNano",
            "attributes",
            "status",
          ]).toContain(k);
        expect(s.traceId).toMatch(/^[0-9a-f]{32}$/);
        expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
        if (s.parentSpanId !== undefined) expect(s.parentSpanId).toMatch(/^[0-9a-f]{16}$/);
        expect(typeof s.name).toBe("string");
        expect([1, 2, 3, 4, 5]).toContain(s.kind);
        expect(s.startTimeUnixNano).toMatch(/^\d{19}$/);
        expect(s.endTimeUnixNano).toMatch(/^\d{19}$/);
        expect(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano)).toBe(true);
        checkAttributes(s.attributes);
        if (s.status) {
          expect([0, 1, 2]).toContain(s.status.code);
          for (const k of Object.keys(s.status)) expect(["code", "message"]).toContain(k);
        }
      }
    }
  }
}

function checkAttributes(attrs: OtlpSpan["attributes"]) {
  for (const a of attrs) {
    expect(Object.keys(a)).toEqual(["key", "value"]);
    expect(typeof a.key).toBe("string");
    const [[kind, value]] = Object.entries(a.value) as [[string, unknown]];
    expect(Object.keys(a.value).length).toBe(1);
    if (kind === "stringValue") expect(typeof value).toBe("string");
    else if (kind === "boolValue") expect(typeof value).toBe("boolean");
    else if (kind === "intValue") expect(value).toMatch(/^-?\d+$/);
    else if (kind === "doubleValue") expect(typeof value).toBe("number");
    else throw new Error(`unexpected AnyValue ${kind}`);
  }
}

/** The tree under `root`, as nested names (children sorted), for readable expectations. */
function tree(spans: OtlpSpan[], root: OtlpSpan): unknown {
  const kids = spans.filter((s) => s.parentSpanId === root.spanId && s.traceId === root.traceId);
  if (kids.length === 0) return root.name;
  return {
    [root.name]: kids.map((k) => tree(spans, k)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}

// ------------------------------------------------------------------------------------------- the app

const schema = defineSchema({
  messages: defineTable({ author: v.string(), body: v.string() }).index("by_author", ["author"]),
});

const SECRET = "4361726e697461732c206c69746572616c6c79206d65616e696e6720226c6974";
const NAME = "carnitas";
const ADMIN_KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });

async function setup(tracing: Partial<OtlpConfig> & { url: string }) {
  const engine = await new Engine(schema, await MemoryPersistence.open(null, { durable: false }), {
    instanceSecret: SECRET,
    instanceName: NAME,
  }).init();
  const functions = new Functions(engine).register("m", {
    send: mutation(async ({ db }, { author, body }: { author: string; body: string }) => {
      await db
        .query("messages")
        .withIndex("by_author", (q) => q.eq("author", author))
        .collect();
      return db.insert("messages", { author, body });
    }),
    list: query(({ db }, { author }: { author: string }) =>
      db
        .query("messages")
        .withIndex("by_author", (q) => q.eq("author", author))
        .collect(),
    ),
    later: mutation(async ({ scheduler }) => {
      await scheduler.runAfter(0, "m:job" as never, {});
    }),
    job: mutation(({ db }) => db.insert("messages", { author: "job", body: "ran" })),
  });
  const s = createServer({
    engine,
    functions,
    port: 0,
    sitePort: null,
    tracing: { scheduleDelayMs: 10, ...tracing },
  });
  cleanups.push(async () => {
    s.stop();
    await s.spanExporter?.close();
  });
  const call = (kind: string, path: string, args: Record<string, unknown>, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${s.server!.port}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ path, args }),
    }).then((r) => r.json() as Promise<{ status: string; value?: unknown }>);
  return { ...s, engine, call };
}

const settle = async (exporter: OtlpExporter | null) => {
  await Bun.sleep(20);
  await exporter!.flush();
};

// ------------------------------------------------------------------------------------------- tests

describe("a request is one trace", () => {
  test("a mutation over HTTP: request → function → index read and commit (wait, validate, write)", async () => {
    const c = collector();
    const s = await setup({
      url: c.url,
      headers: { authorization: "Bearer collector-token" },
      resource: { "service.name": "my-app", "deployment.environment": "test" },
    });
    expect((await s.call("mutation", "m:send", { author: "ana", body: "hi" })).status).toBe("success");
    await settle(s.spanExporter);
    for (const r of c.received) {
      expect(r.method).toBe("POST");
      expect(r.path).toBe("/v1/traces");
      expect(r.headers.get("content-type")).toBe("application/json");
      expect(r.headers.get("authorization")).toBe("Bearer collector-token");
      checkShape(r.body);
    }
    const resource = (c.received[0]!.body.resourceSpans as { resource: { attributes: OtlpSpan["attributes"] } }[])[0]!
      .resource.attributes;
    expect(Object.fromEntries(resource.map((a) => [a.key, a.value.stringValue]))).toEqual({
      "service.name": "my-app",
      "deployment.environment": "test",
      "bunvex.instance_name": s.engine.instanceName,
    });
    const spans = c.spans();
    const root = spans.find((x) => x.name === "POST /api/mutation")!;
    expect(root.parentSpanId).toBeUndefined();
    expect(root.kind).toBe(2); // SERVER
    expect(attr(root, "http.response.status_code")).toBe(200);
    expect(attr(root, "http.route")).toBe("/api/mutation");
    expect(tree(spans, root)).toEqual({
      "POST /api/mutation": [
        {
          "mutation m:send": [
            // The run-state check every function makes (STUDY-63), then the app's read.
            "index _backend_state.by_creation_time",
            "index messages.by_author",
            { commit: ["commit.validate", "commit.wait", "commit.write"] },
          ],
        },
      ],
    });
    // Every span of the request is in its trace, and none of another trace is there.
    expect(new Set(spans.map((x) => x.traceId))).toEqual(new Set([root.traceId]));
    const fn = spans.find((x) => x.name === "mutation m:send")!;
    expect(attr(fn, "bunvex.function.path")).toBe("m:send");
    expect(attr(fn, "bunvex.function.kind")).toBe("mutation");
    expect(attr(fn, "bunvex.function.cached")).toBe(false);
    expect(attr(fn, "bunvex.function.documents_read")).toBe(0);
    const commit = spans.find((x) => x.name === "commit")!;
    expect(attr(commit, "bunvex.commit.documents")).toBe(1);
    // An int64 attribute, exact: the commit ts in nanoseconds.
    expect(commit.attributes.find((a) => a.key === "bunvex.commit.ts")?.value).toEqual({
      intValue: String(s.engine.committer.visibleTs),
    });
  });

  test("a query: documents and bytes read; a cache hit is marked and reads nothing", async () => {
    const c = collector();
    const s = await setup({ url: c.url });
    await s.call("mutation", "m:send", { author: "ana", body: "one" });
    await s.call("mutation", "m:send", { author: "ana", body: "two" });
    await s.call("query", "m:list", { author: "ana" });
    await s.call("query", "m:list", { author: "ana" });
    await settle(s.spanExporter);
    const runs = c.spans().filter((x) => x.name === "query m:list");
    expect(runs.map((r) => attr(r, "bunvex.function.cached"))).toEqual([false, true]);
    expect(attr(runs[0]!, "bunvex.function.documents_read")).toBe(2);
    expect(attr(runs[0]!, "bunvex.function.bytes_read")).toBeGreaterThan(0);
    const ix = c.spans().filter((x) => x.name === "index messages.by_author" && x.parentSpanId === runs[0]!.spanId);
    expect(ix.map((x) => [attr(x, "bunvex.index.intervals"), attr(x, "bunvex.index.rows")])).toEqual([[1, 2]]);
    // The hit ran nothing: no index span under it.
    expect(c.spans().some((x) => x.parentSpanId === runs[1]!.spanId)).toBe(false);
  });

  test("a traceparent continues the caller's trace; an unsampled one records nothing; a bad one is ignored", async () => {
    const c = collector();
    const s = await setup({ url: c.url });
    const traceId = newTraceId();
    const parent = newSpanId();
    await s.call("query", "m:list", { author: "x" }, { traceparent: `00-${traceId}-${parent}-01`, tracestate: "v=1" });
    const dropped = newTraceId();
    await s.call("query", "m:list", { author: "y" }, { traceparent: `00-${dropped}-${newSpanId()}-00` });
    await s.call("query", "m:list", { author: "z" }, { traceparent: `00-${"0".repeat(32)}-${parent}-01` });
    await settle(s.spanExporter);
    const roots = c.spans().filter((x) => x.name === "POST /api/query");
    expect(roots.length).toBe(2);
    const continued = roots.find((r) => r.traceId === traceId)!;
    expect(continued.parentSpanId).toBe(parent);
    expect(continued.traceState).toBe("v=1");
    expect(c.spans().filter((x) => x.traceId === traceId).length).toBeGreaterThan(1);
    // parentbased: the caller did not sample it, so nothing of it is recorded.
    expect(c.spans().some((x) => x.traceId === dropped)).toBe(false);
    // An invalid header: a new trace, as a root.
    const fresh = roots.find((r) => r.traceId !== traceId)!;
    expect(fresh.parentSpanId).toBeUndefined();
  });
});

describe("sync", () => {
  test("a subscription's re-run after a commit: a transition with the query it re-ran, under it", async () => {
    const c = collector();
    const s = await setup({ url: c.url });
    const ws = await v1Client(syncUrl(s.server!.port));
    cleanups.push(() => ws.ws.close());
    ws.modify([add(0, "m:list", { author: "ana" })]);
    await ws.transition(0);
    ws.mutate(1, "m:send", { author: "ana", body: "hi" });
    await ws.transition(1);
    await settle(s.spanExporter);
    const spans = c.spans();
    // The query set's message: its transition (the first run) under it.
    const modify = spans.find((x) => x.name === "sync-worker/modify-query-set")!;
    expect(modify.parentSpanId).toBeUndefined();
    expect(tree(spans, modify)).toEqual({
      "sync-worker/modify-query-set": [
        {
          "sync-worker/update-queries": [
            { "query m:list": ["index _backend_state.by_creation_time", "index messages.by_author"] },
          ],
        },
      ],
    });
    // The mutation over the socket: its own trace, down to the commit.
    const mutationMsg = spans.find((x) => x.name === "sync-worker/mutation")!;
    const fn = spans.find((x) => x.name === "mutation m:send")!;
    expect(fn.parentSpanId).toBe(mutationMsg.spanId);
    expect(tree(spans, mutationMsg)).toMatchObject({
      "sync-worker/mutation": expect.arrayContaining([
        {
          "mutation m:send": [
            // The session's request record (idempotent resends, STUDY-23 P6), then the app's read.
            "index _session_requests.by_session_id_and_request_id",
            "index messages.by_author",
            { commit: ["commit.validate", "commit.wait", "commit.write"] },
          ],
        },
      ]),
    });
    expect(attr(mutationMsg, "bunvex.function.path")).toBe("m:send");
    // The re-run the commit caused. The commit's invalidation starts it (a trace of its own: a commit can
    // invalidate many sessions' queries), unless the mutation's response came first and its transition,
    // under the mutation's message, re-ran the query. Either way exactly one transition re-ran it.
    const transitions = spans.filter((x) => x.name === "sync-worker/update-queries");
    const rerun = transitions.filter((x) => x !== transitions.find((t) => t.parentSpanId === modify.spanId));
    expect(rerun.every((t) => t.parentSpanId === undefined || t.parentSpanId === mutationMsg.spanId)).toBe(true);
    const ran = rerun.filter((t) => attr(t, "bunvex.sync.queries_rerun") === 1);
    expect(ran.length).toBe(1);
    // (The run-state check's read is answered from its cache by now: no `_backend_state` span.)
    expect(tree(spans, ran[0]!)).toEqual({
      "sync-worker/update-queries": [{ "query m:list": ["index messages.by_author"] }],
    });
    expect(attr(ran[0]!, "bunvex.sync.queries")).toBe(1);
    expect(attr(ran[0]!, "bunvex.sync.modifications")).toBe(1);
    expect(attr(ran[0]!, "bunvex.sync.bytes")).toBeGreaterThan(50);
    const q = spans.find((x) => x.name === "query m:list" && x.parentSpanId === ran[0]!.spanId)!;
    expect(attr(q, "bunvex.function.documents_read")).toBe(1);
    // The committer's listeners run in no request's context: no transition joined the mutation's trace
    // other than the one its response asked for.
    expect(
      spans.filter((x) => x.traceId === mutationMsg.traceId && x.name === "sync-worker/update-queries").length,
    ).toBeLessThanOrEqual(1);
  });
});

describe("scheduler and crons", () => {
  test("a scheduled run is a trace of its own, with the function under it", async () => {
    const c = collector();
    const s = await setup({ url: c.url });
    await s.call("mutation", "m:later", {});
    for (let i = 0; i < 200 && !c.spans().some((x) => x.name === "scheduler/run"); i++) await settle(s.spanExporter);
    const run = c.spans().find((x) => x.name === "scheduler/run")!;
    expect(run.parentSpanId).toBeUndefined();
    expect(attr(run, "bunvex.function.path")).toBe("m.js:job");
    expect(c.spans().some((x) => x.parentSpanId === run.spanId && x.name === "mutation m:job")).toBe(true);
  });

  test("a cron run is a trace of its own", async () => {
    const c = collector();
    const engine = await new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
    const functions = new Functions(engine).register("m", {
      tick: mutation(({ db }) => db.insert("messages", { author: "cron", body: "tick" })),
    });
    const crons = cronJobs();
    crons.interval("ticker", { seconds: 1 }, "m:tick" as never);
    const splay = process.env.CRON_SPLAY_SECONDS;
    process.env.CRON_SPLAY_SECONDS = "0";
    cleanups.push(() => {
      if (splay === undefined) delete process.env.CRON_SPLAY_SECONDS;
      else process.env.CRON_SPLAY_SECONDS = splay;
    });
    const s = createServer({
      engine,
      functions,
      crons,
      port: 0,
      sitePort: null,
      tracing: { url: c.url, scheduleDelayMs: 10 },
    });
    cleanups.push(async () => {
      s.stop();
      await s.spanExporter?.close();
    });
    for (let i = 0; i < 300 && !c.spans().some((x) => x.name === "cron/run"); i++) await settle(s.spanExporter);
    const run = c.spans().find((x) => x.name === "cron/run")!;
    expect(run.parentSpanId).toBeUndefined();
    expect(attr(run, "bunvex.cron.name")).toBe("ticker");
    expect(c.spans().some((x) => x.parentSpanId === run.spanId && x.name === "mutation m:tick")).toBe(true);
  });
});

describe("sampling", () => {
  test("always_off records nothing; traceidratio keeps about its share of traces, whole", async () => {
    const off = collector();
    const s1 = await setup({ url: off.url, sampler: { root: "always_off", parentBased: true, ratio: 1 } });
    for (let i = 0; i < 5; i++) await s1.call("query", "m:list", { author: "a" });
    await settle(s1.spanExporter);
    expect(off.spans()).toEqual([]);

    const some = collector();
    const s2 = await setup({ url: some.url, sampler: { root: "traceidratio", parentBased: true, ratio: 0.3 } });
    const n = 300;
    for (let i = 0; i < n; i++) await s2.call("query", "m:list", { author: `${i}` });
    await settle(s2.spanExporter);
    const roots = some.spans().filter((x) => x.name === "POST /api/query");
    expect(roots.length).toBeGreaterThan(n * 0.15);
    expect(roots.length).toBeLessThan(n * 0.45);
    // A sampled trace is whole: each kept request has its function span.
    const fns = some.spans().filter((x) => x.name === "query m:list");
    expect(new Set(fns.map((f) => f.traceId))).toEqual(new Set(roots.map((r) => r.traceId)));
  });
});

describe("the exporter", () => {
  const spanOf = (tracer: Tracer, name = "s") => {
    const s = tracer.root(name)!;
    s.end = s.start + 1;
    return s;
  };
  const config = (url: string, o: Partial<OtlpConfig> = {}): OtlpConfig => ({
    ...OTLP_DEFAULTS,
    url,
    headers: {},
    sampler: { root: "always_on", parentBased: true, ratio: 1 },
    resource: { "service.name": "bunvex" },
    ...o,
  });

  test("a full queue drops, and counts what it dropped; /stats shows it", async () => {
    const c = collector();
    const e = new OtlpExporter(config(c.url, { maxQueueSize: 5, maxBatchSize: 100, scheduleDelayMs: 60_000 }));
    const t = new Tracer(e);
    for (let i = 0; i < 20; i++) e.add(spanOf(t));
    expect(e.stats).toEqual({ exported: 0, dropped: 15, failed: 0, queued: 5 });
    await e.flush();
    expect(e.stats).toEqual({ exported: 5, dropped: 15, failed: 0, queued: 0 });
    expect(c.spans().length).toBe(5);

    // Through the server: the exporter's counts in `/stats` (admin, ViewMetrics).
    const s = await setup({ url: c.url, maxQueueSize: 2, maxBatchSize: 100, scheduleDelayMs: 60_000 });
    await s.call("mutation", "m:send", { author: "a", body: "b" });
    const stats = (await fetch(`http://127.0.0.1:${s.server!.port}/stats`, {
      headers: { authorization: `Bunvex ${ADMIN_KEY}` },
    }).then((r) => r.json())) as { tracing: { dropped: number; queued: number } };
    expect(stats.tracing.queued).toBe(2);
    expect(stats.tracing.dropped).toBeGreaterThan(0);
  });

  test("a batch goes when it is full, or after the delay", async () => {
    const c = collector();
    const e = new OtlpExporter(config(c.url, { maxBatchSize: 3, scheduleDelayMs: 50 }));
    const t = new Tracer(e);
    for (let i = 0; i < 3; i++) e.add(spanOf(t));
    for (let i = 0; i < 100 && c.received.length < 1; i++) await Bun.sleep(2);
    expect(c.received.length).toBe(1);
    e.add(spanOf(t));
    await Bun.sleep(10);
    expect(c.received.length).toBe(1); // not full, not due yet
    for (let i = 0; i < 100 && c.received.length < 2; i++) await Bun.sleep(5);
    expect(c.spans().length).toBe(4);
    await e.close();
  });

  test("retryable answers are retried with backoff; others fail at once", async () => {
    const c = collector((n) => (n < 2 ? new Response("busy", { status: 503 }) : Response.json({})));
    const e = new OtlpExporter(config(c.url, { initialBackoffMs: 5, maxBackoffMs: 10 }));
    const t = new Tracer(e);
    e.add(spanOf(t));
    await e.flush();
    expect(c.received.length).toBe(3);
    expect(e.stats).toMatchObject({ exported: 1, failed: 0 });

    const bad = collector(() => new Response("no", { status: 400 }));
    const e2 = new OtlpExporter(config(bad.url, { initialBackoffMs: 5 }));
    e2.add(spanOf(new Tracer(e2)));
    await e2.flush();
    expect(bad.received.length).toBe(1);
    expect(e2.stats).toMatchObject({ exported: 0, failed: 1 });

    // Retries spent: failed, and the exporter goes on.
    const down = collector(() => new Response("down", { status: 502 }));
    const e3 = new OtlpExporter(config(down.url, { initialBackoffMs: 1, maxBackoffMs: 2, maxRetries: 2 }));
    e3.add(spanOf(new Tracer(e3)));
    await e3.flush();
    expect(down.received.length).toBe(3);
    expect(e3.stats).toMatchObject({ exported: 0, failed: 1 });

    // A partial success counts what the collector rejected.
    const partial = collector(() => Response.json({ partialSuccess: { rejectedSpans: "1", errorMessage: "x" } }));
    const e4 = new OtlpExporter(config(partial.url));
    const t4 = new Tracer(e4);
    e4.add(spanOf(t4));
    e4.add(spanOf(t4));
    await e4.flush();
    expect(e4.stats).toMatchObject({ exported: 1, failed: 1 });
  });

  test("a close sends what is queued, cuts a backoff short, and takes nothing after", async () => {
    const c = collector();
    const e = new OtlpExporter(config(c.url, { scheduleDelayMs: 3_600_000 }));
    const t = new Tracer(e);
    for (let i = 0; i < 7; i++) e.add(spanOf(t));
    expect(c.received.length).toBe(0);
    await e.close();
    expect(c.spans().length).toBe(7);
    e.add(spanOf(t));
    expect(e.stats).toMatchObject({ exported: 7, dropped: 1, queued: 0 });

    // A collector that keeps failing does not hold the close for its backoff.
    const down = collector(() => new Response("down", { status: 503 }));
    const e2 = new OtlpExporter(config(down.url, { initialBackoffMs: 60_000, maxBackoffMs: 60_000 }));
    e2.add(spanOf(new Tracer(e2)));
    const started = performance.now();
    const flushing = e2.flush(); // the export starts, fails, and backs off for up to a minute
    for (let i = 0; i < 200 && down.received.length < 1; i++) await Bun.sleep(5);
    await Bun.sleep(10);
    await e2.close();
    await flushing;
    expect(performance.now() - started).toBeLessThan(3000);
    // One last attempt when the close cut the backoff short, then failed.
    expect(down.received.length).toBe(2);
    expect(e2.stats).toMatchObject({ failed: 1 });
  });

  test("the server flushes its spans when it shuts down", async () => {
    const c = collector();
    const s = await setup({ url: c.url, scheduleDelayMs: 3_600_000 });
    await s.call("mutation", "m:send", { author: "a", body: "b" });
    expect(c.received.length).toBe(0);
    cleanups.length = 0; // shut down here instead
    await s.shutdown();
    expect(c.spans().some((x) => x.name === "POST /api/mutation")).toBe(true);
    expect(c.spans().some((x) => x.name === "commit")).toBe(true);
  });

  test("the JSON of the exotic values: a non-finite double, a negative int, an error status", () => {
    const sink = { add() {} };
    const s = new Span(new Tracer(sink), "x", "a".repeat(32), "b".repeat(16), null);
    s.set("nan", Number.NaN)
      .set("inf", Number.POSITIVE_INFINITY)
      .set("neg", -3)
      .set("half", 0.5)
      .fail(new Error('a "quote"'));
    s.end = s.start;
    const body = JSON.parse(encodeTraces({ "service.name": "bunvex" }, [s]));
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.attributes).toEqual([
      { key: "nan", value: { doubleValue: "NaN" } },
      { key: "inf", value: { doubleValue: "Infinity" } },
      { key: "neg", value: { intValue: "-3" } },
      { key: "half", value: { doubleValue: 0.5 } },
    ]);
    expect(span.status).toEqual({ code: 2, message: 'a "quote"' });
    expect(span.parentSpanId).toBeUndefined();
  });
});

describe("configuration from the environment", () => {
  const quiet: string[] = [];
  const warn = (m: string) => void quiet.push(m);

  test("off unless an endpoint is set; OTEL_SDK_DISABLED and OTEL_TRACES_EXPORTER=none turn it off", () => {
    expect(tracingFromEnv({}, warn)).toBeNull();
    const on = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" };
    expect(tracingFromEnv(on, warn)).not.toBeNull();
    expect(tracingFromEnv({ ...on, OTEL_SDK_DISABLED: "true" }, warn)).toBeNull();
    expect(tracingFromEnv({ ...on, OTEL_TRACES_EXPORTER: "none" }, warn)).toBeNull();
    expect(tracingFromEnv({ ...on, OTEL_TRACES_EXPORTER: "otlp" }, warn)).not.toBeNull();
    expect(tracingFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "not a url" }, warn)).toBeNull();
  });

  test("the endpoint: the base gets /v1/traces; the traces endpoint is used as is", () => {
    expect(tracingFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" }, warn)!.url).toBe("http://c:4318/v1/traces");
    expect(tracingFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318/otlp/" }, warn)!.url).toBe(
      "http://c:4318/otlp/v1/traces",
    );
    expect(
      tracingFromEnv(
        { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://t:9999/custom" },
        warn,
      )!.url,
    ).toBe("http://t:9999/custom");
  });

  test("headers, timeout, sampler, service name, resource attributes, batch knobs", () => {
    const c = tracingFromEnv(
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318",
        OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=abc%20def, x-team = core ,broken",
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-team=traces",
        OTEL_EXPORTER_OTLP_TIMEOUT: "2500",
        OTEL_TRACES_SAMPLER: "parentbased_traceidratio",
        OTEL_TRACES_SAMPLER_ARG: "0.1",
        OTEL_RESOURCE_ATTRIBUTES: "service.name=ignored,deployment.environment=prod,team=a%2Cb",
        OTEL_SERVICE_NAME: "shop",
        OTEL_BSP_MAX_QUEUE_SIZE: "100",
        OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "500",
        OTEL_BSP_SCHEDULE_DELAY: "200",
      },
      warn,
    )!;
    expect(c.headers).toEqual({ "x-api-key": "abc def", "x-team": "traces" });
    expect(c.timeoutMs).toBe(2500);
    expect(c.sampler).toEqual({ root: "traceidratio", parentBased: true, ratio: 0.1 });
    expect(c.resource).toEqual({ "service.name": "shop", "deployment.environment": "prod", team: "a,b" });
    expect(c.maxQueueSize).toBe(100);
    expect(c.maxBatchSize).toBe(100); // never above the queue
    expect(c.scheduleDelayMs).toBe(200);
    expect(quiet.some((m) => m.includes('"broken"'))).toBe(true);
    // Defaults: the service is "bunvex", the sampler parentbased_always_on.
    const d = tracingFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" }, warn)!;
    expect(d.resource).toEqual({ "service.name": "bunvex" });
    expect(d.sampler).toEqual({ root: "always_on", parentBased: true, ratio: 1 });
    expect(d.timeoutMs).toBe(10_000);
  });

  test("another protocol is reported; JSON is sent all the same", () => {
    const warnings: string[] = [];
    const c = tracingFromEnv(
      { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf" },
      (m) => void warnings.push(m),
    );
    expect(c).not.toBeNull();
    expect(warnings).toEqual(['bunvex tracing: OTLP protocol "http/protobuf" is not supported; sending http/json']);
  });

  test("off, the server installs no tracer and `/stats` says so", async () => {
    const saved = { ...process.env };
    for (const k of Object.keys(process.env)) if (k.startsWith("OTEL_")) delete process.env[k];
    cleanups.push(() => Object.assign(process.env, saved));
    const engine = await new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
    const s = createServer({ engine, functions: new Functions(engine), port: 0, sitePort: null });
    cleanups.push(() => s.stop());
    expect(engine.tracer).toBe(NO_TRACER);
    expect(s.spanExporter).toBeNull();
  });
});

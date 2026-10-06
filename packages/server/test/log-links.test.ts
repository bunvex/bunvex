// "Why did this run" links from the function log (STUDY-131 AD-27, a bunvex addition). A sync query's
// Completion names its entry in the subscriptions inspector (AD-25: its arguments' digest, why it ran, and the
// invalidation it answers by feed number and commit ts), and a traced run its span (AD-26). Only the dashboard
// gets them: the CLI and an unnamed client read Convex's entries unchanged.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { SyncInspector } from "../src/sync-inspector.ts";
import { add, syncUrl, v1Client } from "./v1-client.ts";

const SECRET = "5d".repeat(32);
const NAME = "log-links-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

type Span = { traceId: string; spanId: string; name: string };

/** An OTLP/HTTP receiver in process that keeps the spans it gets. */
function collector() {
  const spans: Span[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { resourceSpans: { scopeSpans: { spans: Span[] }[] }[] };
      for (const rs of body.resourceSpans) for (const ss of rs.scopeSpans) spans.push(...ss.spans);
      return Response.json({});
    },
  });
  stops.push(() => server.stop());
  return { url: `http://127.0.0.1:${server.port}/v1/traces`, spans };
}

async function setup(opts: { tracing?: boolean; invalidationHistory?: number } = {}) {
  const engine = await new Engine(
    defineSchema({
      messages: defineTable({ author: v.string(), body: v.string() }).index("by_author", ["author"]),
    }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: NAME, instanceSecret: SECRET },
  ).init();
  const functions = new Functions(engine).register("m", {
    byAuthor: query(({ db }, { author }: { author: string }) =>
      db
        .query("messages")
        .withIndex("by_author", (q) => q.eq("author", author))
        .collect(),
    ),
    send: mutation(({ db }, { author, body }: { author: string; body: string }) =>
      db.insert("messages", { author, body }),
    ),
  });
  const otlp = opts.tracing ? collector() : null;
  const s = createServer({
    engine,
    functions,
    port: 0,
    tracing: otlp ? { url: otlp.url, scheduleDelayMs: 10 } : null,
    ...(opts.invalidationHistory === undefined ? {} : { invalidationHistory: opts.invalidationHistory }),
  });
  stops.push(async () => {
    s.stop();
    await s.spanExporter?.close();
  });
  const api = `http://127.0.0.1:${s.server.port}`;
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const r = await fetch(`${api}${path}`, { headers: { authorization: `Bunvex ${KEY}`, ...headers } });
    expect(r.status).toBe(200);
    return (await r.json()) as any;
  };
  /** The log's Completions, as `client` (a `bunvex-client` header, or none) reads them. */
  const completions = async (client: string | null = "dashboard-1.0.0") =>
    (
      await get("/api/stream_function_logs?cursor=0", client === null ? {} : { "bunvex-client": client })
    ).entries.filter((e: any) => e.kind === "Completion");
  const client = async () => {
    const c = await v1Client(syncUrl(s.server.port));
    stops.push(() => c.ws.close());
    return c;
  };
  /** Over HTTP, so a traced deployment traces it from its request. */
  const send = async (author: string, body: string) => {
    const r = await fetch(`${api}/api/mutation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "m:send", args: { author, body }, format: "json" }),
    });
    expect(r.status).toBe(200);
  };
  return { engine, api, get, completions, client, send, otlp };
}

/** A subscriber to `m:byAuthor` for ana, then a write into its range: the query runs twice. */
async function rerunAfterWrite(t: Awaited<ReturnType<typeof setup>>) {
  const c = await t.client();
  c.modify([add(1, "m:byAuthor", { author: "ana" })]);
  await c.transition(0);
  await t.send("ana", "hi");
  await c.transition(1);
  // As the JSON gives it (the inspector's and the log's): a number.
  return Number(t.engine.committer.visibleTs);
}

const runsOf = (entries: any[], path: string) => entries.filter((e) => e.identifier === path);

test("a re-run query's log entry names the invalidation that caused it, and its trace", async () => {
  const t = await setup({ tracing: true });
  const commitTs = await rerunAfterWrite(t);
  const [first, rerun] = runsOf(await t.completions(), "m:byAuthor");

  // its entry in the inspector: the same digest, the invalidation by its feed number and commit ts
  const live = (await t.get("/api/debug/subscriptions")).sessions.flatMap((s: any) => s.queries)[0];
  const [inv] = live.history.filter((h: any) => h.kind === "invalidation");
  expect(inv.commitTs).toBe(commitTs);
  expect(rerun.links.subscription).toEqual({
    argsDigest: live.argsDigest,
    reason: "invalidation",
    invalidation: { seq: inv.seq, commitTs },
  });
  // the follow feed knows the same number
  const feed = (await t.get("/api/debug/invalidations?cursor=0&timeoutMs=0")).entries;
  expect(feed.map((e: any) => e.seq)).toEqual([inv.seq]);

  // the first run: a new subscriber, no invalidation behind it
  expect(first.links.subscription).toEqual({
    argsDigest: live.argsDigest,
    reason: "newSubscriber",
    invalidation: null,
  });

  // its trace: the span exported for that run
  expect(rerun.links.trace.traceId).toMatch(/^[0-9a-f]{32}$/);
  expect(rerun.links.trace.spanId).toMatch(/^[0-9a-f]{16}$/);
  expect(rerun.links.trace).not.toEqual(first.links.trace);
  for (let i = 0; i < 200 && !t.otlp!.spans.some((s) => s.spanId === rerun.links.trace.spanId); i++)
    await Bun.sleep(10);
  const span = t.otlp!.spans.find((s) => s.spanId === rerun.links.trace.spanId);
  expect(span).toMatchObject({ name: "query m:byAuthor", traceId: rerun.links.trace.traceId });

  // the mutation that wrote is traced too, with no subscription link
  const [send] = runsOf(await t.completions(), "m:send");
  expect(send.links.subscription).toBeUndefined();
  expect(send.links.trace.traceId).toMatch(/^[0-9a-f]{32}$/);
});

test("the CLI and an unnamed client get Convex's entries, with no links", async () => {
  const t = await setup({ tracing: true });
  await rerunAfterWrite(t);
  for (const who of ["npm-cli-1.0.0", null]) {
    const entries = await t.completions(who);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    for (const e of entries) expect(Object.keys(e)).not.toContain("links");
  }
  // `stream_udf_execution` neither, even for the dashboard
  const udf = await t.get("/api/stream_udf_execution?cursor=0", { "bunvex-client": "dashboard-1.0.0" });
  for (const e of udf.entries) expect(Object.keys(e)).not.toContain("links");
});

test("without tracing: the subscription link alone; an HTTP query has none", async () => {
  const t = await setup();
  await rerunAfterWrite(t);
  const r = await fetch(`${t.api}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "m:byAuthor", args: { author: "bob" }, format: "json" }),
  });
  expect(r.status).toBe(200);
  const runs = runsOf(await t.completions(), "m:byAuthor");
  expect(runs).toHaveLength(3);
  expect(runs[1].links).toEqual({ subscription: expect.objectContaining({ reason: "invalidation" }) });
  expect(runs[2].caller).toBe("HttpApi");
  expect(runs[2].links).toBeUndefined();
});

test("with the inspector's ring off, a re-run still says why, with no invalidation to link", async () => {
  const t = await setup({ invalidationHistory: 0 });
  await rerunAfterWrite(t);
  const [, rerun] = runsOf(await t.completions(), "m:byAuthor");
  expect(rerun.links.subscription).toMatchObject({ reason: "invalidation", invalidation: null });
});

test("the invalidation a run answers: the newest not yet sent", () => {
  const ins = new SyncInspector(8);
  const write = { index: "1", key: new Uint8Array([1]) };
  expect(ins.pending("k")).toBeNull();
  ins.invalidated("k", 10n, "m:a", write);
  ins.invalidated("k", 11n, "m:b", write);
  ins.invalidated("other", 12n, "m:c", write);
  // two commits before the run: it reads at the newer one
  expect(ins.pending("k")).toMatchObject({ seq: 2, commitTs: 11n, source: "m:b" });
  ins.sent("k");
  expect(ins.pending("k")).toBeNull();
  ins.rerun("k", "codeChange");
  expect(ins.pending("k")).toBeNull();
  ins.invalidated("k", 13n, "m:d", write);
  expect(ins.pending("k")).toMatchObject({ seq: 4, commitTs: 13n });
  // its feed number is the follow stream's
  expect(ins.history("k")[0]).toMatchObject({ kind: "invalidation", seq: 4 });
});

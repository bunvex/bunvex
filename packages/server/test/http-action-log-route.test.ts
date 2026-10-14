// What an HTTP action is logged as (STUDY-31 §7), as Convex's `HttpActionRoute`: its lines (Progress, console
// events) by the request (`GET /files/abc`, HEAD as GET); its Completion, function_execution event and app
// metrics by the route the router matched (`GET /files/*`), once it ran to the end. A run that failed, lost its
// client or matched no route (logged, answered 404) keeps the request's name and is not measured.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import type { Part } from "../src/function-log.ts";
import { Functions } from "../src/functions.ts";
import { eventJsonV2, type LogEvent } from "../src/log-events.ts";
import { httpAction, httpRouter } from "../src/router.ts";
import { createServer } from "../src/server.ts";

const SECRET = "5c".repeat(32);
const NAME = "route-log-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), memberId: 1 });

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function setup() {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false }), {
    instanceName: NAME,
    instanceSecret: SECRET,
  }).init();
  const http = httpRouter();
  const answer = (word: string) =>
    httpAction(async (_ctx, req) => {
      console.log(word, new URL(req.url).pathname);
      return new Response(word);
    });
  http.route({ path: "/hello", method: "GET", handler: answer("hello") });
  http.route({ pathPrefix: "/files/", method: "GET", handler: answer("get") });
  http.route({ pathPrefix: "/files/", method: "POST", handler: answer("post") });
  http.route({ pathPrefix: "/files/deep/", method: "GET", handler: answer("deep") });
  http.route({
    pathPrefix: "/fail/",
    method: "GET",
    handler: httpAction(async () => {
      console.log("about to fail");
      throw new Error("boom");
    }),
  });
  http.route({
    pathPrefix: "/endless/",
    method: "GET",
    handler: httpAction(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(c) {
              await Bun.sleep(20);
              c.enqueue(new Uint8Array(1));
            },
          }),
        ),
    ),
  });
  const functions = new Functions(engine);
  const s = createServer({ engine, functions, port: 0, http, redactLogsToClient: false });
  stops.push(() => s.stop());
  const events: Record<string, any>[] = [];
  functions.logManager = {
    active: true,
    send: (e: LogEvent[]) => {
      for (const x of e) events.push(eventJsonV2(x));
    },
  } as never;
  const api = `http://127.0.0.1:${s.server!.port}`;
  const parts = async (): Promise<Part[]> => {
    const r = await fetch(`${api}/api/stream_function_logs?cursor=0`, { headers: { authorization: `Bunvex ${KEY}` } });
    return ((await r.json()) as { entries: Part[] }).entries.filter((p) => p.udfType === "HttpAction");
  };
  /** The Completions logged so far, once there are `n`. */
  const completions = async (n: number) => {
    for (let i = 0; i < 400; i++) {
      const done = (await parts()).filter((p) => p.kind === "Completion");
      if (done.length >= n) return done as any[];
      await Bun.sleep(5);
    }
    throw new Error("timed out");
  };
  const now = Math.floor(Date.now() / 1000);
  const window = JSON.stringify({
    start: { secs_since_epoch: now - 600, nanos_since_epoch: 0 },
    end: { secs_since_epoch: now + 60, nanos_since_epoch: 0 },
    num_buckets: 1,
  });
  /** Calls of a route in the app metrics (one 660 s bucket). */
  const calls = async (udfPath: string, metric = "invocations") => {
    const q = new URLSearchParams({ window, udfPath, metric, udfType: "HttpAction" });
    const r = await fetch(`${api}/api/app_metrics/udf_rate?${q}`, { headers: { authorization: `Bunvex ${KEY}` } });
    const [[, rate]] = (await r.json()) as [unknown, number][];
    return Math.round(rate! * 660);
  };
  return { site: s.siteUrl!, parts, completions, events, calls };
}

test("a prefix route: lines by the request, the Completion and the metrics by the route", async () => {
  const t = await setup();
  for (const [method, path] of [
    ["GET", "/hello"],
    ["GET", "/files/abc"],
    ["HEAD", "/files/abc"],
    ["POST", "/files/x/y"],
    ["GET", "/files/deep/z?q=1"],
  ] as const)
    expect((await fetch(`${t.site}${path}`, { method })).status).toBe(200);
  const done = await t.completions(5);
  expect(done.map((c) => [c.identifier, c.success])).toEqual([
    ["GET /hello", { status: "200" }],
    ["GET /files/*", { status: "200" }],
    ["GET /files/*", { status: "200" }],
    ["POST /files/*", { status: "200" }],
    ["GET /files/deep/*", { status: "200" }],
  ]);
  const progress = (await t.parts()).filter((p) => p.kind === "Progress");
  expect(progress.map((p) => p.identifier)).toEqual([
    "GET /hello",
    "GET /files/abc",
    "GET /files/abc",
    "POST /files/x/y",
    "GET /files/deep/z",
  ]);
  // Log streams: the console lines by the request, the executions by the route.
  const paths = (topic: string) => t.events.filter((e) => e.topic === topic).map((e) => e.function.path);
  expect(paths("console")).toEqual(progress.map((p) => p.identifier));
  expect(paths("function_execution")).toEqual(done.map((c) => c.identifier));
  // The app metrics name a route by its path, whatever the method (Convex's `UdfIdentifier::Http`).
  expect(await t.calls("GET /files/*")).toBe(3);
  expect(await t.calls("GET /files/deep/*")).toBe(1);
  expect(await t.calls("GET /hello")).toBe(1);
  expect(await t.calls("GET /files/abc")).toBe(0);
});

test("no route: logged under the request, answered 404, not measured", async () => {
  const t = await setup();
  for (const [method, path] of [
    ["GET", "/nope"],
    ["HEAD", "/nope"],
    ["PUT", "/hello"],
    ["GET", "/files"],
    ["PATCH", "/files/q?x=1"],
  ] as const) {
    const r = await fetch(`${t.site}${path}`, { method });
    expect([r.status, await r.text()]).toEqual([404, method === "HEAD" ? "" : "No matching routes found"]);
  }
  const done = await t.completions(5);
  expect(done.map((c) => [c.identifier, c.success, c.error, c.caller, c.logLines])).toEqual(
    ["GET /nope", "GET /nope", "PUT /hello", "GET /files", "PATCH /files/q"].map((id) => [
      id,
      { status: "404" },
      null,
      "HttpEndpoint",
      [],
    ]),
  );
  expect(t.events.filter((e) => e.topic === "function_execution").map((e) => e.function.path)).toEqual(
    done.map((c) => c.identifier),
  );
  expect(await t.calls("GET /nope")).toBe(0);
  expect(await t.calls("GET /hello")).toBe(0);
});

test("a handler that throws: logged under the request with its error, not measured", async () => {
  const t = await setup();
  expect((await fetch(`${t.site}/fail/z`)).status).toBe(500);
  const [c] = await t.completions(1);
  expect(c.identifier).toBe("GET /fail/z");
  expect(c.error).toStartWith("Uncaught Error: boom");
  expect((await t.parts()).find((p) => p.kind === "Progress")?.identifier).toBe("GET /fail/z");
  expect(t.events.find((e) => e.topic === "function_execution")?.function.path).toBe("GET /fail/z");
  expect(await t.calls("GET /fail/*")).toBe(0);
  expect(await t.calls("GET /fail/*", "errors")).toBe(0);
});

test("a client that leaves mid-body: logged under the request, not measured", async () => {
  const t = await setup();
  const aborted = new AbortController();
  const r = await fetch(`${t.site}/endless/x`, { signal: aborted.signal });
  await r.body!.getReader().read();
  aborted.abort();
  const [c] = await t.completions(1);
  expect([c.identifier, c.success]).toEqual(["GET /endless/x", { status: "200" }]);
  expect(await t.calls("GET /endless/*")).toBe(0);
});

// A handler that returns something other than a Response (STUDY-31 §9): as Convex's router, a failure before the
// head — answered with the 500 (`Uncaught Error: HTTP actions must return a Response`), its Completion,
// `function_execution` and `exception` events logged with that error under the request, and not measured.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import type { Part } from "../src/function-log.ts";
import { Functions } from "../src/functions.ts";
import { eventJsonV2, type LogEvent } from "../src/log-events.ts";
import { httpAction, httpRouter } from "../src/router.ts";
import { createServer } from "../src/server.ts";

const SECRET = "5d".repeat(32);
const NAME = "result-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), memberId: 1 });
const MESSAGE = "Uncaught Error: HTTP actions must return a Response";

const results: Record<string, () => unknown> = {
  object: () => ({ status: 200 }),
  undefined: () => undefined,
  null: () => null,
  string: () => "text",
  like: () => ({ status: 200, headers: new Headers(), body: null, ok: true }),
  response: () => new Response("fine"),
};

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
  http.route({
    pathPrefix: "/result/",
    method: "GET",
    handler: httpAction(async (_ctx, req) => {
      const kind = new URL(req.url).pathname.slice("/result/".length);
      console.log("returning", kind);
      return results[kind]!() as Response;
    }),
  });
  const functions = new Functions(engine);
  const s = createServer({ engine, functions, port: 0, http, redactLogsToClient: false });
  stops.push(() => s.stop());
  const events: Record<string, any>[] = [];
  const raw: LogEvent[] = [];
  functions.logManager = {
    active: true,
    send: (e: LogEvent[]) => {
      raw.push(...e);
      for (const x of e) events.push(eventJsonV2(x));
    },
  } as never;
  const api = `http://127.0.0.1:${s.server!.port}`;
  const auth = { authorization: `Bunvex ${KEY}` };
  const completions = async (n: number) => {
    for (let i = 0; i < 400; i++) {
      const r = await fetch(`${api}/api/stream_function_logs?cursor=0`, { headers: auth });
      const parts = ((await r.json()) as { entries: Part[] }).entries.filter((p) => p.kind === "Completion");
      if (parts.length >= n) return parts as any[];
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
  const calls = async (metric: string) => {
    const q = new URLSearchParams({ window, udfPath: "GET /result/*", metric, udfType: "HttpAction" });
    const r = await fetch(`${api}/api/app_metrics/udf_rate?${q}`, { headers: auth });
    const [[, rate]] = (await r.json()) as [unknown, number][];
    return Math.round(rate! * 660);
  };
  return { site: s.siteUrl!, completions, events, raw, calls };
}

test("a non-Response: the 500, and the run logged with Convex's error under the request", async () => {
  const t = await setup();
  const kinds = Object.keys(results);
  for (const kind of kinds.slice(0, -1)) {
    const r = await fetch(`${t.site}/result/${kind}`);
    expect(r.status).toBe(500);
    const body = (await r.json()) as { code: string; trace: string };
    expect(body.code).toMatch(new RegExp(`^\\[Request ID: [0-9a-f]{16}\\] Server Error: ${MESSAGE}$`));
    expect(body.trace).toStartWith(MESSAGE);
  }
  expect(await (await fetch(`${t.site}/result/response`)).text()).toBe("fine");
  const done = await t.completions(kinds.length);
  expect(done.map((c) => [c.identifier, c.success ?? null, c.error?.split("\n")[0] ?? null])).toEqual([
    ...kinds.slice(0, -1).map((k) => [`GET /result/${k}`, null, MESSAGE]),
    ["GET /result/*", { status: "200" }, null],
  ]);
  const executions = t.events.filter((e) => e.topic === "function_execution");
  expect(executions[0]).toMatchObject({ function: { path: "GET /result/object" }, status: "failure" });
  expect(executions[0].error_message).toStartWith(MESSAGE);
  const exceptions = t.raw
    .filter((e) => e.event.topic === "exception")
    .map((e) => (e.event as { message: string }).message);
  expect(exceptions).toEqual(kinds.slice(0, -1).map(() => "HTTP actions must return a Response"));
  // Only the Response is measured, as a success.
  expect([await t.calls("invocations"), await t.calls("errors")]).toEqual([1, 0]);
});

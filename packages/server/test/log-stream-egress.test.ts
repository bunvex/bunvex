// Log stream egress (STUDY-187 X6), as Convex's `egress_emission_worker` (crates/log_streaming/src/lib.rs): every
// sink's request bodies are counted together, once per attempt that got an answer and never for the connection
// test or a batch of nothing but egress events; each tick turns the count into one `log_stream_egress` event
// (V2: `{timestamp, topic, egress_bytes}`) for every sink whose filter takes it, and into data egress in the
// usage meter, and starts again from zero. Ticks are driven by hand (`emitEgress`) except in the last test.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { Functions, mutation } from "../src/functions.ts";
import type { LogSinkOptions } from "../src/log-sinks.ts";
import { createServer } from "../src/server.ts";

const SECRET = "e6".repeat(32);
const NAME = "sinks-egress";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), memberId: 4 });

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

const bytes = (bodies: string[]) => bodies.reduce((n, b) => n + Buffer.byteLength(b), 0);

/** A webhook endpoint: records each body; `answers` (consumed in order, then 200) decides the status. */
function receiver(answers: number[] = []) {
  const got: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      got.push(await req.text());
      return new Response(null, { status: answers.shift() ?? 200 });
    },
  });
  stops.push(() => server.stop(true));
  const events = () => got.flatMap((b) => JSON.parse(b) as Record<string, unknown>[]);
  return { url: `http://127.0.0.1:${server.port}/hook`, got, events };
}

async function setup(logSinks: Partial<LogSinkOptions> = {}) {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: NAME, instanceSecret: SECRET },
  ).init();
  const functions = new Functions(engine).register("m", {
    add: mutation(async ({ db }) => {
      console.log("adding");
      return db.insert("items", {});
    }),
  });
  const s = createServer({
    engine,
    functions,
    port: 0,
    logSinks: {
      // Flushed and ticked by hand unless a test says otherwise.
      aggregationMs: 3_600_000,
      egressIntervalMs: 3_600_000,
      webhookBackoffMs: [1, 2],
      providerBackoffMs: [1, 2],
      random: () => 0,
      fetch: (async () => new Response(null, { status: 403 })) as unknown as typeof fetch,
      ...logSinks,
    },
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
    return (await r.json()) as { id: string; status: { type: string } };
  };
  const create = async (body: object) => {
    const { id } = await req("create_log_stream", body);
    await until(async () => (await req(`get_log_stream/${id}`)).status.type === "active", "the stream to start");
  };
  const add = () =>
    fetch(`${api}/mutation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "m:add", args: {} }),
    }).then((r) => r.json());
  const m = s.logManager;
  const tick = async () => {
    m.emitEgress();
    await m.idle();
  };
  const egressMeter = () => s.usageMeter.usage("dataEgressGb", "day");
  return { m, create, add, tick, egressMeter };
}

const egressEvents = (events: Record<string, unknown>[]) => events.filter((e) => e.topic === "log_stream_egress");

test("a tick sends the bytes sent since the last one; the verification and an egress-only batch are not counted", async () => {
  const hook = receiver();
  const t = await setup();
  await t.create({ logStreamType: "webhook", url: hook.url, format: "json" });
  expect(hook.got.length).toBe(1); // the connection test
  // Nothing sent yet but the verification: no event.
  await t.tick();
  expect(hook.got.length).toBe(1);

  await t.add();
  await t.m.idle();
  const sent = hook.got.slice(1);
  expect(sent.length).toBe(1);
  const before = t.egressMeter();
  await t.tick();
  expect(hook.got.length).toBe(3);
  const [event] = egressEvents(JSON.parse(hook.got[2]!));
  expect(Object.keys(event!).sort()).toEqual(["deployment", "egress_bytes", "timestamp", "topic"]);
  expect(event).toMatchObject({ topic: "log_stream_egress", egress_bytes: bytes(sent) });
  expect(typeof event!.timestamp).toBe("number");
  // Metered as data egress, as Convex's open-source backend meters it.
  expect(t.egressMeter() - before).toBe(bytes(sent));

  // The egress event went alone: its request is not counted, so the next tick has nothing to say.
  await t.tick();
  expect(hook.got.length).toBe(3);
  expect(t.egressMeter() - before).toBe(bytes(sent));
});

test("an egress event sent with other events is counted with them", async () => {
  const hook = receiver();
  const t = await setup();
  await t.create({ logStreamType: "webhook", url: hook.url, format: "json" });
  await t.add();
  await t.m.idle();
  const first = bytes(hook.got.slice(1));
  // The tick's event and the next function's events in one drain, so one request.
  t.m.emitEgress();
  await t.add();
  await t.m.idle();
  expect(hook.got.length).toBe(3);
  const mixed = JSON.parse(hook.got[2]!) as Record<string, unknown>[];
  expect(egressEvents(mixed)).toMatchObject([{ egress_bytes: first }]);
  expect(mixed.some((e) => e.topic === "function_execution")).toBe(true);
  await t.tick();
  expect(egressEvents(JSON.parse(hook.got[3]!))).toMatchObject([{ egress_bytes: Buffer.byteLength(hook.got[2]!) }]);
});

test("every answered attempt counts, a retried and a rejected one too", async () => {
  // Verification, then a 503 and a 200 for the first batch, then a 400 for the second.
  const hook = receiver([200, 503, 200, 400]);
  const t = await setup();
  await t.create({ logStreamType: "webhook", url: hook.url, format: "json" });
  await t.add();
  await t.m.idle();
  await t.add();
  await t.m.idle();
  expect(hook.got.length).toBe(4);
  expect(hook.got[1]).toBe(hook.got[2]!);
  const before = t.egressMeter();
  await t.tick();
  expect(egressEvents(JSON.parse(hook.got[4]!))).toMatchObject([{ egress_bytes: bytes(hook.got.slice(1, 4)) }]);
  expect(t.egressMeter() - before).toBe(bytes(hook.got.slice(1, 4)));
});

test("one count for every sink, sent to each sink that takes the topic", async () => {
  const all = receiver();
  const sent: string[] = [];
  const t = await setup({
    fetch: (async (_url: string, init?: RequestInit) => {
      sent.push(String(init?.body ?? ""));
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch,
  });
  await t.create({ logStreamType: "webhook", url: all.url, format: "json" });
  // Datadog, subscribed to function executions only.
  await t.create({
    logStreamType: "datadog",
    siteLocation: "US1",
    ddApiKey: "k",
    ddTags: [],
    topics: ["function_execution"],
  });
  await t.add();
  await t.m.idle();
  const counted = bytes(all.got.slice(1)) + bytes(sent.slice(1));
  expect(sent.length).toBe(2);
  await t.tick();
  expect(egressEvents(all.events())).toMatchObject([{ egress_bytes: counted }]);
  // Not subscribed: Datadog never gets it.
  expect(sent.length).toBe(2);
});

test("the tick runs every `egressIntervalMs`", async () => {
  const hook = receiver();
  const t = await setup({ aggregationMs: 20, egressIntervalMs: 100 });
  await t.create({ logStreamType: "webhook", url: hook.url, format: "json" });
  await t.add();
  const events = await until(() => egressEvents(hook.events()).length > 0 && hook.events(), "an egress event");
  expect(egressEvents(events)[0]!.egress_bytes).toBeGreaterThan(0);
});

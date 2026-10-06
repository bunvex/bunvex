// Out of retention on the wire (STUDY-06 D10): a mutation whose snapshot fell out of the write log, or a
// query_at_ts further back than MAX_TRANSACTION_WINDOW, fails as Convex's `ErrorCode::OutOfRetention`: a
// system error ("InternalServerError", the fixed message), HTTP 503, WebSocket close 1013 — never an OCC error.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v1 } from "@bunvex/protocol";
import { v } from "@bunvex/values";
import { INTERNAL_SERVER_ERROR_MESSAGE } from "../src/errors.ts";
import { Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { writeLogRetention: { maxRetentionNs: 1_000_000n } }, // 1 ms, so a test can outlive it
  ).init();
  const id = await engine.mutation((db) => db.insert("items", { n: 0 }));
  let runs = 0;
  const functions = new Functions(engine).register("m", {
    // Reads, lets two other commits more than 1 ms apart land (the first is then trimmed), then writes.
    slow: mutation(async ({ db }) => {
      runs++;
      await db.get(id as never);
      await engine.mutation((d) => d.insert("items", { n: 1 }));
      await Bun.sleep(5);
      await engine.mutation((d) => d.insert("items", { n: 2 }));
      await db.patch(id as never, { n: 3 });
    }),
    count: query(async ({ db }) => (await db.query("items").collect()).length),
  });
  const { server, stop } = createServer({ engine, functions, port: 0, redactLogsToClient: false });
  stops.push(stop);
  return { engine, port: server!.port, runs: () => runs };
}

test("HTTP: a mutation out of retention answers 503 InternalServerError, run once (not retried as OCC)", async () => {
  const { engine, port, runs } = await setup();
  const r = await fetch(`http://127.0.0.1:${port}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "m:slow", args: {} }),
  });
  expect(r.status).toBe(503);
  expect(await r.json()).toEqual({ code: "InternalServerError", message: INTERNAL_SERVER_ERROR_MESSAGE });
  expect(runs()).toBe(1);
  expect(engine.stats.retries).toBe(0);
  expect(engine.committer.outOfRetention).toBe(1);
});

test("sync: a mutation out of retention closes the connection with 1013 InternalServerError", async () => {
  const { port } = await setup();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/1.0.0/sync`);
  const got: v1.ServerMessage[] = [];
  ws.onmessage = (m) => got.push(v1.parseServerMessage(String(m.data)));
  const closed = new Promise<CloseEvent>((r) => (ws.onclose = r));
  await new Promise((r) => (ws.onopen = r));
  const send = (m: v1.ClientMessage) => ws.send(v1.encodeClientMessage(m));
  send({ type: "Connect", sessionId: crypto.randomUUID(), connectionCount: 0, lastCloseReason: null, clientTs: 0 });
  send({ type: "Mutation", requestId: 0, udfPath: "m:slow", args: [{}] });
  const c = await closed;
  expect(c.code).toBe(1013);
  expect(c.reason).toBe("InternalServerError");
  expect(got.find((m) => m.type === "MutationResponse")).toBeUndefined();
});

test("query_at_ts further back than MAX_TRANSACTION_WINDOW (10 s) answers 503; within it, the result", async () => {
  const { engine, port } = await setup();
  // Commits 12 s and 24 s after the first: the clock is the committer's to move.
  const t0 = engine.committer.visibleTs;
  let now = t0;
  (engine.committer as unknown as { clockNs: () => bigint }).clockNs = () => now;
  now = t0 + 12_000_000_000n;
  await engine.mutation((db) => db.insert("items", { n: 4 }));
  const t12 = engine.committer.visibleTs;
  now = t0 + 24_000_000_000n;
  await engine.mutation((db) => db.insert("items", { n: 5 }));
  const at = (ts: bigint) =>
    fetch(`http://127.0.0.1:${port}/api/query_at_ts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "m:count", args: {}, ts: v1.encodeU64(ts) }),
    });
  // The window reaches back to 14 s; the snapshot in force then is the 12 s commit's.
  const tooEarly = await at(t0);
  expect(tooEarly.status).toBe(503);
  expect(await tooEarly.json()).toEqual({ code: "InternalServerError", message: INTERNAL_SERVER_ERROR_MESSAGE });
  const ok = await at(t12);
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ status: "success", value: 2 });
});

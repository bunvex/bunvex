// Single-flight transitions behind a slow reader (STUDY-64 §1.3), as Convex's SingleFlightSender and
// SYNC_MAX_SEND_TRANSITION_COUNT (crates/sync/src/worker.rs): a client that does not read is sent no new
// transition while two wait in its socket's buffer; what changed meanwhile coalesces into the next one.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import type { v1 } from "@bunvex/protocol";
import { v } from "@bunvex/values";
import { Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { SYNC_MAX_SEND_TRANSITION_COUNT } from "../src/sync.ts";
import { rawWs } from "./raw-ws.ts";
import { syncUrl, v1Client } from "./v1-client.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

/** 1 MiB per result, so that a few unread transitions fill the kernel's buffers and then Bun's. */
const PAD = "x".repeat(1 << 20);

async function setup() {
  const engine = await new Engine(
    defineSchema({ counters: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const id = (await engine.mutation((db) => db.insert("counters", { n: 0 }))) as never;
  const functions = new Functions(engine).register("m", {
    big: query(async ({ db }) => ({ n: (await db.get("counters", id))?.n ?? null, pad: PAD })),
    small: query(async ({ db }) => (await db.get("counters", id))?.n ?? null),
    set: mutation(({ db }, { n }: { n: number }) => db.patch("counters", id, { n })),
  });
  const { server, sync, stop } = createServer({ engine, functions, port: 0 });
  stops.push(stop);
  return { functions, sync, port: server.port! };
}

const connect = (sessionId = crypto.randomUUID()): v1.ClientMessage => ({
  type: "Connect",
  sessionId,
  connectionCount: 0,
  lastCloseReason: null,
  clientTs: 0,
});
const subscribe = (udfPath: string): v1.ClientMessage => ({
  type: "ModifyQuerySet",
  baseVersion: 0,
  newVersion: 1,
  modifications: [{ type: "Add", queryId: 1, udfPath, args: [{}] }],
});
const transitions = (got: v1.ServerMessage[]) => got.filter((m): m is v1.Transition => m.type === "Transition");
const lastN = (ts: v1.Transition[]) => {
  for (let i = ts.length - 1; i >= 0; i--)
    for (const m of ts[i]!.modifications)
      if (m.type === "QueryUpdated") return m.value as { n: number } | number as unknown;
  return undefined;
};
async function until(f: () => boolean, ms = 5000) {
  const end = performance.now() + ms;
  while (!f()) {
    if (performance.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

test("Convex's default: 2", () => {
  expect(SYNC_MAX_SEND_TRANSITION_COUNT).toBe(2);
});

test("a client that stops reading is sent no new transitions; once it reads, it gets the latest state, in order", async () => {
  const { functions, sync, port } = await setup();
  const c = await rawWs(port);
  c.send(connect());
  c.send(subscribe("m:big"));
  await until(() => (lastN(transitions(c.got)) as { n: number } | undefined)?.n === 0);
  c.pause();
  const before = sync.stats.transitions;
  const WRITES = 40; // 40 MiB of results: far more than the kernel and Bun's 16 MiB buffer would hold
  for (let n = 1; n <= WRITES; n++) {
    await functions.runMutation("m:set", { n });
    await Bun.sleep(5);
  }
  await Bun.sleep(100);
  const computed = sync.stats.transitions - before;
  // What the kernel took, one being written, and two waiting: a handful, not one per write.
  expect(computed).toBeLessThan(WRITES / 3);
  c.resume();
  await until(() => (lastN(transitions(c.got)) as { n: number } | undefined)?.n === WRITES);
  // Every transition starts where the previous ended: none was lost (the client would throw otherwise).
  const ts = transitions(c.got);
  for (let i = 1; i < ts.length; i++) expect(ts[i]!.startVersion).toEqual(ts[i - 1]!.endVersion);
  expect(ts.length).toBeLessThan(WRITES / 2);
  c.end();
});

test("a slow client does not hold back the others", async () => {
  const { functions, port, url } = await setup().then((s) => ({ ...s, url: syncUrl(s.port) }));
  const slow = await rawWs(port);
  slow.send(connect());
  slow.send(subscribe("m:big"));
  await until(() => (lastN(transitions(slow.got)) as { n: number } | undefined)?.n === 0);
  slow.pause();
  const fast = await v1Client(url);
  fast.modify([{ type: "Add", queryId: 1, udfPath: "m:small", args: [{}] }]);
  await fast.transition(0);
  for (let n = 1; n <= 20; n++) await functions.runMutation("m:set", { n });
  await fast.until(() => lastN(fast.transitions()) === 20);
  slow.end();
});

test("mutation responses are not held back", async () => {
  const { port } = await setup();
  const c = await rawWs(port);
  c.send(connect());
  c.send(subscribe("m:big"));
  await until(() => transitions(c.got).length === 1);
  c.pause();
  for (let n = 1; n <= 30; n++)
    c.send({ type: "Mutation", requestId: n - 1, udfPath: "m:set", args: [{ n }] as v1.JSONValue[] });
  await Bun.sleep(200);
  c.resume();
  await until(() => c.got.filter((m) => m.type === "MutationResponse").length === 30);
  await until(() => (lastN(transitions(c.got)) as { n: number } | undefined)?.n === 30);
  const ts = transitions(c.got);
  for (let i = 1; i < ts.length; i++) expect(ts[i]!.startVersion).toEqual(ts[i - 1]!.endVersion);
  c.end();
});

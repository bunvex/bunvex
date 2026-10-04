// A WebSocket never loses a frame (STUDY-64 W0): Bun's default drops what passes 16 MiB of unsent data while
// the socket stays open. bunvex buffers up to Bun's largest limit, and closes a socket that would pass it
// (W1, DV-311); the client reconnects and resends. Convex buffers without limit.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import type { v1 } from "@bunvex/protocol";
import { v } from "@bunvex/values";
import { Functions, mutation, query } from "../src/functions.ts";
import { createServer, WS_BACKPRESSURE_LIMIT } from "../src/server.ts";
import { rawWs } from "./raw-ws.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

/** 1 MiB per result: a few dozen unread transitions are far past Bun's default 16 MiB. */
const PAD = "x".repeat(1 << 20);

async function setup(wsBackpressureLimit?: number) {
  const engine = await new Engine(
    defineSchema({ counters: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const id = (await engine.mutation((db) => db.insert("counters", { n: 0 }))) as never;
  const functions = new Functions(engine).register("m", {
    big: query(async ({ db }) => ({ n: (await db.get("counters", id))?.n ?? null, pad: PAD })),
    set: mutation(({ db }, { n }: { n: number }) => db.patch("counters", id, { n })),
  });
  const { server, stop } = createServer({ engine, functions, port: 0, wsBackpressureLimit });
  stops.push(stop);
  return { functions, port: server.port! };
}

const transitions = (got: v1.ServerMessage[]) => got.filter((m): m is v1.Transition => m.type === "Transition");
const lastN = (got: v1.ServerMessage[]) => {
  const ts = transitions(got);
  for (let i = ts.length - 1; i >= 0; i--)
    for (const m of ts[i]!.modifications) if (m.type === "QueryUpdated") return (m.value as { n: number }).n;
  return undefined;
};
async function until(f: () => boolean, ms = 10_000) {
  const end = performance.now() + ms;
  while (!f()) {
    if (performance.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}
async function subscribed(port: number) {
  const c = await rawWs(port);
  c.send({ type: "Connect", sessionId: crypto.randomUUID(), connectionCount: 0, lastCloseReason: null, clientTs: 0 });
  c.send({
    type: "ModifyQuerySet",
    baseVersion: 0,
    newVersion: 1,
    modifications: [{ type: "Add", queryId: 1, udfPath: "m:big", args: [{}] }],
  });
  await until(() => lastN(c.got) === 0);
  return c;
}
/** Every transition starts where the previous one ended: none was lost. */
function consecutive(got: v1.ServerMessage[]) {
  const ts = transitions(got);
  for (let i = 1; i < ts.length; i++) expect(ts[i]!.startVersion).toEqual(ts[i - 1]!.endVersion);
}

test("the limit is Bun's largest", () => {
  expect(WS_BACKPRESSURE_LIMIT).toBe(2 ** 32 - 1);
});

test("a client that stops reading loses no frame past 16 MiB of unsent data", async () => {
  const { functions, port } = await setup();
  const c = await subscribed(port);
  c.pause();
  const WRITES = 30;
  for (let n = 1; n <= WRITES; n++) {
    await functions.runMutation("m:set", { n });
    await Bun.sleep(5);
  }
  c.send({ type: "Mutation", requestId: 0, udfPath: "m:set", args: [{ n: WRITES + 1 }] as v1.JSONValue[] });
  await Bun.sleep(100);
  c.resume();
  await until(() => lastN(c.got) === WRITES + 1);
  consecutive(c.got);
  expect(c.got.filter((m) => m.type === "MutationResponse")).toHaveLength(1);
  c.end();
});

test("a socket whose unsent data passes the limit is closed, never left with frames missing", async () => {
  const { functions, port } = await setup(1 << 20);
  const c = await subscribed(port);
  c.pause();
  for (let n = 1; n <= 30; n++) {
    await functions.runMutation("m:set", { n });
    await Bun.sleep(5);
  }
  c.resume();
  await c.closed;
  consecutive(c.got);
  expect(lastN(c.got)).toBeLessThan(30);
});

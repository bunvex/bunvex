// A store failure under a function is a system error, as Convex's (STUDY-20 D8, DV-80): the function cannot
// catch it, HTTP answers 500 InternalServerError, and the sync connection closes with 1011 — never a
// MutationResponse that says "failed" for a mutation that may still commit. The client reconnects, resends
// with the same session and request id, and `_session_requests` gives it the real outcome.
// Found by the jepsen harness (#262, nemesis "all", memory store, seed 2).
import { afterEach, describe, expect, test } from "bun:test";
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
  const p = await MemoryPersistence.open(null, { durable: false });
  const engine = await new Engine(defineSchema({ counters: defineTable(v.any()) }), p).init();
  // Reads fail while `failing` is set: the store, not the function, is at fault.
  const store = { failing: false };
  const failable = <F extends (...a: never[]) => unknown>(f: F) =>
    ((...a: Parameters<F>) => {
      if (store.failing) throw new Error("disk read failed");
      return f(...a);
    }) as F;
  p.get = failable(p.get.bind(p));
  p.scan = failable(p.scan.bind(p));
  let runs = 0;
  const functions = new Functions(engine).register("m", {
    bump: mutation(async ({ db }) => {
      runs++;
      const c = await db.query("counters").first();
      if (c) await db.patch(c._id, { n: (c.n as number) + 1 });
      else await db.insert("counters", { n: 1 });
      return "bumped";
    }),
    // An app that swallows every error still cannot hide the store's: the store fails for this one read
    // only, so the caught error is the only thing that can fail the mutation.
    swallow: mutation(async ({ db }) => {
      store.failing = true;
      try {
        await db.query("counters").first();
      } catch {}
      store.failing = false;
      await db.insert("counters", { n: 100 });
    }),
    read: query(async ({ db }) => (await db.query("counters").first())?.n ?? 0),
  });
  const { server, stop } = createServer({ engine, functions, port: 0, redactLogsToClient: false });
  stops.push(stop);
  const count = () => engine.query(async (db) => (await db.query("counters").first())?.n ?? 0);
  return { url: `ws://127.0.0.1:${server!.port}/api/1.0.0/sync`, port: server!.port, store, count, runs: () => runs };
}

/** A sync connection on `sessionId`, as the client opens one after a reconnect. */
async function connect(url: string, sessionId: string, connectionCount: number) {
  const ws = new WebSocket(url);
  const got: v1.ServerMessage[] = [];
  const answers: ((m: v1.ServerMessage) => void)[] = [];
  ws.onmessage = (m) => {
    const msg = v1.parseServerMessage(String(m.data));
    got.push(msg);
    for (const a of answers) a(msg);
  };
  const closed = new Promise<CloseEvent>((r) => (ws.onclose = r));
  await new Promise((r) => (ws.onopen = r));
  const send = (m: v1.ClientMessage) => ws.send(v1.encodeClientMessage(m));
  send({ type: "Connect", sessionId, connectionCount, lastCloseReason: null, clientTs: 0 });
  const mutate = (requestId: number, udfPath: string) => {
    const answer = new Promise<v1.ServerMessage>((r) =>
      answers.push((m) => m.type === "MutationResponse" && m.requestId === requestId && r(m)),
    );
    send({ type: "Mutation", requestId, udfPath, args: [{}] });
    return Promise.race([answer, closed]);
  };
  return { ws, got, closed, send, mutate };
}

describe("a store failure under a function is a system error (DV-80)", () => {
  test("sync: a resend whose record lookup fails closes with 1011; the next resend gets the real outcome", async () => {
    const { url, store, count, runs } = await setup();
    const session = crypto.randomUUID();
    // The first attempt commits, but its answer is lost with the connection.
    const a = await connect(url, session, 0);
    expect(await a.mutate(0, "m:bump")).toMatchObject({ type: "MutationResponse", success: true });
    a.ws.close();
    await a.closed;
    // The resend's lookup of its record fails: not "failed" (it did commit), but a closed connection.
    store.failing = true;
    const b = await connect(url, session, 1);
    const closed = (await b.mutate(0, "m:bump")) as CloseEvent;
    expect(closed.code).toBe(1011);
    expect(closed.reason).toBe("InternalServerError");
    expect(b.got.find((m) => m.type === "MutationResponse")).toBeUndefined();
    // The client resends again; the record answers, and the mutation ran once.
    store.failing = false;
    const c = await connect(url, session, 2);
    expect(await c.mutate(0, "m:bump")).toMatchObject({ type: "MutationResponse", success: true, result: "bumped" });
    c.ws.close();
    expect(runs()).toBe(1);
    expect(await count()).toBe(1);
  });

  test("sync: the function cannot catch it; nothing it wrote commits", async () => {
    const { url, count } = await setup();
    const a = await connect(url, crypto.randomUUID(), 0);
    expect(((await a.mutate(0, "m:swallow")) as CloseEvent).code).toBe(1011);
    expect(await count()).toBe(0);
  });

  test("sync: a subscribed query whose read fails closes with 1011 (no QueryFailed)", async () => {
    const { url, store } = await setup();
    store.failing = true;
    const a = await connect(url, crypto.randomUUID(), 0);
    a.send({
      type: "ModifyQuerySet",
      baseVersion: 0,
      newVersion: 1,
      modifications: [{ type: "Add", queryId: 0, udfPath: "m:read", args: [{}] }],
    });
    const closed = await a.closed;
    expect(closed.code).toBe(1011);
    expect(a.got.some((m) => m.type === "Transition")).toBe(false);
  });

  test("HTTP: 500 InternalServerError with the fixed message; nothing written", async () => {
    const { port, store, count } = await setup();
    for (const path of ["m:bump", "m:swallow"]) {
      store.failing = path === "m:bump";
      const r = await fetch(`http://127.0.0.1:${port}/api/mutation`, {
        method: "POST",
        body: JSON.stringify({ path, args: {} }),
      });
      expect(r.status).toBe(500);
      expect(await r.json()).toEqual({ code: "InternalServerError", message: INTERNAL_SERVER_ERROR_MESSAGE });
    }
    store.failing = false;
    expect(await count()).toBe(0);
  });
});

// The OCC error on the wire (STUDY-21): a mutation that exhausts its retries fails the HTTP request with
// 503 and Convex's code, as Convex's backend does; inside an action it is an ordinary exception.
import { expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { action, Functions, mutation } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

test("an exhausted mutation answers 503 OptimisticConcurrencyControlFailure; from an action, a function error", async () => {
  const engine = await new Engine(
    defineSchema({ counters: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { occInitialBackoffMs: 1, occMaxBackoffMs: 2 },
  ).init();
  const id = await engine.mutation((db) => db.insert("counters", { n: 0 }));
  // Every execution of m:bump reads the counter, then lets m:other overwrite it before committing.
  let rival: Promise<unknown> = Promise.resolve();
  const functions = new Functions(engine).register("m", {
    other: mutation(({ db }) => db.patch("counters", id, { n: Math.random() })),
    bump: mutation(async ({ db }) => {
      await db.get("counters", id);
      await rival;
      await db.patch("counters", id, { n: -1 });
    }),
    viaAction: action((ctx) => ctx.runMutation("m:bump", {})),
  });
  // m:other commits between m:bump's read and its commit, every time: chain it on each execution.
  const origMutation = engine.mutation.bind(engine);
  const origWithTs = engine.mutationWithTs.bind(engine);
  engine.mutationWithTs = ((body, source) =>
    origWithTs(async (db) => {
      if (source === "m:bump") rival = origMutation((d) => d.patch("counters", id, { n: Math.random() }), "m:other");
      return body(db);
    }, source)) as typeof engine.mutationWithTs;
  const { server, stop } = createServer({ engine, functions, port: 0, redactLogsToClient: false });
  try {
    const call = async (kind: string, path: string) => {
      const r = await fetch(`http://127.0.0.1:${server!.port}/api/${kind}`, {
        method: "POST",
        body: JSON.stringify({ path, args: {} }),
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const m = await call("mutation", "m:bump");
    expect(m.status).toBe(503);
    expect(m.body.code).toBe("OptimisticConcurrencyControlFailure");
    expect(m.body.message).toBe(
      `Documents read from or written to the "counters" table changed while this mutation was being run and on every subsequent retry. A call to "m:other" changed the document with ID "${id}".`,
    );
    const a = await call("action", "m:viaAction");
    expect(a.status).toBe(200);
    expect(a.body.status).toBe("error");
    expect(a.body.errorMessage).toContain('Uncaught Error: Documents read from or written to the "counters" table');
    // Over the WebSocket (v0): the mutation's result carries the OCC message (STUDY-21 D2).
    const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/ws`);
    const frames: { id?: number; e?: string }[] = [];
    ws.onmessage = (m) => frames.push(JSON.parse(String(m.data)));
    await new Promise((r) => (ws.onopen = r));
    ws.send(JSON.stringify({ t: "mut", id: 1, path: "m:bump", args: {} }));
    while (frames.length < 1) await Bun.sleep(5);
    expect(frames[0].e).toMatch(/^\[Request ID: [0-9a-f]{16}\] Documents read from or written to the "counters" table/);
    ws.close();
  } finally {
    stop();
  }
});

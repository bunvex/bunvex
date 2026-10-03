// Many queries per connection at once (STUDY-64 §1.4): C connections each subscribe to Q queries of their own in one
// query set change, against a store whose reads take L ms (a remote store's round trip). Reports the time until
// every connection has its first transition, and the most store reads in flight at once.
//   bun packages/server/bench/sync-query-concurrency.ts [connections=20] [queries=200] [latency ms=2]
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v1 } from "@bunvex/protocol";
import { v } from "@bunvex/values";
import { Functions, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const C = Number(process.argv[2] ?? 20);
const Q = Number(process.argv[3] ?? 200);
const L = Number(process.argv[4] ?? 2);

const p = await MemoryPersistence.open(null, { durable: false });
const engine = await new Engine(defineSchema({ items: defineTable(v.any()).index("by_i", ["i"]) }), p).init();
await engine.mutation(async (db) => {
  for (let i = 0; i < Q; i++) await db.insert("items", { i });
});
let inFlight = 0;
let most = 0;
const slow = <F extends (...a: never[]) => unknown>(f: F) =>
  (async (...a: Parameters<F>) => {
    inFlight++;
    most = Math.max(most, inFlight);
    await Bun.sleep(L);
    try {
      return await f(...a);
    } finally {
      inFlight--;
    }
  }) as unknown as F;
p.get = slow(p.get.bind(p));
p.scan = slow(p.scan.bind(p));
const functions = new Functions(engine).register("m", {
  item: query(async ({ db }, { i }: { i: number; c: number }) =>
    db
      .query("items")
      .withIndex("by_i", (q) => q.eq("i", i))
      .first(),
  ),
});
const { server, stop } = createServer({ engine, functions, port: 0 });

const sockets = await Promise.all(
  Array.from({ length: C }, async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/1.0.0/sync`);
    await new Promise((r) => (ws.onopen = r));
    return ws;
  }),
);
const start = performance.now();
await Promise.all(
  sockets.map(
    (ws, c) =>
      new Promise<void>((done) => {
        ws.onmessage = (m) => {
          if (String(m.data).startsWith('{"type":"Transition"')) done();
        };
        ws.send(
          v1.encodeClientMessage({
            type: "Connect",
            sessionId: crypto.randomUUID(),
            connectionCount: 0,
            lastCloseReason: null,
            clientTs: 0,
          }),
        );
        ws.send(
          v1.encodeClientMessage({
            type: "ModifyQuerySet",
            baseVersion: 0,
            newVersion: 1,
            modifications: Array.from({ length: Q }, (_, i) => ({
              type: "Add" as const,
              queryId: i,
              udfPath: "m:item",
              args: [{ i, c }],
            })),
          }),
        );
      }),
  ),
);
console.log(
  `${C} connections × ${Q} queries, store reads of ${L} ms: all loaded in ${(performance.now() - start).toFixed(0)} ms; ` +
    `at most ${most} store reads in flight`,
);
for (const ws of sockets) ws.close();
stop();
process.exit(0);

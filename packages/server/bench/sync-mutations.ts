// WebSocket mutation throughput with and without a session (STUDY-23 §4.3): with a `Connect`, each
// mutation also looks up and records its `_session_requests` entry, for idempotent resends.
//   [PERSISTENCE=postgres PERSISTENCE_URL=…] bun packages/server/bench/sync-mutations.ts [connections=64] [per connection=500]
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v1 } from "@bunvex/protocol";
import { v } from "@bunvex/values";
import { Functions, mutation } from "../src/functions.ts";
import { openPersistence, persistenceConfigFromEnv } from "../src/persistence.ts";
import { createServer } from "../src/server.ts";

const C = Number(process.argv[2] ?? 64);
const M = Number(process.argv[3] ?? 500);

async function run(withSession: boolean) {
  const engine = await new Engine(
    defineSchema({ t: defineTable(v.any()).index("by_i", ["i"]) }),
    process.env.PERSISTENCE
      ? await openPersistence(persistenceConfigFromEnv())
      : await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", {
    add: mutation(async ({ db }, { i }: { i: number }) => {
      await db
        .query("t")
        .withIndex("by_i", (q) => q.eq("i", i))
        .first();
      return db.insert("t", { i });
    }),
  });
  const { server, stop } = createServer({ engine, functions, port: 0 });
  const url = `ws://127.0.0.1:${server.port}/api/1.0.0/sync`;
  const conns = await Promise.all(
    Array.from({ length: C }, async (_, c) => {
      const ws = new WebSocket(url);
      await new Promise((r) => (ws.onopen = r));
      if (withSession)
        ws.send(
          v1.encodeClientMessage({
            type: "Connect",
            sessionId: crypto.randomUUID(),
            connectionCount: 0,
            lastCloseReason: null,
            clientTs: 0,
          }),
        );
      let done = 0;
      let finish!: () => void;
      const finished = new Promise<void>((r) => (finish = r));
      ws.onmessage = (m) => {
        if (String(m.data).includes('"MutationResponse"') && ++done === M) finish();
      };
      return { ws, c, finished };
    }),
  );
  const t0 = performance.now();
  for (const { ws, c } of conns)
    for (let r = 0; r < M; r++)
      ws.send(v1.encodeClientMessage({ type: "Mutation", requestId: r, udfPath: "m:add", args: [{ i: c * M + r }] }));
  await Promise.all(conns.map((x) => x.finished));
  const ms = performance.now() - t0;
  for (const { ws } of conns) ws.close();
  stop();
  return ms;
}

for (const s of [false, true, false, true]) {
  const ms = await run(s);
  console.log(`${s ? "session   " : "no session"}: ${C} × ${M} mutations: ${(((C * M) / ms) * 1000) | 0}/s`);
}
process.exit(0);

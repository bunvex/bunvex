// Fan-out of one hot query to N connections: v0 per-key pub/sub vs v1 per-connection transitions
// (STUDY-23 §5). Each of M writes changes the query; time until every connection has seen the last one.
//   [PROTO=v0|v1] bun packages/server/bench/sync-fanout.ts [connections=500] [writes=200]
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v1 } from "@bunvex/protocol";
import { v } from "@bunvex/values";
import { Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const N = Number(process.argv[2] ?? 500);
const M = Number(process.argv[3] ?? 200);

async function run(proto: "v0" | "v1") {
  const engine = await new Engine(
    defineSchema({ counters: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const id = await engine.mutation((db) => db.insert("counters", { n: 0 }));
  const functions = new Functions(engine).register("m", {
    get: query(async ({ db }) => (await db.get("counters", id))?.n ?? null),
    set: mutation(({ db }, { n }: { n: number }) => db.patch("counters", id, { n })),
  });
  const { server, stop } = createServer({ engine, functions, port: 0 });
  const base = `ws://127.0.0.1:${server.port}`;
  let done = 0;
  let allDone!: () => void;
  const finished = new Promise<void>((r) => (allDone = r));
  let ready = 0;
  let allReady!: () => void;
  const subscribed = new Promise<void>((r) => (allReady = r));
  const sockets: WebSocket[] = [];
  for (let i = 0; i < N; i++) {
    const ws = new WebSocket(proto === "v0" ? `${base}/ws` : `${base}/api/1.0.0/sync`);
    let seen0 = false;
    let last = false;
    ws.onmessage = (m) => {
      const s = String(m.data);
      const value =
        proto === "v0"
          ? (JSON.parse(s) as { v?: number }).v
          : ((JSON.parse(s) as { modifications?: { value?: number }[] }).modifications ?? [])[0]?.value;
      if (value === 0 && !seen0) {
        seen0 = true;
        if (++ready === N) allReady();
      }
      if (value === M && !last) {
        last = true;
        if (++done === N) allDone();
      }
    };
    await new Promise((r) => (ws.onopen = r));
    if (proto === "v0") ws.send(JSON.stringify({ t: "sub", path: "m:get", args: {} }));
    else {
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
          modifications: [{ type: "Add", queryId: 1, udfPath: "m:get", args: [{}] }],
        }),
      );
    }
    sockets.push(ws);
  }
  await subscribed;
  const t0 = performance.now();
  for (let n = 1; n <= M; n++) await functions.runMutation("m:set", { n });
  await finished;
  const ms = performance.now() - t0;
  for (const ws of sockets) ws.close();
  stop();
  return ms;
}

for (const proto of (process.env.PROTO ? [process.env.PROTO] : ["v0", "v1", "v0", "v1"]) as ("v0" | "v1")[]) {
  const ms = await run(proto);
  console.log(
    `${proto}: ${N} connections × ${M} writes: ${ms.toFixed(0)} ms (${((N * M) / ms).toFixed(0)} deliveries/ms)`,
  );
}
process.exit(0);

// Slow readers next to fast ones (STUDY-64 §1.3): one hot query with a large result, F connections that read
// and S that stop reading, W writes (1 ms apart). Reports the time until every fast connection has seen the
// last write, the transitions computed for the slow ones, and the process's memory.
//   bun packages/server/bench/sync-slow-client.ts [fast=100] [slow=20] [writes=100] [result KiB=256]
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v1 } from "@bunvex/protocol";
import { v } from "@bunvex/values";
import { Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { rawWs } from "../test/raw-ws.ts";

const F = Number(process.argv[2] ?? 100);
const S = Number(process.argv[3] ?? 20);
const W = Number(process.argv[4] ?? 100);
const KIB = Number(process.argv[5] ?? 256);

const engine = await new Engine(
  defineSchema({ counters: defineTable(v.any()) }),
  await MemoryPersistence.open(null, { durable: false }),
).init();
const id = await engine.mutation((db) => db.insert("counters", { n: 0 }));
const pad = "x".repeat(KIB * 1024);
const functions = new Functions(engine).register("m", {
  get: query(async ({ db }) => ({ n: (await db.get("counters", id))?.n ?? null, pad })),
  set: mutation(({ db }, { n }: { n: number }) => db.patch("counters", id, { n })),
});
const { server, sync, stop } = createServer({ engine, functions, port: 0 });
const port = server.port!;
const connect = (): v1.ClientMessage => ({
  type: "Connect",
  sessionId: crypto.randomUUID(),
  connectionCount: 0,
  lastCloseReason: null,
  clientTs: 0,
});
const add: v1.ClientMessage = {
  type: "ModifyQuerySet",
  baseVersion: 0,
  newVersion: 1,
  modifications: [{ type: "Add", queryId: 1, udfPath: "m:get", args: [{}] }],
};
const seen = (got: v1.ServerMessage[], n: number) =>
  got.some(
    (m) =>
      m.type === "Transition" &&
      m.modifications.some((x) => x.type === "QueryUpdated" && (x.value as { n: number }).n === n),
  );

const slow = await Promise.all(Array.from({ length: S }, () => rawWs(port)));
for (const c of slow) {
  c.send(connect());
  c.send(add);
}
while (!slow.every((c) => seen(c.got, 0))) await Bun.sleep(5);
for (const c of slow) c.pause();

let fastTransitions = 0;
let done = 0;
let allDone!: () => void;
const finished = new Promise<void>((r) => (allDone = r));
const fast: WebSocket[] = [];
let ready = 0;
await new Promise<void>((allReady) => {
  for (let i = 0; i < F; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/1.0.0/sync`);
    let first = false;
    let last = false;
    ws.onmessage = (m) => {
      const t = JSON.parse(String(m.data)) as { type: string; modifications?: { value?: { n: number } }[] };
      if (t.type === "Transition") fastTransitions++;
      const n = t.modifications?.[0]?.value?.n;
      if (n === 0 && !first) {
        first = true;
        if (++ready === F) allReady();
      }
      if (n === W && !last) {
        last = true;
        if (++done === F) allDone();
      }
    };
    ws.onopen = () => {
      ws.send(v1.encodeClientMessage(connect()));
      ws.send(v1.encodeClientMessage(add));
    };
    fast.push(ws);
  }
});

Bun.gc(true);
const rss0 = process.memoryUsage().rss;
const t0 = sync.stats.transitions;
const f0 = fastTransitions;
const start = performance.now();
for (let n = 1; n <= W; n++) {
  await functions.runMutation("m:set", { n });
  await Bun.sleep(1);
}
await finished;
const ms = performance.now() - start;
await Bun.sleep(200);
Bun.gc(true);
const rss1 = process.memoryUsage().rss;
console.log(
  `fast ${F}, slow ${S}, ${W} writes of ${KIB} KiB: fast clients done in ${ms.toFixed(0)} ms; ` +
    `${sync.stats.transitions - t0 - (fastTransitions - f0)} transitions computed for the slow ones; ` +
    `RSS +${((rss1 - rss0) / 2 ** 20).toFixed(0)} MiB`,
);
for (const c of slow) c.end();
for (const ws of fast) ws.close();
stop();
process.exit(0);

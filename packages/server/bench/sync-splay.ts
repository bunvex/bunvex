// Splaying (STUDY-08 §3.5, DV-64): N sync sessions watch one query, and one write invalidates all of them.
// Measures the time until every session has its transition, and how long the event loop stalls meanwhile:
// a 1 ms probe timer records how late it fires (p99, max). Sessions run in process (no sockets, so the
// per-socket send cost, about 6 µs per frame, is not included).
//   bun packages/server/bench/sync-splay.ts [sessions=10000]      Env: SPLAY=off|on (default: both)
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v1 } from "@bunvex/protocol";
import { v } from "@bunvex/values";
import { Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { SyncSession } from "../src/sync.ts";

const N = Number(process.argv[2] ?? 10_000);

async function run(splay: boolean) {
  const engine = await new Engine(
    defineSchema({ counters: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const id = await engine.mutation((db) => db.insert("counters", { n: 0 }));
  const functions = new Functions(engine).register("m", {
    get: query(async ({ db }) => (await db.get("counters", id))?.n ?? null),
    set: mutation(({ db }, { n }: { n: number }) => db.patch("counters", id, { n })),
  });
  // Off: multiplier 0, which notifies every session at once, as before splaying was built.
  const { sync, stop } = createServer({
    engine,
    functions,
    port: 0,
    subscriptionSplay: splay ? {} : { multiplierMs: 0 },
  });
  let transitions = 0;
  for (let i = 0; i < N; i++) {
    const s = new SyncSession(sync);
    s.open({
      send: (f: string) => {
        if (f.startsWith('{"type":"Transition"')) transitions++;
      },
      getBufferedAmount: () => 0,
      close() {},
    } as never);
    s.message(
      v1.encodeClientMessage({
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 1,
        modifications: [{ type: "Add", queryId: 1, udfPath: "m:get", args: [{}] }],
      }),
    );
  }
  while (transitions < N) await Bun.sleep(5);

  const lateness: number[] = [];
  let expected = performance.now() + 1;
  const probe = setInterval(() => {
    const now = performance.now();
    lateness.push(Math.max(0, now - expected));
    expected = now + 1;
  }, 1);
  const t0 = performance.now();
  await functions.runMutation("m:set", { n: 1 });
  const commitMs = performance.now() - t0;
  while (transitions < 2 * N) await Bun.sleep(1);
  const ms = performance.now() - t0;
  clearInterval(probe);
  stop();
  lateness.sort((a, b) => a - b);
  const p = (q: number) => lateness[Math.min(lateness.length - 1, Math.floor(q * lateness.length))] ?? 0;
  return {
    splay: splay ? "on" : "off",
    sessions: N,
    commitMs: Number(commitMs.toFixed(1)),
    allDeliveredMs: Math.round(ms),
    probeP50ms: Number(p(0.5).toFixed(2)),
    probeP99ms: Number(p(0.99).toFixed(2)),
    probeMaxms: Number(p(1).toFixed(1)),
    splayed: sync.stats.splayed,
  };
}

for (const mode of process.env.SPLAY ? [process.env.SPLAY === "on"] : [false, true])
  console.log(JSON.stringify(await run(mode)));
process.exit(0);

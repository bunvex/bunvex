// The cost of a log entry's "why it ran" links on the re-run path (STUDY-131 AD-27): each sync query's run
// looks up the invalidation it answers and carries its links into the function log. One in-process session
// holds N queries that each read the whole table (args differ only), so every commit re-runs all N; timed
// from the mutation's call until the session's transition is sent. Tracing off, the ring at its default (8).
//   bun packages/server/bench/sync-rerun-links.ts [queries=1000] [commits=100] [rounds=4]
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v1 } from "@bunvex/protocol";
import { v } from "@bunvex/values";
import { Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { SyncSession } from "../src/sync.ts";

const N = Number(process.argv[2] ?? 1000);
const COMMITS = Number(process.argv[3] ?? 100);
const ROUNDS = Number(process.argv[4] ?? 4);

async function run() {
  const engine = await new Engine(
    defineSchema({ messages: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", {
    // a result that changes on every commit, so every re-run is sent
    all: query(async ({ db }, _: { a: number }) => (await db.query("messages").collect()).length),
    send: mutation(({ db }, { a }: { a: number }) => db.insert("messages", { a })),
  });
  const { sync, stop } = createServer({ engine, functions, port: 0, subscriptionSplay: { multiplierMs: 0 } });
  let transitions = 0;
  let wake: (() => void) | null = null;
  const s = new SyncSession(sync);
  s.open({
    send: (f: string) => {
      if (f.startsWith('{"type":"Transition"')) {
        transitions++;
        wake?.();
      }
    },
    getBufferedAmount: () => 0,
    close() {},
    ping() {},
  } as never);
  s.message(
    v1.encodeClientMessage({
      type: "ModifyQuerySet",
      baseVersion: 0,
      newVersion: 1,
      modifications: Array.from({ length: N }, (_, i) => ({
        type: "Add" as const,
        queryId: i,
        udfPath: "m:all",
        args: [{ a: i }],
      })),
    }),
  );
  while (transitions < 1) await Bun.sleep(5);
  const times: number[] = [];
  for (let c = 0; c < COMMITS; c++) {
    const before = transitions;
    const sent = new Promise<void>((r) => {
      wake = () => transitions > before && r();
    });
    const t = performance.now();
    await functions.runMutation("m:send", { a: c });
    await sent;
    times.push(performance.now() - t);
  }
  stop();
  times.sort((a, b) => a - b);
  const p = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? 0;
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  return {
    queries: N,
    commits: times.length,
    meanMs: +mean.toFixed(2),
    p50Ms: +p(0.5).toFixed(2),
    p99Ms: +p(0.99).toFixed(2),
  };
}

for (let r = 0; r < ROUNDS; r++) console.log(JSON.stringify(await run()));
process.exit(0);

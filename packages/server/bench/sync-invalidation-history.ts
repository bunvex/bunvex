// The inspector's cost on the invalidation path (STUDY-131 AD-25): the sync hub's commit handler, timed per
// commit, with the history ring at 8 (the default) and at 0 (off). One in-process session holds N queries:
//   narrow: each reads one author's messages; a commit writes one author: 1 key invalidated per commit;
//   wide:   each reads the whole table (args differ only); a commit invalidates all N keys.
// Splaying is off, so every invalidated key is notified at once.
//   bun packages/server/bench/sync-invalidation-history.ts [queries=2000] [commits=300]
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v1 } from "@bunvex/protocol";
import { v } from "@bunvex/values";
import { Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { SyncSession } from "../src/sync.ts";

const N = Number(process.argv[2] ?? 2000);
const COMMITS = Number(process.argv[3] ?? 300);

async function run(shape: "narrow" | "wide", history: number) {
  const engine = await new Engine(
    defineSchema({ messages: defineTable(v.any()).index("by_author", ["author"]) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", {
    byAuthor: query(({ db }, { a }: { a: number }) =>
      db
        .query("messages")
        .withIndex("by_author", (q) => q.eq("author", a))
        .collect(),
    ),
    all: query(async ({ db }, _: { a: number }) => (await db.query("messages").collect()).length),
    send: mutation(({ db }, { a }: { a: number }) => db.insert("messages", { author: a })),
  });
  const { sync, stop } = createServer({
    engine,
    functions,
    port: 0,
    subscriptionSplay: { multiplierMs: 0 },
    invalidationHistory: history,
  });
  let transitions = 0;
  const s = new SyncSession(sync);
  s.open({
    send: (f: string) => {
      if (f.startsWith('{"type":"Transition"')) transitions++;
    },
    getBufferedAmount: () => 0,
    close() {},
  } as never);
  const path = shape === "narrow" ? "m:byAuthor" : "m:all";
  s.message(
    v1.encodeClientMessage({
      type: "ModifyQuerySet",
      baseVersion: 0,
      newVersion: 1,
      modifications: Array.from({ length: N }, (_, i) => ({
        type: "Add" as const,
        queryId: i,
        udfPath: path,
        args: [{ a: i }],
      })),
    }),
  );
  for (let i = 0; transitions < 1; i++) {
    if (i > 2000) throw new Error("no first transition");
    await Bun.sleep(5);
  }
  // time the hub's commit handler (the invalidation path) on every commit
  const hub = sync as unknown as { onCommit: (e: unknown) => void };
  const original = hub.onCommit.bind(sync);
  const times: number[] = [];
  hub.onCommit = (e) => {
    const t = performance.now();
    original(e);
    times.push(performance.now() - t);
  };
  for (let c = 0; c < COMMITS; c++) {
    const before = transitions;
    await functions.runMutation("m:send", { a: c % N });
    for (let i = 0; transitions === before; i++) {
      if (i > 2000) throw new Error(`no transition after commit ${c}`);
      await Bun.sleep(1);
    }
  }
  stop();
  times.sort((a, b) => a - b);
  const p = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? 0;
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  return {
    shape,
    history,
    queries: N,
    commits: times.length,
    meanUs: Math.round(mean * 1000),
    p50Us: Math.round(p(0.5) * 1000),
    p99Us: Math.round(p(0.99) * 1000),
  };
}

for (const shape of ["narrow", "wide"] as const)
  for (const history of [0, 8, 0, 8]) console.log(JSON.stringify(await run(shape, history)));
process.exit(0);

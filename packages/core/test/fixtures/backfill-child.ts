// The crash child of index-backfill.test.ts: opens the store given on the command line with a new index,
// backfills slowly, and once a progress checkpoint is durable stops writing and prints "checkpoint". The parent
// SIGKILLs it then. The child must not get further while it waits for the kill: a parent slowed down by the
// machine's load would otherwise find the backfill finished and nothing to resume (STUDY-132 §3.3).
//   bun backfill-child.ts <log path>
import { v } from "@bunvex/values";
import { Engine } from "../../src/engine.ts";
import { MemoryPersistence } from "../../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../../src/schema.ts";

const p = await MemoryPersistence.open(process.argv[2], { durable: true });
let engine: Engine | null = null;
// Every commit flushes: the first flush after a checkpoint landed never ends, so nothing more is written.
const flush = p.flush.bind(p);
let stopped = false;
p.flush = () => {
  if ((engine?.indexWorker?.stats.checkpoints ?? 0) === 0) return flush();
  if (!stopped) {
    stopped = true;
    console.log("checkpoint");
  }
  return new Promise<void>(() => {});
};
engine = await new Engine(defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) }), p, {
  indexBackfill: { chunkSize: 200, chunkRate: 10, progressIntervalMs: 200 },
}).init();
await engine.indexesReady();
console.log("ready"); // never reached: the backfill stops at its first checkpoint

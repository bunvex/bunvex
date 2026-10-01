// The crash child of index-backfill.test.ts: opens the store given on the command line with a new index,
// backfills slowly, and prints "checkpoint" once a progress checkpoint is durable. The parent SIGKILLs it.
//   bun backfill-child.ts <log path>
import { v } from "@bunvex/values";
import { Engine } from "../../src/engine.ts";
import { MemoryPersistence } from "../../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../../src/schema.ts";

const p = await MemoryPersistence.open(process.argv[2], { durable: true });
const e = await new Engine(defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) }), p, {
  indexBackfill: { chunkSize: 200, chunkRate: 10, progressIntervalMs: 200 },
}).init();
const timer = setInterval(() => {
  if ((e.indexWorker?.stats.checkpoints ?? 0) > 0) {
    console.log("checkpoint");
    clearInterval(timer);
  }
}, 10);
await e.indexesReady();
console.log("ready"); // too late: the parent wanted a crash mid-backfill

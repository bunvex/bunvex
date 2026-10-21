// A server running pushed code in `vm`, in a process of its own (rejection-parity.test.ts): under `vm` an unhandled
// rejection reaches the server's process (DV-528), which `bun test` would count as its own failure. It deploys the
// module at `argv[2]`, says `{"port": N}` on a line of stdout, then a line `{"rejection": "…"}` for each rejection
// its `unhandledRejection` listener hears (in production, Bun prints it to stderr), until it is killed.
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { createServer, Functions } from "@bunvex/server";
import { v } from "@bunvex/values";

process.env.TZ = "UTC";
process.on("unhandledRejection", (reason) => {
  const text = reason instanceof Error ? reason.message : String(reason);
  process.stdout.write(`${JSON.stringify({ rejection: text })}\n`);
});

const engine = await new Engine(
  defineSchema({ items: defineTable(v.any()) }),
  await MemoryPersistence.open(null, { durable: false }),
).init();
const functions = new Functions(engine);
const s = createServer({ engine, functions, port: 0, deployable: true, functionSandbox: "vm" });
await s.codeReady;
await engine.mutation(async (db) => {
  await db.insert("items", { k: 1 });
});
await s.deployCode([{ path: "cases.js", source: await Bun.file(process.argv[2]!).text(), environment: "isolate" }]);
process.stdout.write(`${JSON.stringify({ port: s.server.port })}\n`);

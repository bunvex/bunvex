// A server in a process of its own, for node-process-errors.test.ts: what a Node action's callback throws, and its
// `process.exit`, reach this process (the test runner keeps uncaught exceptions to itself). Prints its port, then
// serves until the test kills it.
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { Functions } from "../../src/functions.ts";
import { createServer } from "../../src/server.ts";

const SERVER = ["@bunvex", "server"].join("/");
const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
const functions = new Functions(engine);
// A hang shows as this timeout.
functions.nodeActionTimeoutMs = 3000;
const s = createServer({
  engine,
  functions,
  port: 0,
  deployable: true,
  moduleStorage: new MemoryBlobStore(),
  redactLogsToClient: false,
});
await s.deployCode([
  {
    path: "n.js",
    environment: "node",
    source: `"use node";
import { action } from ${JSON.stringify(SERVER)};
import fs from "node:fs";
export const callback = action(async (_ctx, { tag }) =>
  new Promise(() => { fs.exists("asdf", () => { throw new Error("Yikes " + tag); }); }));
export const timer = action(async () => new Promise(() => { setTimeout(() => { throw new Error("late"); }, 10); }));
export const slow = action(async () => { await new Promise((r) => setTimeout(r, 300)); return "slow"; });
export const exit = action(async (_ctx, { code }) => { code === undefined ? process.exit() : process.exit(code); });
export const caught = action(async () => { try { process.exit(4); } catch { return "caught"; } });
export const ok = action(async () => "ok");`,
  },
]);
console.log(`PORT ${s.server.port}`);

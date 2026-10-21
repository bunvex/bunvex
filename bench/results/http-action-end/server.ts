// The server `bench.ts` measures (an HTTP action's end under `vm`, STUDY-77 §8), in a process of its own: pushed code
// with HTTP routes, served in-process (`vm`). Run from a checkout's root; prints `{"port": N, "pid": N}`, then serves
// until it is killed.
//
//   bun bench/results/http-action-end/server.ts
import { defineSchema, defineTable, Engine } from "../../../packages/core/src/index.ts";
import { MemoryPersistence } from "../../../packages/core/src/persistence/memory.ts";
import { Functions } from "../../../packages/server/src/functions.ts";
import { createServer } from "../../../packages/server/src/server.ts";
import { v } from "../../../packages/values/src/index.ts";

const SERVER = JSON.stringify(["bunvex", "server"].join("/"));
const SOURCE = `
import { httpRouter, httpActionGeneric as httpAction, queryGeneric as query } from ${SERVER};
export const q = query(async () => 1);
const KiB = new Uint8Array(1024).fill(7);
const MiB = new Uint8Array(1024 * 1024).fill(9);
const http = httpRouter();
http.route({ path: "/empty", method: "GET", handler: httpAction(async () => new Response(null)) });
http.route({ path: "/ok", method: "GET", handler: httpAction(async () => new Response("ok")) });
http.route({ path: "/query", method: "GET", handler: httpAction(async (ctx) => new Response(String(await ctx.runQuery("http:q", {})))) });
http.route({ path: "/bytes", method: "GET", handler: httpAction(async () => new Response(KiB)) });
http.route({ path: "/stream", method: "GET", handler: httpAction(async () => { let n = 0; return new Response(new ReadableStream({ pull(c) { if (n++ === 3) return c.close(); c.enqueue(KiB); } }, { highWaterMark: 0 })); }) });
http.route({ path: "/timerStream", method: "GET", handler: httpAction(async () => { let n = 0; return new Response(new ReadableStream({ async pull(c) { await new Promise((r) => setTimeout(r, 0)); if (n++ === 3) return c.close(); c.enqueue(KiB); } }, { highWaterMark: 0 })); }) });
http.route({ path: "/mib", method: "GET", handler: httpAction(async () => { let n = 0; return new Response(new ReadableStream({ pull(c) { if (n++ === 1) return c.close(); c.enqueue(MiB); } }, { highWaterMark: 0 })); }) });
export default http;
`;

const engine = await new Engine(
  defineSchema({ items: defineTable(v.any()) }),
  await MemoryPersistence.open(null, { durable: false }),
).init();
const functions = new Functions(engine);
const s = createServer({ engine, functions, port: 0, deployable: true, fileStorage: null });
await s.codeReady;
await s.deployCode([{ path: "http.js", source: SOURCE, environment: "isolate" }]);
process.stdout.write(`${JSON.stringify({ port: s.server.port, pid: process.pid })}\n`);

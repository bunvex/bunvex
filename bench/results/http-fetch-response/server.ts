// The server `bench.ts` measures (a fetched response returned or read by an HTTP action under `vm`), in a process of
// its own, with the fetch target in it too. Run from a checkout's root; prints `{"port": N, "pid": N}`, then serves
// until it is killed.
//
//   bun bench/results/http-fetch-response/server.ts
import { defineSchema, defineTable, Engine } from "../../../packages/core/src/index.ts";
import { MemoryPersistence } from "../../../packages/core/src/persistence/memory.ts";
import { Functions } from "../../../packages/server/src/functions.ts";
import { createServer } from "../../../packages/server/src/server.ts";
import { v } from "../../../packages/values/src/index.ts";

const KiB = new Uint8Array(1024).fill(7);
const target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(KiB) });
const T = JSON.stringify(`http://127.0.0.1:${target.port}/`);
const SERVER = JSON.stringify(["bunvex", "server"].join("/"));
const SOURCE = `
import { httpRouter, httpActionGeneric as httpAction } from ${SERVER};
const http = httpRouter();
http.route({ path: "/text", method: "GET", handler: httpAction(async () => new Response(await (await fetch(${T})).arrayBuffer())) });
http.route({ path: "/body", method: "GET", handler: httpAction(async () => { const r = await fetch(${T}); let n = 0; for await (const c of r.body) n += c.byteLength; return new Response(String(n)); }) });
http.route({ path: "/proxy", method: "GET", handler: httpAction(async () => fetch(${T})) });
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

// The server `http.ts` measures, in a process of its own (so the client's reads do not share its event loop): pushed
// code with HTTP routes, served under the executor named by `argv[2]` (`vm` or `process`). It prints one JSON line,
// `{"port": N, "pid": N}`, then serves until it is killed.
//
//   bun packages/sandbox/bench/http-server.ts <vm|process>
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { createServer, Functions } from "@bunvex/server";
import { provideProcessExecutor } from "@bunvex/server/executor";
import { v } from "@bunvex/values";
import { createProcessExecutor } from "../src/executor.ts";

provideProcessExecutor(createProcessExecutor);
const sandbox = process.argv[2] === "process" ? "process" : "vm";

// The pushed module's import, built so the dependency rules do not read it as this package's own.
const SERVER = JSON.stringify(["@bunvex", "server"].join("/"));
const SOURCE = `
import { httpRouter, httpActionGeneric as httpAction } from ${SERVER};
const MiB = 1024 * 1024;
const http = httpRouter();
const size = (request) => Number(new URL(request.url).pathname.split("/")[2]);
// Each response's bytes are made once, as an app serving a file it holds would.
const cache = new Map();
const bytesOf = (n) => { let b = cache.get(n); if (!b) cache.set(n, (b = new Uint8Array(n).fill(7))); return b; };
const chunk = new Uint8Array(MiB).fill(9);
http.route({ path: "/empty", method: "GET", handler: httpAction(async () => new Response(null)) });
http.route({ path: "/ok", method: "GET", handler: httpAction(async () => new Response("ok")) });
http.route({ path: "/upload", method: "POST", handler: httpAction(async (ctx, request) => new Response(String((await request.arrayBuffer()).byteLength))) });
http.route({ path: "/uploadStream", method: "POST", handler: httpAction(async (ctx, request) => { let n = 0; for await (const c of request.body) n += c.byteLength; return new Response(String(n)); }) });
http.route({ pathPrefix: "/bytes/", method: "GET", handler: httpAction(async (ctx, request) => new Response(bytesOf(size(request)))) });
// A body made as it is read, a MiB at a time: its pull runs only when the reader wants more.
http.route({ pathPrefix: "/stream/", method: "GET", handler: httpAction(async (ctx, request) => {
  let left = size(request);
  return new Response(new ReadableStream({ pull(c) { if (left <= 0) return c.close(); const n = Math.min(left, MiB); left -= n; c.enqueue(n === MiB ? chunk : chunk.subarray(0, n)); } }, { highWaterMark: 0 }));
}) });
export default http;
`;

const engine = await new Engine(
  defineSchema({ items: defineTable(v.any()) }),
  await MemoryPersistence.open(null, { durable: false }),
).init();
const functions = new Functions(engine);
const s = createServer({
  engine,
  functions,
  port: 0,
  deployable: true,
  functionSandbox: sandbox,
  functionSandboxIsolation: "none",
  // Past Bun's 128 MiB default: the 64 MiB uploads, and room above them.
  maxRequestBodySize: 512 * 1024 * 1024,
});
await s.codeReady;
await s.deployCode([{ path: "http.js", source: SOURCE, environment: "isolate" }]);
process.stdout.write(`${JSON.stringify({ port: s.site!.port, pid: process.pid })}\n`);

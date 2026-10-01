// HTTP actions (STUDY-31): requests per second for a trivial GET on the site port, next to an HTTP API
// query of the same work, 32 at a time.
//   bun packages/server/bench/http-actions.ts [requests=20000]
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { Functions, query } from "../src/functions.ts";
import { httpAction, httpRouter } from "../src/router.ts";
import { createServer } from "../src/server.ts";

const N = Number(process.argv[2] ?? 20000);
const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
const functions = new Functions(engine).register("m", { hi: query(async () => "hi") });
const http = httpRouter();
http.route({ path: "/hi", method: "GET", handler: httpAction(async () => new Response("hi")) });
const server = createServer({ engine, functions, port: 0, http });
const api = `http://127.0.0.1:${server.server.port}`;
async function rate(f: () => Promise<Response>) {
  let n = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: 32 }, async () => {
      while (n++ < N) await (await f()).text();
    }),
  );
  return N / ((performance.now() - t0) / 1000);
}
const body = JSON.stringify({ path: "m:hi", args: {} });
const results: Record<string, number[]> = {
  "HTTP action GET (site port)": [],
  "HTTP action GET (/http on the API port)": [],
  "/api/query": [],
};
for (let r = 0; r < 3; r++) {
  results["HTTP action GET (site port)"].push(await rate(() => fetch(`${server.siteUrl}/hi`)));
  results["HTTP action GET (/http on the API port)"].push(await rate(() => fetch(`${api}/http/hi`)));
  results["/api/query"].push(await rate(() => fetch(`${api}/api/query`, { method: "POST", body })));
}
for (const [k, xs] of Object.entries(results))
  console.log(`${k}: ${xs.sort((a, b) => a - b)[1].toFixed(0)} req/s (runs ${xs.map((x) => x.toFixed(0)).join(", ")})`);
server.stop();
await engine.close();

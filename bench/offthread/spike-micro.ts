// SPIKE: the same query through the call runner, on the server's engine and on a reader engine, in one thread.
//   DATA=<dir with bunvex.sqlite> bun bench/offthread/spike-micro.ts
import { Engine } from "@bunvex/core";
import { encodeCallRequest } from "../../packages/core/src/call-wire.ts";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { Functions } from "bunvex/server";
import { bench, benchSchema } from "../functions.ts";

const path = `${process.env.DATA}/bunvex.sqlite`;
const main = await new Engine(benchSchema, new SqlitePersistence(path, { durable: false }), {}).init();
const mainFns = new Functions(main).register("bench", bench);
const reader = await new Engine(benchSchema, new SqlitePersistence(path, { durable: false, reader: true }), {
  ...main.spikeIdentity,
}).openReader();
const readerFns = new Functions(reader).register("bench", bench);
const ts = (main as any).committer.visibleTs as bigint;
let id = 0;
const request = (i: number) =>
  encodeCallRequest({
    kind: "query", name: "bench:listByTenant", args: JSON.stringify({ tenantId: `t${i % 200}` }), internal: false,
    session: null, id: ++id, ts, now: Date.now(), identity: null, systemIdentity: false, request: null,
    tracked: false, journal: null, refused: false,
  });
async function time(label: string, engine: Engine, fns: Functions, n: number) {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await engine.runCallText(request(i), fns.spikeBodies);
  console.log(`${label}: ${(((performance.now() - t0) / n) * 1000).toFixed(1)} µs/call`);
}
const only = process.env.ONLY;
for (let r = 0; r < 3; r++) {
  if (only !== "reader") await time("server engine", main, mainFns, 20000);
  if (only !== "server") await time("reader engine", reader, readerFns, 20000);
}
console.log((await reader.runCallText(request(7), readerFns.spikeBodies)).slice(0, 120));
process.exit(0);

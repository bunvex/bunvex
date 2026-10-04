// The cost of checking an action's `fetch` (STUDY-80): the scheme check and Bun's options dropped, per call.
// 1. The check alone, around a `fetch` that answers at once (no network), against that `fetch` called bare.
// 2. An action doing N fetches to a local server, with the check (as served) and without it.
//   bun packages/server/bench/action-fetch.ts
import { defineSchema, Engine, setFetchSender } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { isolateFetch } from "../src/action-fetch.ts";
import type { FunctionLog } from "../src/function-log.ts";
import { action, Functions } from "../src/functions.ts";

const N = Number(process.env.N ?? 20_000);
const ok = new Response("ok");
const instant = (async () => ok) as unknown as typeof fetch;

async function perCall(label: string, f: typeof fetch) {
  for (let i = 0; i < 10_000; i++) await f("https://example.com/x?i=1", { method: "POST", body: "x" });
  const t = performance.now();
  for (let i = 0; i < N * 10; i++) await f("https://example.com/x?i=1", { method: "POST", body: "x" });
  console.log(`${label.padEnd(48)} ${(((performance.now() - t) * 1e6) / (N * 10)).toFixed(0)} ns/call`);
}
await perCall("bare fetch (instant)", instant);
await perCall("checked fetch (instant)", isolateFetch(instant));

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
const url = `http://127.0.0.1:${server.port}/x`;
const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
const functions = new Functions(engine).register("m", {
  fetches: action(async (_ctx, { n }: { n: number }) => {
    for (let i = 0; i < n; i++) await (await fetch(url)).text();
    return null;
  }),
});
functions.functionLog = { append: () => {} } as unknown as FunctionLog;
async function e2e(label: string) {
  await functions.runAction("m:fetches", { n: 1000 });
  const t = performance.now();
  await functions.runAction("m:fetches", { n: N });
  console.log(`${label.padEnd(48)} ${(((performance.now() - t) * 1000) / N).toFixed(2)} µs/fetch`);
}
await e2e("action fetch to a local server, checked");
setFetchSender(null);
await e2e("action fetch to a local server, unchecked");
server.stop(true);
process.exit(0);

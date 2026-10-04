// The cost of an action's `fetch` path (STUDY-80): the scheme check and Bun's options dropped (PR 1), and the
// proxy wrapper (PR 2: the 407 check, and the proxy when there is one), per call.
// 1. Each layer alone, around a `fetch` that answers at once (no network), against that `fetch` called bare.
// 2. An action doing N fetches to a local server: as served without a proxy, with no check at all, and
//    through a local proxy (the extra hop is the operator's choice; shown for scale).
//   bun packages/server/bench/action-fetch.ts
import { defineSchema, Engine, setFetchSender } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { isolateFetch } from "../src/action-fetch.ts";
import { startAddressScreen } from "../src/address-screen.ts";
import type { FunctionLog } from "../src/function-log.ts";
import { action, Functions } from "../src/functions.ts";
import { proxiedFetch } from "../src/http-proxy.ts";
import { startScreeningProxy } from "../test/screening-proxy.ts";

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
await perCall("checked + 407 check, no proxy (instant)", isolateFetch(proxiedFetch(instant, null, true)));
await perCall(
  "checked + proxy init (instant)",
  isolateFetch(proxiedFetch(instant, { url: "http://127.0.0.1:1", clientId: "bench" }, true)),
);

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
functions.httpProxy = null;
await e2e("action fetch to a local server, no screen");
const screen = startAddressScreen("metadata");
functions.httpProxy = { url: screen.url, clientId: "bench" };
await e2e("action fetch through bunvex's screen (DV-325)");
screen.stop();
const proxy = await startScreeningProxy(() => false);
functions.httpProxy = { url: proxy.url, clientId: "bench" };
await e2e("action fetch through a local proxy");
setFetchSender(null);
await e2e("action fetch to a local server, unchecked");
proxy.stop();
server.stop(true);
process.exit(0);

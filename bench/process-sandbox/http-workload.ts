// STUDY-168: a realistic workload over HTTP: a bunvex server with app/sb.ts in a mode, and a load generator in the
// same script (one machine), 80 % listByTenant queries (convex-bench's) and 20 % insertItem mutations.
//   bun bench/process-sandbox/http-workload.ts <vm|bwrap> [concurrency] [seconds]
import { createServer } from "@bunvex/server";
import { type Mode, setup } from "./setup.ts";

const mode = (process.argv[2] ?? "vm") as Mode;
const C = Number(process.argv[3] ?? 32);
const SECONDS = Number(process.argv[4] ?? 10);
const s = await setup(mode, { memoryMiB: 128 });
for (let o = 0; o < 50; o += 5)
  await s.functions.runMutation("sb:seed", { tenants: 5, perTenant: 200, counters: o === 0 ? 64 : 0, tenantOffset: o });
const app = createServer({ engine: s.engine, functions: s.functions, port: 0, label: mode });
const base = `http://127.0.0.1:${app.server.port}`;

let nonce = 0;
const call = (kind: "query" | "mutation", path: string, args: unknown) =>
  fetch(`${base}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  }).then(async (r) => {
    const body = (await r.json()) as { status: string; errorMessage?: string };
    if (body.status !== "success") throw new Error(body.errorMessage);
  });
const one = () =>
  ++nonce % 5 === 0
    ? call("mutation", "sb:insertItem", { tenantId: `t${nonce % 50}` })
    : call("query", "sb:listByTenant", { tenantId: `t${nonce % 50}`, nonce });

for (let i = 0; i < 500; i++) await one();
const samples: number[] = [];
let errors = 0;
const end = performance.now() + SECONDS * 1000;
await Promise.all(
  Array.from({ length: C }, async () => {
    while (performance.now() < end) {
      const t = performance.now();
      await one().catch(() => errors++);
      samples.push(performance.now() - t);
    }
  }),
);
samples.sort((a, b) => a - b);
const p = (q: number) => +(samples[Math.floor(q * samples.length)] as number).toFixed(3);
console.log(
  JSON.stringify({
    phase: "http",
    mode,
    concurrency: C,
    perSec: Math.round(samples.length / SECONDS),
    errors,
    p50Ms: p(0.5),
    p99Ms: p(0.99),
  }),
);
await s.close();
process.exit(0);

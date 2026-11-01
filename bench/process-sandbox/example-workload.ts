// STUDY-168 round 2: an existing app, unchanged, end to end over HTTP: examples/pagination (its `messages` module,
// with its schema), today's `vm` executor against the sandboxed child. The load generator runs in the same script.
// Mix: 60 % `messages:list` (a page of 10, first page), 20 % `messages:listByAuthor`, 20 % `messages:send`.
//   bun bench/process-sandbox/example-workload.ts <vm|bwrap|process> [concurrency] [seconds] [poolSize]
import { Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { createServer, Functions } from "@bunvex/server";
import schema from "../../examples/pagination/bunvex/schema.ts";
import { CodeVersion } from "../../packages/server/src/code-version.ts";
import { SandboxedDeployment } from "./host.ts";
import { bundle } from "./setup.ts";

const mode = (process.argv[2] ?? "vm") as "vm" | "bwrap" | "process";
const C = Number(process.argv[3] ?? 32);
const SECONDS = Number(process.argv[4] ?? 10);
const poolSize = Number(process.argv[5] ?? 0);
const APP = `${import.meta.dir}/../../examples/pagination/bunvex/messages.ts`;
process.env.MAX_BYTES_WRITTEN_PER_SECOND ||= String(Number.MAX_SAFE_INTEGER);
process.env.MAX_ROWS_WRITTEN_PER_SECOND ||= String(Number.MAX_SAFE_INTEGER);

const engine = await new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
const functions = new Functions(engine);
let dep: SandboxedDeployment | null = null;
if (mode === "vm") {
  const version = await CodeVersion.load([{ path: "messages.js", source: await bundle(APP), environment: "isolate" }], {
    seed: Uint32Array.of(1, 2, 3, 4),
    timestamp: Date.now(),
  });
  const fns: Record<string, never> = {};
  for (const [key, f] of version.functions) fns[key.slice(key.indexOf(":") + 1)] = f as never;
  functions.register("messages", fns);
} else {
  dep = new SandboxedDeployment({ app: APP, sandbox: mode === "process" ? "none" : mode, memoryMiB: 128, poolSize });
  const started = await dep.start();
  for (const [mod, fns] of Object.entries(dep.stubs(started.functions))) functions.register(mod, fns as never);
}
const app = createServer({ engine, functions, port: 0, label: mode });
const base = `http://127.0.0.1:${app.server.port}`;
const authors = ["ada", "grace", "linus", "barbara", "ken"];

let n = 0;
const call = (kind: "query" | "mutation", path: string, args: unknown) =>
  fetch(`${base}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  }).then(async (r) => {
    const body = (await r.json()) as { status: string; errorMessage?: string };
    if (body.status !== "success") throw new Error(body.errorMessage);
  });
const send = () => call("mutation", "messages:send", { body: `message ${++n}`, author: authors[n % 5] });
// Distinct pages per call (`id`, as the client's paginated queries send), so the query cache does not answer them.
const one = () => {
  const k = ++n % 5;
  if (k < 3) return call("query", "messages:list", { paginationOpts: { numItems: 10, cursor: null, id: n } });
  if (k === 3)
    return call("query", "messages:listByAuthor", {
      paginationOpts: { numItems: 10, cursor: null, id: n },
      author: authors[n % 5],
    });
  return send();
};

for (let i = 0; i < 2000; i++) await send();
for (let i = 0; i < 500; i++) await one();
const samples: number[] = [];
let errors = 0;
let firstError = "";
const end = performance.now() + SECONDS * 1000;
await Promise.all(
  Array.from({ length: C }, async () => {
    while (performance.now() < end) {
      const t = performance.now();
      await one().catch((e) => {
        errors++;
        firstError ||= String((e as Error).message).slice(0, 100);
      });
      samples.push(performance.now() - t);
    }
  }),
);
samples.sort((a, b) => a - b);
const p = (q: number) => +(samples[Math.floor(q * samples.length)] as number).toFixed(3);
console.log(
  JSON.stringify({
    phase: "example-http",
    app: "examples/pagination",
    mode,
    poolSize,
    concurrency: C,
    perSec: Math.round(samples.length / SECONDS),
    errors,
    firstError,
    p50Ms: p(0.5),
    p99Ms: p(0.99),
  }),
);
await dep?.stop();
process.exit(0);

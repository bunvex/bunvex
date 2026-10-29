// Per-call cost of an action, `vm` against `process` (STUDY-171 §12.9): pushed code deployed to a server per
// executor, each action run in-process through `Functions.runAction` (no HTTP), one at a time. The lines: an empty
// action (the action's own latency), one `runQuery`, `fetch` to a server in a process of its own (so its work does
// not share the host's event loop), and `ctx.storage` round trips up to 16 MiB + 1 byte (STUDY-168 §14.1), whose
// throughput is the bytes stored and read back over the time.
//
//   bun packages/sandbox/bench/actions.ts [calls=1000] [warmup=100] [only=<part of a line's name>] [--json] [--vm]
//
// `--vm`: the `vm` executor only (to compare a branch whose `process` runs no actions).
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { createServer, Functions } from "@bunvex/server";
import { provideProcessExecutor } from "@bunvex/server/executor";
import { v } from "@bunvex/values";
import { createProcessExecutor } from "../src/executor.ts";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const JSON_OUT = process.argv.includes("--json");
const VM_ONLY = process.argv.includes("--vm");
const CALLS = Number(args[0] ?? 1000);
const WARMUP = Number(args[1] ?? 100);
const ONLY = args[2];
provideProcessExecutor(createProcessExecutor);

const SERVER = JSON.stringify(["@bunvex", "server"].join("/"));
const SOURCE = `
import { action, query } from ${SERVER};
export const q = query(async (ctx, { i }) => i);
export const empty = action(async (ctx, { i }) => i);
export const runQuery = action(async (ctx, { i }) => ctx.runQuery("b:q", { i }));
export const fetchGet = action(async (ctx, { url, n }) => { let bytes = 0; for (let k = 0; k < n; k++) bytes += (await (await fetch(url)).arrayBuffer()).byteLength; return bytes; });
export const fetchPost = action(async (ctx, { url, size }) => (await (await fetch(url, { method: "POST", body: new Uint8Array(size) })).text()).length);
export const store = action(async (ctx, { size }) => ctx.storage.store(new Blob([new Uint8Array(size)])));
export const get = action(async (ctx, { id }) => (await ctx.storage.get(id)).size);
export const roundTrip = action(async (ctx, { size }) => { const id = await ctx.storage.store(new Blob([new Uint8Array(size)])); const n = (await ctx.storage.get(id)).size; await ctx.storage.delete(id); return n; });
`;

/** Files in memory (the server's `BlobStore`). */
class Blobs {
  private readonly blobs = new Map<string, Uint8Array>();
  async put(body: ReadableStream<Uint8Array> | Blob | Uint8Array) {
    const bytes = new Uint8Array(await new Response(body as Blob).arrayBuffer());
    const key = crypto.randomUUID();
    this.blobs.set(key, bytes);
    return {
      key,
      size: bytes.byteLength,
      sha256: new Uint8Array(new Bun.CryptoHasher("sha256").update(bytes).digest()),
    };
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    return b ? new Blob([b as Uint8Array<ArrayBuffer>]).stream() : null;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
  async *list() {
    for (const key of this.blobs.keys()) yield { key, lastModified: 0 };
  }
}

const q = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;

// The fetch target, in a process of its own: `/n/<bytes>` answers that many bytes, a POST its body's length.
const TARGET = `
const cache = new Map();
const s = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
  if (req.method === "POST") return new Response(String((await req.arrayBuffer()).byteLength));
  const n = Number(new URL(req.url).pathname.split("/")[2] ?? 0);
  let b = cache.get(n); if (!b) cache.set(n, (b = new Uint8Array(n)));
  return new Response(b);
} });
console.log(s.port);
`;
const target = Bun.spawn([process.execPath, "-e", TARGET], { stdout: "pipe", stderr: "inherit" });
const firstLine = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return text.trim();
};
const T = `http://127.0.0.1:${await firstLine(target.stdout)}`;

async function deployment(sandbox: "vm" | "process") {
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
    fileStorage: new Blobs(),
  });
  await s.codeReady;
  await s.deployCode([{ path: "b.js", source: SOURCE, environment: "isolate" }]);
  return { s, functions };
}

const MiB = 1024 * 1024;
type Line = {
  name: string;
  /** How many calls, given the default count. */
  calls: (n: number) => number;
  /** Bytes moved per call, for a throughput. */
  bytes?: number;
  /** Before the timed calls (a file to read). */
  setup?: (f: Functions) => Promise<Record<string, unknown>>;
  run: (f: Functions, i: number, ctx: Record<string, unknown>) => Promise<unknown>;
};
const lines: Line[] = [
  { name: "empty action", calls: (n) => n, run: (f, i) => f.runAction("b:empty", { i }) },
  { name: "action, 1 runQuery", calls: (n) => n, run: (f, i) => f.runAction("b:runQuery", { i }) },
  { name: "fetch GET, empty body", calls: (n) => n, run: (f) => f.runAction("b:fetchGet", { url: `${T}/n/0`, n: 1 }) },
  {
    name: "10 x fetch GET, empty body",
    calls: (n) => n / 4,
    run: (f) => f.runAction("b:fetchGet", { url: `${T}/n/0`, n: 10 }),
  },
  {
    name: "fetch GET, 64 KiB",
    calls: (n) => n,
    bytes: 64 * 1024,
    run: (f) => f.runAction("b:fetchGet", { url: `${T}/n/65536`, n: 1 }),
  },
  {
    name: "fetch GET, 1 MiB",
    calls: (n) => n / 4,
    bytes: MiB,
    run: (f) => f.runAction("b:fetchGet", { url: `${T}/n/${MiB}`, n: 1 }),
  },
  {
    name: "fetch POST, 1 MiB",
    calls: (n) => n / 4,
    bytes: MiB,
    run: (f) => f.runAction("b:fetchPost", { url: `${T}/`, size: MiB }),
  },
  { name: "storage.store, 1 KiB", calls: (n) => n, bytes: 1024, run: (f) => f.runAction("b:store", { size: 1024 }) },
  {
    name: "storage.get, 1 KiB",
    calls: (n) => n,
    bytes: 1024,
    setup: async (f) => ({ id: await f.runAction("b:store", { size: 1024 }) }),
    run: (f, _, c) => f.runAction("b:get", { id: c.id }),
  },
  {
    name: "store + get + delete, 1 MiB",
    calls: (n) => n / 4,
    bytes: 2 * MiB,
    run: (f) => f.runAction("b:roundTrip", { size: MiB }),
  },
  {
    name: "store + get + delete, 16 MiB + 1",
    calls: (n) => Math.max(10, n / 50),
    bytes: 2 * (16 * MiB + 1),
    run: (f) => f.runAction("b:roundTrip", { size: 16 * MiB + 1 }),
  },
];

type Result = {
  line: string;
  sandbox: string;
  calls: number;
  p50: number;
  mean: number;
  p99: number;
  mibPerS?: number;
};
const results: Result[] = [];
for (const sandbox of VM_ONLY ? (["vm"] as const) : (["vm", "process"] as const)) {
  const d = await deployment(sandbox);
  let i = 0;
  for (const line of lines) {
    if (ONLY && !line.name.includes(ONLY)) continue;
    const ctx = line.setup ? await line.setup(d.functions) : {};
    const n = Math.max(1, Math.round(line.calls(CALLS)));
    const warm = Math.min(WARMUP, n);
    for (let w = 0; w < warm; w++) await line.run(d.functions, i++, ctx);
    const us: number[] = [];
    for (let c = 0; c < n; c++) {
      const t = performance.now();
      await line.run(d.functions, i++, ctx);
      us.push((performance.now() - t) * 1000);
    }
    const mean = us.reduce((a, b) => a + b, 0) / us.length;
    const r: Result = { line: line.name, sandbox, calls: n, p50: q(us, 0.5), mean, p99: q(us, 0.99) };
    if (line.bytes) r.mibPerS = line.bytes / MiB / (q(us, 0.5) / 1e6);
    results.push(r);
  }
  await d.s.shutdown();
}
target.kill();
if (JSON_OUT) for (const r of results) console.log(JSON.stringify(r));
const fmt = (r: Result | undefined) =>
  r
    ? `${r.p50.toFixed(0)} / ${r.mean.toFixed(0)} / ${r.p99.toFixed(0)}${r.mibPerS ? ` (${r.mibPerS.toFixed(0)} MiB/s)` : ""}`
    : "";
console.log(`p50 / mean / p99 µs per action, after a warm-up; ${CALLS} calls for the short lines`);
console.log("| Action | vm | process | process − vm, p50 |");
console.log("|---|---|---|---|");
for (const line of lines) {
  const a = results.find((r) => r.line === line.name && r.sandbox === "vm");
  const b = results.find((r) => r.line === line.name && r.sandbox === "process");
  if (a) console.log(`| ${line.name} (${a.calls}) | ${fmt(a)} | ${fmt(b)} | ${b ? (b.p50 - a.p50).toFixed(0) : ""} |`);
}
process.exit(0);

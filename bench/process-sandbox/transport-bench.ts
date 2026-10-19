// STUDY-168 microbenchmark: the round trip of one small message (an op the size of a `db.get` and its answer) over
// each transport a sandboxed executor could use, against a plain function call and a vm context call.
//   bun bench/process-sandbox/transport-bench.ts [iterations]
// Prints one JSON line per transport: mean, p50 and p99 in µs, sequential round trips.
import { serialize } from "bun:jsc";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { FrameReader, frame } from "./framing.ts";

const N = Number(process.argv[2] ?? 20_000);
const WARMUP = 2_000;
const op = { t: "op", call: 1, op: 7, kind: "get", id: "jd7a2k4n9g8w3v5e6r1t0y2u3i4o5p6a" };
const doc = {
  _id: "jd7a2k4n9g8w3v5e6r1t0y2u3i4o5p6a",
  _creationTime: 1760000000000.5,
  tenantId: "t0",
  title: "item 1 of tenant 0",
  status: "open",
  amount: 4242,
  createdAt: 1760000000000,
};

function stats(name: string, samples: number[], extra: Record<string, unknown> = {}) {
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const p = (q: number) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))];
  console.log(
    JSON.stringify({
      transport: name,
      n: samples.length,
      meanUs: +(mean * 1000).toFixed(2),
      p50Us: +(p(0.5) * 1000).toFixed(2),
      p99Us: +(p(0.99) * 1000).toFixed(2),
      bytes: serialize(op).byteLength,
      ...extra,
    }),
  );
}

async function measure(name: string, roundTrip: () => Promise<unknown>, extra?: Record<string, unknown>) {
  for (let i = 0; i < WARMUP; i++) await roundTrip();
  const samples: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    await roundTrip();
    samples.push(performance.now() - t);
  }
  stats(name, samples, extra);
}

const echoChild = join(import.meta.dir, "transport-echo.ts");

// 1. A plain async call: what an in-process `ctx.db.get` costs before any engine work.
await measure("in-process call", async () => doc);

// 2. A call into a vm context (today's executor, DV-164): the handler is the context's, its result crosses back.
{
  const ctx = vm.createContext({ doc });
  const fn = vm.runInContext("(async (op) => doc)", ctx) as (op: unknown) => Promise<unknown>;
  await measure("vm context call", () => fn(op));
}

// 3. A Bun Worker (option B): postMessage both ways (structured clone).
{
  const w = new Worker(new URL("./transport-echo.ts", import.meta.url).href, { env: { MODE: "worker" } });
  let resolve: (v: unknown) => void = () => {};
  w.onmessage = (e) => resolve(e.data);
  await measure("worker postMessage", () => {
    const p = new Promise((r) => {
      resolve = r;
    });
    w.postMessage(op);
    return p;
  });
  w.terminate();
}

// 4. A child process with Bun's IPC channel (JSON and structured-clone serialization).
for (const serialization of ["json", "advanced"] as const) {
  let resolve: (v: unknown) => void = () => {};
  const child = Bun.spawn(["bun", echoChild], {
    env: { ...process.env, MODE: "ipc" },
    ipc: (m) => resolve(m),
    serialization,
    stdio: ["inherit", "inherit", "inherit"],
  });
  await new Promise((r) => {
    resolve = r;
  });
  await measure(`process ipc (${serialization})`, () => {
    const p = new Promise((r) => {
      resolve = r;
    });
    child.send(op);
    return p;
  });
  child.kill();
  await child.exited;
}

// 5. A child process over its stdin/stdout, length-prefixed frames of `bun:jsc` serialize (structured clone).
{
  const child = Bun.spawn(["bun", echoChild], {
    env: { ...process.env, MODE: "stdio" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  let resolve: (v: unknown) => void = () => {};
  const reader = new FrameReader((m) => resolve(m));
  (async () => {
    for await (const chunk of child.stdout) reader.push(chunk);
  })();
  await measure("process stdio frames", () => {
    const p = new Promise((r) => {
      resolve = r;
    });
    child.stdin.write(frame(op));
    child.stdin.flush();
    return p;
  });
  child.kill();
  await child.exited;
}

// 6. A child process over a Unix socket, the same frames.
{
  const path = join(tmpdir(), `bunvex-study-${process.pid}.sock`);
  let resolve: (v: unknown) => void = () => {};
  const reader = new FrameReader((m) => resolve(m));
  const connected = Promise.withResolvers<Socket>();
  const server = createServer((s) => {
    s.setNoDelay(true);
    s.on("data", (d) => reader.push(d as Uint8Array));
    connected.resolve(s);
  }).listen(path);
  const child = Bun.spawn(["bun", echoChild], {
    env: { ...process.env, MODE: "socket", SOCK: path },
    stdio: ["inherit", "inherit", "inherit"],
  });
  const sock = await connected.promise;
  await measure("process unix socket frames", () => {
    const p = new Promise((r) => {
      resolve = r;
    });
    sock.write(frame(op));
    return p;
  });
  child.kill();
  await child.exited;
  server.close();
}

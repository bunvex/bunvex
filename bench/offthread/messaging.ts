// STUDY-190 §4.0: what moving work to another thread costs the main thread, per message, in Bun.
//   bun bench/offthread/messaging.ts
// For each payload: a Worker that echoes what it gets, driven three ways:
//   - "rtt": one message in flight, so the round trip's latency;
//   - "pipelined": WINDOW messages in flight, so the main thread's cost per message when it is the bottleneck
//     (on Linux, the main thread's own CPU time per message too, from /proc/self/task/<pid>/stat);
//   - "sync": a SharedArrayBuffer and Atomics.wait / notify, the main thread blocked until the answer (what a
//     synchronous store call moved to a thread would cost).
// Payloads: a 100-byte string; a 3.5 KiB string (a 20-document query result as JSON text); the same 20 documents
// as objects (structured clone); 20 documents as one transferred ArrayBuffer of UTF-8.
// Env: N (messages per measurement, 50 000), WINDOW (64).
export {};

const N = Number(process.env.N ?? 50_000);
const WINDOW = Number(process.env.WINDOW ?? 64);

const doc = (i: number) => ({
  _id: `k57${String(i).padStart(29, "0")}`,
  _creationTime: 1761488000000 + i,
  tenantId: "t42",
  title: `item ${i} of tenant 42`,
  status: i % 3 ? "open" : "done",
  amount: 1234 + i,
  createdAt: 1761488000000 - i * 1000,
});
const docs = Array.from({ length: 20 }, (_, i) => doc(i));
const text = JSON.stringify(docs);
const payloads: Record<string, () => unknown> = {
  "string 100 B": () => "x".repeat(100),
  [`string ${(text.length / 1024).toFixed(1)} KiB`]: () => text,
  "20 objects (clone)": () => docs,
  "20 docs as bytes (transfer)": () => new TextEncoder().encode(text).buffer,
};

const workerSrc = `
let sab = null;
self.onmessage = (e) => {
  const m = e.data;
  if (m && m.sab) { sab = new Int32Array(m.sab); syncLoop(m.payload); return; }
  if (m instanceof ArrayBuffer) postMessage(m, [m]); else postMessage(m);
};
function syncLoop(n) {
  // Each round: wait for the main thread's request (state 1), answer (state 2).
  for (let i = 0; i < n; i++) {
    while (Atomics.load(sab, 0) !== 1) Atomics.wait(sab, 0, 0);
    Atomics.store(sab, 0, 2);
    Atomics.notify(sab, 0);
  }
}
`;
const url = URL.createObjectURL(new Blob([workerSrc], { type: "application/javascript" }));

/** The main thread's CPU time in ms (Linux), else null. */
function mainThreadCpuMs(): number | null {
  if (process.platform !== "linux") return null;
  const s = require("node:fs").readFileSync(`/proc/self/task/${process.pid}/stat`, "utf8") as string;
  const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
  return ((Number(f[11]) + Number(f[12])) * 1000) / 100;
}

async function measure(name: string, make: () => unknown) {
  const w = new Worker(url);
  // Warm up.
  await new Promise<void>((resolve) => {
    let n = 0;
    w.onmessage = () => (++n === 2000 ? resolve() : w.postMessage(make()));
    w.postMessage(make());
  });
  // Round trip, one in flight.
  const rttN = Math.min(N, 20_000);
  let t0 = performance.now();
  await new Promise<void>((resolve) => {
    let n = 0;
    w.onmessage = () => (++n === rttN ? resolve() : w.postMessage(make()));
    w.postMessage(make());
  });
  const rttUs = ((performance.now() - t0) * 1000) / rttN;
  // Pipelined: WINDOW in flight.
  const c0 = mainThreadCpuMs();
  t0 = performance.now();
  await new Promise<void>((resolve) => {
    let sent = 0;
    let got = 0;
    w.onmessage = () => {
      if (++got === N) return resolve();
      if (sent < N) {
        sent++;
        w.postMessage(make());
      }
    };
    for (; sent < WINDOW; sent++) w.postMessage(make());
  });
  const wall = performance.now() - t0;
  const c1 = mainThreadCpuMs();
  const perMsgUs = (wall * 1000) / N;
  const cpuPerMsg = c0 === null || c1 === null ? "—" : (((c1 - c0) * 1000) / N).toFixed(2);
  w.terminate();
  console.log(
    `| ${name} | ${rttUs.toFixed(1)} | ${perMsgUs.toFixed(2)} | ${(1e6 / perMsgUs / 1000).toFixed(0)}k | ${cpuPerMsg} |`,
  );
}

async function measureSync() {
  const w = new Worker(url);
  const sab = new SharedArrayBuffer(4);
  const a = new Int32Array(sab);
  const n = Math.min(N, 50_000);
  w.postMessage({ sab, payload: n + 1000 });
  const round = () => {
    Atomics.store(a, 0, 1);
    Atomics.notify(a, 0);
    while (Atomics.load(a, 0) !== 2) Atomics.wait(a, 0, 1);
    Atomics.store(a, 0, 0);
  };
  await Bun.sleep(50);
  for (let i = 0; i < 1000; i++) round();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) round();
  const us = ((performance.now() - t0) * 1000) / n;
  w.terminate();
  console.log(`| sync call (SharedArrayBuffer + Atomics.wait), no payload | ${us.toFixed(1)} | — | — | — |`);
}

console.log(`Bun ${Bun.version}, ${process.platform}/${process.arch}, N=${N}, WINDOW=${WINDOW}\n`);
console.log(
  "| payload | round trip, 1 in flight (µs) | per message, pipelined (µs) | messages/s | main thread CPU per message (µs, Linux) |",
);
console.log("|---|---:|---:|---:|---:|");
for (const [name, make] of Object.entries(payloads)) await measure(name, make);
await measureSync();
process.exit(0);

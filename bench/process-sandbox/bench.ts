// STUDY-168 measurements: today's executor (`vm`) against the sandboxed child (`process`: no OS sandbox, `bwrap`:
// bubblewrap + seccomp + cgroup), in one engine (memory persistence) called in-process, so the numbers are the
// executor's cost and not HTTP's.
//   bun bench/process-sandbox/bench.ts <vm|process|bwrap> [--quick]
// Prints JSON lines; results/ keeps the VPS runs.
import { readFileSync } from "node:fs";
import { type Mode, setup } from "./setup.ts";

const mode = (process.argv[2] ?? "vm") as Mode;
const quick = process.argv.includes("--quick");
const ITER = quick ? 200 : 3000;
const out = (o: Record<string, unknown>) => console.log(JSON.stringify({ mode, ...o }));
const round = (x: number) => +x.toFixed(3);

function pct(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
  return { mean: round(s.reduce((a, b) => a + b, 0) / s.length), p50: round(p(0.5)), p99: round(p(0.99)) };
}

/** Memory of the child's processes: RSS and PSS summed over its cgroup or its pid, in MiB. */
function childMemory(pid: number | undefined, cgroup: string | null) {
  const pids = cgroup
    ? readFileSync(`${cgroup}/cgroup.procs`, "utf8").split("\n").filter(Boolean).map(Number)
    : pid
      ? [pid]
      : [];
  let rss = 0;
  let pss = 0;
  for (const p of pids) {
    try {
      const t = readFileSync(`/proc/${p}/smaps_rollup`, "utf8");
      rss += Number(/^Rss:\s+(\d+)/m.exec(t)?.[1] ?? 0);
      pss += Number(/^Pss:\s+(\d+)/m.exec(t)?.[1] ?? 0);
    } catch {}
  }
  const cg = cgroup ? Number(readFileSync(`${cgroup}/memory.current`, "utf8")) / 2 ** 20 : null;
  return { rssMiB: round(rss / 1024), pssMiB: round(pss / 1024), cgroupMiB: cg === null ? null : round(cg), pids };
}
const hostMemory = () => ({ hostRssMiB: round(process.memoryUsage().rss / 2 ** 20) });

const memBefore = process.memoryUsage().rss;
const s = await setup(mode, { memoryMiB: Number(process.env.MEMORY_MIB ?? 128), pidsMax: 64 });
const { functions: f } = s;
out({
  phase: "load",
  spawnToReadyMs: s.spawnToReadyMs,
  hostRssDeltaMiB: round((process.memoryUsage().rss - memBefore) / 2 ** 20),
});
// Seeded in mutations of 1000 inserts: one of 10 000 takes over the 1 s budget in the sandbox (each insert is a
// round trip, counted as user time by the host's timer: see the study, §5).
const ids = (await f.runMutation("sb:seed", { tenants: 5, perTenant: 200, counters: 64 })) as string[];
for (let o = 5; o < 50; o += 5)
  await f.runMutation("sb:seed", { tenants: 5, perTenant: 200, counters: 0, tenantOffset: o });
await Bun.sleep(200);
if (s.dep && process.platform === "linux")
  out({ phase: "memory-idle", ...childMemory(s.dep.pid, s.dep.cgroupPath), ...hostMemory() });

let nonce = 0;
async function seq(name: string, run: () => Promise<unknown>) {
  for (let i = 0; i < Math.min(500, ITER); i++) await run();
  const samples: number[] = [];
  for (let i = 0; i < ITER; i++) {
    const t = performance.now();
    await run();
    samples.push((performance.now() - t) * 1000);
  }
  out({ phase: "latency", fn: name, unit: "us", n: ITER, ...pct(samples) });
}

await seq("empty query", () => f.runQuery("sb:empty", { nonce: ++nonce }));
for (const n of [1, 10, 100])
  await seq(`${n} x db.get`, () => f.runQuery("sb:getMany", { ids: ids.slice(0, n), nonce: ++nonce }));
for (const n of [1, 10, 100]) await seq(`page of ${n}`, () => f.runQuery("sb:page", { n, nonce: ++nonce }));
await seq("insert mutation", () => f.runMutation("sb:insertItem", { tenantId: `t${nonce++ % 50}` }));
await seq("increment mutation", () => f.runMutation("sb:increment", { key: `k${nonce++ % 64}` }));

// Throughput under concurrency: `c` callers in a loop for a fixed time, a page-of-20 query (convex-bench's
// listByTenant) and, separately, the insert mutation.
const SECONDS = quick ? 1 : 5;
for (const [label, run] of [
  ["listByTenant", () => f.runQuery("sb:listByTenant", { tenantId: `t${nonce % 50}`, nonce: ++nonce })],
  ["insertItem", () => f.runMutation("sb:insertItem", { tenantId: `t${nonce++ % 50}` })],
] as const) {
  for (const c of [1, 8, 32, 64]) {
    const samples: number[] = [];
    const end = performance.now() + SECONDS * 1000;
    let peak = { rssMiB: 0, pssMiB: 0, cgroupMiB: 0 as number | null };
    const sampler =
      s.dep && process.platform === "linux"
        ? setInterval(() => {
            const m = childMemory(s.dep?.pid, s.dep?.cgroupPath ?? null);
            if (m.rssMiB > peak.rssMiB) peak = m;
          }, 250)
        : null;
    await Promise.all(
      Array.from({ length: c }, async () => {
        while (performance.now() < end) {
          const t = performance.now();
          await run();
          samples.push(performance.now() - t);
        }
      }),
    );
    if (sampler) clearInterval(sampler);
    out({
      phase: "throughput",
      fn: label,
      concurrency: c,
      perSec: Math.round(samples.length / SECONDS),
      unit: "ms",
      ...pct(samples),
      ...(sampler ? { childPeak: { rssMiB: peak.rssMiB, pssMiB: peak.pssMiB, cgroupMiB: peak.cgroupMiB } } : {}),
      ...hostMemory(),
    });
  }
}
if (s.dep && process.platform === "linux")
  out({ phase: "memory-after-load", ...childMemory(s.dep.pid, s.dep.cgroupPath) });

// Push / hot swap (sandbox: a new child is started, then calls switch to it) and cold start.
if (s.dep) {
  const pushes: number[] = [];
  for (let i = 0; i < (quick ? 3 : 20); i++)
    pushes.push((await s.dep.push(s.dep ? `${import.meta.dir}/app/sb.ts` : "")).switchMs);
  out({ phase: "push", unit: "ms", n: pushes.length, ...pct(pushes) });
  await f.runQuery("sb:empty", { nonce: ++nonce });
  // First call after a push: the new child's first call (cold JIT).
  await s.dep.push(`${import.meta.dir}/app/sb.ts`);
  const t = performance.now();
  await f.runQuery("sb:listByTenant", { tenantId: "t1", nonce: ++nonce });
  out({ phase: "first-call-after-push", unit: "ms", ms: round(performance.now() - t) });
} else {
  const { CodeVersion } = await import("../../packages/server/src/code-version.ts");
  const { bundle } = await import("./setup.ts");
  const source = await bundle();
  const loads: number[] = [];
  for (let i = 0; i < (quick ? 3 : 20); i++) {
    const t = performance.now();
    await CodeVersion.load([{ path: "sb.js", source, environment: "isolate" }], {
      seed: Uint32Array.of(1, 2, 3, i),
      timestamp: Date.now(),
    });
    loads.push(performance.now() - t);
  }
  out({ phase: "push", unit: "ms", n: loads.length, note: "CodeVersion.load of the bundled module", ...pct(loads) });
}

// Kills: an infinite loop (user timeout) and an allocating loop (memory cap), then a normal call on the same
// deployment. Only in a sandbox: in `vm` the loop never ends and takes the server with it (DV-208).
if (s.dep) {
  for (let i = 0; i < (quick ? 1 : 5); i++) {
    const t = performance.now();
    const err = await f.runQuery("sb:spin", {}).then(
      () => "returned",
      (e) => (e as Error).message,
    );
    const failedAfter = performance.now() - t;
    const t2 = performance.now();
    await f.runQuery("sb:empty", { nonce: ++nonce });
    const k = s.dep.lastKill;
    out({
      phase: "kill-loop",
      error: err.split("\n")[0],
      failedAfterMs: round(failedAfter),
      killToExitMs: k?.exitedAt ? round(k.exitedAt - k.firedAt) : null,
      killToReadyMs: k?.respawnedAt ? round(k.respawnedAt - k.firedAt) : null,
      nextCallMs: round(performance.now() - t2),
    });
  }
  if (process.platform === "linux" && mode === "bwrap")
    for (let i = 0; i < (quick ? 1 : 3); i++) {
      const t = performance.now();
      const err = await f.runQuery("sb:allocate", {}).then(
        () => "returned",
        (e) => (e as Error).message,
      );
      const failedAfter = performance.now() - t;
      const t2 = performance.now();
      const ok = await f.runQuery("sb:empty", { nonce: ++nonce });
      out({
        phase: "kill-oom",
        error: err.split("\n")[0],
        failedAfterMs: round(failedAfter),
        nextCallOk: ok === null,
        nextCallMs: round(performance.now() - t2),
      });
    }
}
await s.close();
process.exit(0);

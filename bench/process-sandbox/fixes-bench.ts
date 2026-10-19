// STUDY-168 round 2: the first round's fixes, measured (study §10), and the noisy-neighbour check (§11).
//   bun bench/process-sandbox/fixes-bench.ts <part> [mode]     part: usertime | pool | affinity | batch | neighbour
// mode: bwrap (default, Linux as root) or process. Prints JSON lines.
import { readFileSync } from "node:fs";
import { setup } from "./setup.ts";

const part = process.argv[2] ?? "usertime";
const mode = (process.argv[3] ?? "bwrap") as "bwrap" | "process";
const out = (o: Record<string, unknown>) => console.log(JSON.stringify({ part, mode, ...o }));
const r = (x: number) => +x.toFixed(1);
function pct(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
  return { p50: r(p(0.5)), p99: r(p(0.99)), mean: r(s.reduce((a, b) => a + b, 0) / s.length) };
}
async function seeded(m: "vm" | "bwrap" | "process", opts: Parameters<typeof setup>[1] = {}) {
  const s = await setup(m, { memoryMiB: 128, ...opts });
  const ids = (await s.functions.runMutation("sb:seed", { tenants: 5, perTenant: 200, counters: 64 })) as string[];
  return { s, ids };
}
async function latency(run: () => Promise<unknown>, n = 2000) {
  for (let i = 0; i < 300; i++) await run();
  const t: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = performance.now();
    await run();
    t.push((performance.now() - a) * 1000);
  }
  return pct(t);
}
async function throughput(run: () => Promise<unknown>, c: number, seconds = 5) {
  const t: number[] = [];
  let failed = 0;
  const end = performance.now() + seconds * 1000;
  await Promise.all(
    Array.from({ length: c }, async () => {
      while (performance.now() < end) {
        const a = performance.now();
        await run().catch(() => failed++);
        t.push(performance.now() - a);
      }
    }),
  );
  return { perSec: Math.round(t.length / seconds), failed, ...pct(t) };
}
/** cgroup memory.current summed over the children (bwrap's pid is the wrapper's, so PSS is not measured here). */
function memory(children: { pid: number; cgroup: string | null }[]) {
  let cg = 0;
  for (const c of children) if (c.cgroup) cg += Number(readFileSync(`${c.cgroup}/memory.current`, "utf8")) / 2 ** 20;
  return { children: children.length, cgroupMiB: r(cg) };
}
let nonce = 0;

if (part === "usertime") {
  // The largest mutation of sequential inserts that fits in the 1 s budget, by who measures user time.
  for (const [label, m, accounting] of [
    ["vm", "vm", undefined],
    ["host accounting (round 1)", mode, "host"],
    ["child accounting", mode, "child"],
  ] as const) {
    for (const n of [1000, 2000, 5000, 10_000, 15_000]) {
      const s = await setup(m, { memoryMiB: 256, ...(accounting ? { accounting } : {}) });
      const t = performance.now();
      const result = await s.functions
        .runMutation("sb:insertMany", { n })
        .then(() => "ok")
        .catch((e) => String((e as Error).message).slice(0, 60));
      out({ variant: label, inserts: n, result, wallMs: r(performance.now() - t) });
      await s.close();
    }
  }
}

if (part === "pool") {
  for (const poolSize of [0, 1, 2, 4]) {
    const { s } = await seeded(mode, { poolSize });
    await Bun.sleep(300);
    const idle = memory(s.dep?.children ?? []);
    const q = () => s.functions.runQuery("sb:listByTenant", { tenantId: `t${nonce % 5}`, nonce: ++nonce });
    const seq = await latency(q, 1000);
    const rows: Record<string, unknown> = {};
    for (const c of [8, 32]) rows[`c${c}`] = await throughput(q, c);
    const busy = memory(s.dep?.children ?? []);
    // The blast radius of a timeout: 16 callers of a small query while one call spins.
    const spin = s.functions.runQuery("sb:spin", {}).catch(() => "timeout");
    const around = await throughput(q, 16, 2);
    await spin;
    out({ variant: `pool ${poolSize}`, idle, busy, seqUs: seq, ...rows, duringSpin: around });
    await s.close();
  }
}

if (part === "affinity") {
  // Host main thread and child: unpinned, on one CPU, or on two different pinned CPUs (`taskset`).
  const pinHost = (cpu: string | null) =>
    Bun.spawnSync(["taskset", "-p", "-c", cpu ?? "0-1023", String(process.pid)], { stdout: "ignore" });
  for (const [label, hostCpu, childCpu] of [
    ["unpinned", null, ""],
    ["same CPU", "0", "0"],
    ["different CPUs", "0", "1"],
  ] as const) {
    pinHost(hostCpu);
    const { s, ids } = await seeded(mode, { cpuList: childCpu });
    const res: Record<string, unknown> = {};
    res.empty = await latency(() => s.functions.runQuery("sb:empty", { nonce: ++nonce }));
    for (const n of [1, 10])
      res[`get${n}`] = await latency(() =>
        s.functions.runQuery("sb:getMany", { ids: ids.slice(0, n), nonce: ++nonce }),
      );
    res.insert = await latency(() => s.functions.runMutation("sb:insertItem", { tenantId: `t${nonce++ % 5}` }));
    res.list8 = await throughput(
      () => s.functions.runQuery("sb:listByTenant", { tenantId: `t${nonce % 5}`, nonce: ++nonce }),
      8,
    );
    out({ variant: label, ...res });
    await s.close();
    pinHost(null);
  }
}

if (part === "batch") {
  for (const [label, m, batchOps] of [
    ["vm", "vm", false],
    ["unbatched", mode, false],
    ["batched", mode, true],
  ] as const) {
    const { s, ids } = await seeded(m, { batchOps });
    const res: Record<string, unknown> = {};
    for (const n of [10, 100])
      res[`parallel${n}`] = await latency(
        () => s.functions.runQuery("sb:getManyParallel", { ids: ids.slice(0, n), nonce: ++nonce }),
        500,
      );
    res.sequential10 = await latency(
      () => s.functions.runQuery("sb:getMany", { ids: ids.slice(0, 10), nonce: ++nonce }),
      500,
    );
    res.list8 = await throughput(
      () => s.functions.runQuery("sb:listByTenant", { tenantId: `t${nonce % 5}`, nonce: ++nonce }),
      8,
    );
    out({ variant: label, ...res });
    await s.close();
  }
}

if (part === "neighbour") {
  // Two deployments on one host. B serves small queries from one caller; A burns CPU from 4 callers in a pool of 2
  // one-call processes (so it can take both vCPUs). B alone, next to an unlimited A, and next to an A whose
  // deployment cgroup has cpu.max (shared by its pool).
  for (const [label, aCpus] of [
    ["B alone", null],
    ["A unlimited", 2],
    ["A cpu.max 1 CPU", 1],
    ["A cpu.max 0.5 CPU", 0.5],
  ] as const) {
    const b = await seeded(mode, { cpus: 2 });
    const a =
      aCpus === null ? null : await setup(mode, { memoryMiB: 128, cpus: aCpus, poolSize: 2, userTimeoutMs: 30_000 });
    let stop = false;
    let burned = 0;
    const burners = a
      ? Array.from({ length: 4 }, async () => {
          while (!stop) {
            await a.functions.runQuery("sb:burn", { iters: 1e7, nonce: ++nonce }).catch(() => {});
            burned++;
          }
        })
      : [];
    await Bun.sleep(500);
    const res = await throughput(
      () => b.s.functions.runQuery("sb:listByTenant", { tenantId: `t${nonce % 5}`, nonce: ++nonce }),
      1,
      5,
    );
    stop = true;
    await Promise.all(burners);
    out({ variant: label, b: res, aBurnsPerSec: Math.round(burned / 5.5) });
    await b.s.close();
    await a?.close();
  }
}
process.exit(0);

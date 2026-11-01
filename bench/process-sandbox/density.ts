// STUDY-168: how many idle sandboxed deployments fit in memory. Starts N children (bwrap + cgroup) at once, calls
// each once, and reads the machine's MemAvailable before and after, and each child's PSS (Linux, root).
//   bun bench/process-sandbox/density.ts [N]
import { readFileSync } from "node:fs";
import { Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { Functions } from "@bunvex/server";
import { benchSchema } from "../functions.ts";
import { SandboxedDeployment } from "./host.ts";
import { APP } from "./setup.ts";

const N = Number(process.argv[2] ?? 50);
const available = () => Number(/MemAvailable:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"))?.[1]) / 1024;
const pss = (pid: number) => {
  try {
    return Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"))?.[1] ?? 0) / 1024;
  } catch {
    return 0;
  }
};

const engine = await new Engine(benchSchema, await MemoryPersistence.open(null, { durable: false })).init();
await Bun.sleep(500);
const before = available();
const t = performance.now();
const deps = Array.from(
  { length: N },
  (_, i) => new SandboxedDeployment({ app: APP, sandbox: "bwrap", name: `density${i}` }),
);
const started = await Promise.all(deps.map((d) => d.start()));
const allReadyMs = performance.now() - t;
// One call each, so every child has run app code (JIT, its first ops).
const functions = deps.map((d, i) => new Functions(engine).register("sb", d.stubs(started[i]!.functions).sb as never));
await Promise.all(functions.map((f) => f.runQuery("sb:page", { n: 20, nonce: 1 })));
await Bun.sleep(1000);
const after = available();
let totalPss = 0;
let totalCgroup = 0;
for (const d of deps) {
  const cg = d.cgroupPath as string;
  for (const pid of readFileSync(`${cg}/cgroup.procs`, "utf8").split("\n").filter(Boolean))
    totalPss += pss(Number(pid));
  totalCgroup += Number(readFileSync(`${cg}/memory.current`, "utf8")) / 2 ** 20;
}
const perChildMiB = (before - after) / N;
console.log(
  JSON.stringify({
    phase: "density",
    n: N,
    allReadyMs: +allReadyMs.toFixed(1),
    spawnToReadyMs: {
      min: +Math.min(...started.map((s) => s.spawnToReadyMs)).toFixed(1),
      max: +Math.max(...started.map((s) => s.spawnToReadyMs)).toFixed(1),
    },
    memAvailableDropMiB: +(before - after).toFixed(1),
    perChildMiB: +perChildMiB.toFixed(2),
    perChildPssMiB: +(totalPss / N).toFixed(2),
    perChildCgroupMiB: +(totalCgroup / N).toFixed(2),
    childrenPerGiB: Math.floor(1024 / perChildMiB),
  }),
);
await Promise.all(deps.map((d) => d.stop()));
process.exit(0);

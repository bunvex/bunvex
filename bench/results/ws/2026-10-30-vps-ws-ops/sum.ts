// Summarises results.jsonl (the rows drive.ts wrote): per scenario and connection count, the median over the repeats
// of each product's operations per second, latency and CPU.
//   bun bench/results/ws/2026-10-30-vps-ws-ops/sum.ts
type Row = {
  label: string;
  scenario: string;
  conns: number;
  opsPerSec: number;
  p50: number;
  p99: number;
  serverCores: number;
  boxCores: number;
  maxWorkerCores: number;
  closed: number;
  errors: number;
  failed?: string;
  updatesPerSec?: number;
  updateP50?: number;
  updateP99?: number;
};
const rows = (await Bun.file(`${import.meta.dir}/results.jsonl`).text())
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as Row);
console.log(
  `failed: ${rows.filter((r) => r.failed).length}, with closed connections: ${rows.filter((r) => r.closed > 0).length}, ` +
    `with errors: ${rows.filter((r) => r.errors > 0).length}`,
);
const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const key = (r: Row) => `${r.scenario}|${r.conns}`;
const cell = (k: string, label: string) => {
  const g = rows.filter((r) => key(r) === k && r.label === label);
  if (g.length === 0) return null;
  const m = (f: (r: Row) => number | undefined) => median(g.map(f).filter((x): x is number => x !== undefined));
  return {
    ops: m((r) => r.opsPerSec),
    min: Math.min(...g.map((r) => r.opsPerSec)),
    max: Math.max(...g.map((r) => r.opsPerSec)),
    p50: m((r) => r.p50),
    p99: m((r) => r.p99),
    server: m((r) => r.serverCores),
    box: m((r) => r.boxCores),
    gen: m((r) => r.maxWorkerCores),
    updates: g[0]!.updatesPerSec === undefined ? undefined : m((r) => r.updatesPerSec),
    updateP50: g[0]!.updateP50 === undefined ? undefined : m((r) => r.updateP50),
    updateP99: g[0]!.updateP99 === undefined ? undefined : m((r) => r.updateP99),
  };
};
type Cell = NonNullable<ReturnType<typeof cell>>;
const fmt = (x: Cell | null) =>
  x &&
  `${x.ops}/s (${x.min}-${x.max}) p50 ${x.p50} p99 ${x.p99} server ${x.server} box ${x.box} generator ${x.gen}` +
    (x.updates === undefined ? "" : ` | updates ${x.updates}/s p50 ${x.updateP50} p99 ${x.updateP99}`);
for (const k of [...new Set(rows.map(key))]) {
  const convex = cell(k, "convex");
  const bunvex = cell(k, "bunvex");
  const [scenario, conns] = k.split("|");
  const ratio = convex && bunvex ? `${(bunvex.ops / convex.ops).toFixed(2)}x` : "–";
  console.log(`${scenario} c=${conns}  bunvex/convex ${ratio}\n  convex ${fmt(convex)}\n  bunvex ${fmt(bunvex)}`);
}

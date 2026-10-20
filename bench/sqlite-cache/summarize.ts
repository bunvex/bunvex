// STUDY-174 Q6: the table of ./bench.ts's results. Each row is one store, mode and cache, with each repetition's
// value and their mean; a second table compares SQLite's default against 256 MiB.
//
//   bun bench/sqlite-cache/summarize.ts bench/sqlite-cache/results/*.json.gz
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

type Stat = { count: number; perSecond: number; p50: number; p95: number; p99: number };
type Result = {
  label: string;
  cache: string;
  mode: string;
  docs: number;
  storeBytes: number;
  memoryMax: string | null;
  warmupSeconds: number;
  all: Stat;
  ops: Record<string, Stat>;
  errors: number;
  memory: { rssEnd: number; rssMax: number; cgroupEnd: { current: number; anon: number; file: number } };
  io: { majorFaults: number; diskReadBytes: number; readSyscallBytes: number; cpuSeconds: number };
  otherBackends?: { atStart: number[]; atEnd: number[] };
};

const results = process.argv.slice(2).map((f) => {
  const buf = readFileSync(f);
  return JSON.parse((f.endsWith(".gz") ? gunzipSync(buf) : buf).toString("utf8")) as Result;
});
const MB = 2 ** 20;
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const store = (r: Result) => (r.docs >= 1_000_000 ? "big" : "small");
const groups = new Map<string, Result[]>();
for (const r of results) {
  const k = `${store(r)} ${r.mode}-w${r.warmupSeconds} ${r.cache}`;
  groups.set(k, [...(groups.get(k) ?? []), r]);
}
const fmt = (a: number[], digits = 1) =>
  `${a.map((x) => x.toFixed(digits)).join(" / ")} (**${mean(a).toFixed(digits)}**)`;
const metrics: [string, (r: Result) => number, number][] = [
  ["calls/s", (r) => r.all.perSecond, 0],
  ["p50 ms", (r) => r.all.p50, 2],
  ["p95 ms", (r) => r.all.p95, 2],
  ["p99 ms", (r) => r.all.p99, 2],
  ["get p99", (r) => r.ops.get!.p99, 2],
  ["range p99", (r) => r.ops.range!.p99, 2],
  ["page p99", (r) => r.ops.page!.p99, 2],
  ["RSS MB", (r) => r.memory.rssEnd / MB, 0],
  ["disk read MB", (r) => r.io.diskReadBytes / MB, 0],
  ["CPU s", (r) => r.io.cpuSeconds, 0],
];
console.log(`| store | mode | cache | ${metrics.map((m) => m[0]).join(" | ")} |`);
console.log(`|${"---|".repeat(3 + metrics.length)}`);
const keys = [...groups.keys()].sort();
for (const k of keys) {
  const rs = groups.get(k)!;
  const [s, mode, cache] = k.split(" ");
  console.log(
    `| ${s} | ${mode} | ${cache === "default" ? "default (2 000 KiB)" : "256 MiB"} | ${metrics.map(([, f, d]) => fmt(rs.map(f), d)).join(" | ")} |`,
  );
}
console.log(
  "\nThe default against 256 MiB, means of the repetitions (calls/s: negative is fewer with the default; latency: positive is slower with the default; RSS: the default minus 256 MiB):\n",
);
console.log("| store | mode | calls/s | p50 | p95 | p99 | RSS |");
console.log("|---|---|---|---|---|---|---|");
const pct = (a: number, b: number) => `${(((a - b) / b) * 100).toFixed(1)} %`;
for (const k of keys.filter((k) => k.endsWith(" default"))) {
  const d = groups.get(k)!;
  const b = groups.get(k.replace(/ default$/, " 262144"));
  if (!b) continue;
  const m = (rs: Result[], f: (r: Result) => number) => mean(rs.map(f));
  const [s, mode] = k.split(" ");
  console.log(
    `| ${s} | ${mode} | ${pct(
      m(d, (r) => r.all.perSecond),
      m(b, (r) => r.all.perSecond),
    )} | ${pct(
      m(d, (r) => r.all.p50),
      m(b, (r) => r.all.p50),
    )} | ${pct(
      m(d, (r) => r.all.p95),
      m(b, (r) => r.all.p95),
    )} | ${pct(
      m(d, (r) => r.all.p99),
      m(b, (r) => r.all.p99),
    )} | ${(m(d, (r) => r.memory.rssEnd) / MB - m(b, (r) => r.memory.rssEnd) / MB).toFixed(0)} MB |`,
  );
}
const dirty = results.filter((r) => r.errors || r.otherBackends?.atStart.length || r.otherBackends?.atEnd.length);
if (dirty.length)
  console.log(`\nRuns with errors or another backend running: ${dirty.map((r) => `${r.label} ${r.cache}`).join(", ")}`);

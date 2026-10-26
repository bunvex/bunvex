// STUDY-190: profile.ts summaries side by side, the median of each point's runs.
//   bun bench/offthread/table.ts <dir> [<dir> …]     (each a profile.ts OUT holding summary.md)
import { existsSync, readFileSync } from "node:fs";

type Row = { rps: number; p99: number; cores: number; threads: string };
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

console.log("| run | point | runs | req/s (median) | each | p99 ms | server cores | threads (cores) |");
console.log("|---|---|---:|---:|---|---:|---:|---|");
for (const dir of process.argv.slice(2)) {
  const f = `${dir}/summary.md`;
  if (!existsSync(f)) continue;
  const points = new Map<string, Row[]>();
  let tag = "";
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const h = line.match(/^## (.*?)(-r\d+)?$/);
    if (h) tag = h[1]!;
    const m = line.match(/^(\d+) req\/s, p99 ([\d.]+) ms, .*server ([\d.]+) cores(?: \((.*)\))?/);
    if (m && tag) {
      if (!points.has(tag)) points.set(tag, []);
      points.get(tag)!.push({ rps: Number(m[1]), p99: Number(m[2]), cores: Number(m[3]), threads: m[4] ?? "" });
    }
  }
  for (const [p, rows] of points) {
    const mid = rows.slice().sort((a, b) => a.rps - b.rps)[Math.floor((rows.length - 1) / 2)]!;
    console.log(
      `| ${dir.split("/").pop()} | ${p} | ${rows.length} | ${median(rows.map((r) => r.rps)).toFixed(0)} | ` +
        `${rows.map((r) => r.rps).join(", ")} | ${median(rows.map((r) => r.p99)).toFixed(1)} | ` +
        `${median(rows.map((r) => r.cores)).toFixed(2)} | ${mid.threads} |`,
    );
  }
}

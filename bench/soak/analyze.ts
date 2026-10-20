// The soak's memory analysis (STUDY-174 F6): from a soak's report.json and its backend's probe.jsonl, the Theil–Sen slope
// (MB/min) of every memory series over a window, and the object types whose counts grew the most.
//
//   bun bench/soak/analyze.ts <out dir> [from-minute] [to-minute]
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [dir, fromArg, toArg] = process.argv.slice(2);
if (!dir) throw new Error("usage: analyze.ts <out dir> [from-minute] [to-minute]");
const from = Number(fromArg ?? 10) * 60;
const to = Number(toArg ?? Number.POSITIVE_INFINITY) * 60;
const MB = 2 ** 20;
/** A file of the run, or its gzipped copy (`<name>.gz`, as bench/soak/results keeps them). */
const read = (name: string) =>
  existsSync(join(dir, name))
    ? readFileSync(join(dir, name), "utf8")
    : new TextDecoder().decode(Bun.gunzipSync(readFileSync(join(dir, `${name}.gz`))));

/** The median of pairwise slopes, per minute. */
function theilSen(pts: [number, number][]): number {
  const s: number[] = [];
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++)
      if (pts[j]![0] !== pts[i]![0]) s.push((pts[j]![1] - pts[i]![1]) / (pts[j]![0] - pts[i]![0]));
  s.sort((a, b) => a - b);
  return (s[Math.floor(s.length / 2)] ?? 0) * 60;
}

type Probe = {
  t: number;
  gc: boolean;
  mu: Record<string, number>;
  hs: Record<string, number> & { objectTypeCounts: Record<string, number> };
  footprint: number | null;
  smaps: Record<string, number> | null;
};
const probes = read("probe.jsonl")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as Probe)
  .filter((p) => p.t >= from && p.t <= to);
let report: { samples: { t: number; detail?: { dbBytes: number; walBytes: number } }[] } | null = null;
try {
  report = JSON.parse(read("report.json"));
} catch {}

const series: Record<string, [number, number][]> = {};
const add = (k: string, t: number, v: number | null | undefined) => {
  if (v == null || Number.isNaN(v)) return;
  const pts = series[k] ?? [];
  pts.push([t, v]);
  series[k] = pts;
};
for (const p of probes) {
  add("anonymous", p.t, p.smaps?.Anonymous);
  add("rss", p.t, p.smaps?.Rss ?? p.mu.rss);
  add("file-backed", p.t, p.smaps ? p.smaps.Rss! - p.smaps.Anonymous! : null);
  add("heapUsed", p.t, p.mu.heapUsed);
  add("heapCapacity", p.t, p.hs.heapCapacity);
  add("external", p.t, p.mu.external);
  add("arrayBuffers", p.t, p.mu.arrayBuffers);
  add("footprint", p.t, p.footprint);
  if (p.gc) add("anonymous after GC", p.t, p.smaps?.Anonymous);
}
// The driver's samples lag the probe's clock by the start-up (a few seconds): close enough for a slope.
for (const s of report?.samples ?? [])
  if (s.t >= from && s.t <= to && s.detail) {
    add("sqlite db file", s.t, s.detail.dbBytes);
    add("sqlite wal", s.t, s.detail.walBytes);
  }

// Object counts compare samples taken right after a forced GC when there are some: the others carry garbage.
const gcs = probes.filter((p) => p.gc);
const first = gcs.length >= 2 ? gcs[0] : probes[0];
const last = gcs.length >= 2 ? gcs[gcs.length - 1] : probes[probes.length - 1];
console.log(
  `${dir}: ${probes.length} probe samples, t=${probes[0]?.t.toFixed(0)}–${probes[probes.length - 1]?.t.toFixed(0)} s`,
);
console.log("| series | first MB | last MB | slope MB/min |\n|---|---|---|---|");
for (const [k, pts] of Object.entries(series))
  console.log(
    `| ${k} | ${(pts[0]![1] / MB).toFixed(1)} | ${(pts[pts.length - 1]![1] / MB).toFixed(1)} | ${(theilSen(pts) / MB).toFixed(2)} |`,
  );
if (first && last) {
  const a = first.hs.objectTypeCounts;
  const b = last.hs.objectTypeCounts;
  const grew = Object.keys({ ...a, ...b })
    .map((k) => [k, (b[k] ?? 0) - (a[k] ?? 0), b[k] ?? 0] as const)
    .sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))
    .slice(0, 12);
  console.log(
    `\nobject types, biggest change over the window: ${grew.map(([k, d, n]) => `${k} ${d >= 0 ? "+" : ""}${d} (${n})`).join(", ")}`,
  );
}

// mimalloc's dumps in the backend's stderr (`<out>.mimalloc` triggers): the size classes whose live bytes changed
// most between the first and the last dump. SQLite's page cache shows as the 5 KiB class (a 4 KiB page and its
// header), JSC's 16 KiB blocks as the 16 KiB one.
const UNIT: Record<string, number> = { B: 1, KiB: 2 ** 10, MiB: 2 ** 20, GiB: 2 ** 30 };
const dumps: { t: string; bins: Map<string, number> }[] = [];
const blocks = new Map<string, number>();
try {
  for (const line of read("backend.stderr").split("\n")) {
    const head = /^---- mimalloc at t=([\d.]+)s/.exec(line);
    if (head) dumps.push({ t: head[1]!, bins: new Map() });
    // "  bin S   33  :   103.7 MiB   672.4 MiB   103.5 MiB     5.0 KiB   137.7 K ...": peak, total, current, block.
    const bin = /^\s+(bin \w\s+\d+|huge)\s+:(.*)$/.exec(line);
    if (bin && dumps.length) {
      const sizes = [...bin[2]!.matchAll(/([\d.]+)(?: (B|KiB|MiB|GiB)\b)?/g)].map(
        (m) => Number(m[1]) * (UNIT[m[2] ?? "B"] ?? 1),
      );
      const label = bin[1]!.replace(/\s+/g, " ");
      if (label !== "huge" && sizes[3] !== undefined) blocks.set(label, sizes[3]);
      dumps[dumps.length - 1]!.bins.set(label, sizes[2] ?? 0);
    }
  }
} catch {}
if (dumps.length >= 2) {
  const a = dumps[0]!;
  const b = dumps[dumps.length - 1]!;
  const changed = [...b.bins]
    .map(([k, v]) => [k, v - (a.bins.get(k) ?? 0), v] as const)
    .sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))
    .slice(0, 6);
  console.log(
    `\nmimalloc, live bytes from t=${a.t}s to t=${b.t}s: ${changed.map(([k, d, v]) => `${k}${blocks.has(k) ? ` (${(blocks.get(k)! / 1024).toFixed(1)} KiB blocks)` : ""} ${d >= 0 ? "+" : ""}${(d / MB).toFixed(1)} MB (${(v / MB).toFixed(1)})`).join(", ")}`,
  );
}

// The function sandbox child's costs (STUDY-171 §7.5): spawn to hello, and a push's analysis in a child against
// `CodeVersion.load` in-process, on the parity corpus's example apps. Short: about 20 s.
//
//   bun packages/sandbox/bench/startup.ts [children=20] [rounds=10]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CodeVersion, type ModuleSource } from "@bunvex/server/executor";
import { SandboxProcess } from "../src/index.ts";

const CHILDREN = Number(process.argv[2] ?? 20);
const ROUNDS = Number(process.argv[3] ?? 10);
const corpus = JSON.parse(
  new TextDecoder().decode(
    Bun.gunzipSync(readFileSync(join(import.meta.dir, "../test/fixtures/parity-corpus.json.gz"))),
  ),
) as { suite: string; kind: string; sources?: ModuleSource[] }[];
const apps = corpus.filter((e) => e.suite.startsWith("examples/") && e.kind === "load");
const opts = { seed: new Uint32Array([1, 2, 3, 4]), timestamp: 1_760_000_000_000 };
const q = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;
const fmt = (xs: number[]) => `p50 ${q(xs, 0.5).toFixed(1)} ms, p90 ${q(xs, 0.9).toFixed(1)} ms`;
const rssMiB = (pid: number) =>
  Number(new TextDecoder().decode(Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)]).stdout).trim()) / 1024;

// Spawn to hello, and the first load in a fresh child (cold: the loader's own code not yet compiled).
const ready: number[] = [];
const firstLoad: number[] = [];
const idle: number[] = [];
const loaded: number[] = [];
const big = apps.reduce((a, b) => (a.sources!.length >= b.sources!.length ? a : b));
for (let i = 0; i < CHILDREN; i++) {
  const c = await SandboxProcess.start();
  ready.push(c.spawnToReadyMs);
  idle.push(rssMiB(c.pid));
  const t = performance.now();
  await c.load(big.sources!, opts);
  firstLoad.push(performance.now() - t);
  loaded.push(rssMiB(c.pid));
  await c.close();
}
console.log(`spawn to hello (${CHILDREN} children): ${fmt(ready)}`);
console.log(`first load in a fresh child (${big.suite}, ${big.sources!.length} modules): ${fmt(firstLoad)}`);
console.log(
  `child RSS: idle ${fmt(idle).replaceAll(" ms", " MiB")}; after the load ${fmt(loaded).replaceAll(" ms", " MiB")}`,
);

// Warm: each app's analysis, in-process and in one child (round trip on the host's clock, and the child's own).
const c = await SandboxProcess.start();
for (const e of apps) await c.load(e.sources!, opts);
const rows: string[] = [];
const all = { here: [] as number[], there: [] as number[], own: [] as number[] };
for (const e of apps) {
  const here: number[] = [];
  const there: number[] = [];
  const own: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    let t = performance.now();
    await CodeVersion.load(e.sources!, opts);
    here.push(performance.now() - t);
    t = performance.now();
    const v = await c.load(e.sources!, opts);
    there.push(performance.now() - t);
    own.push(v.loadMs);
  }
  all.here.push(...here);
  all.there.push(...there);
  all.own.push(...own);
  rows.push(
    `| ${e.suite.slice(9)} | ${e.sources!.length} | ${q(here, 0.5).toFixed(2)} | ${q(there, 0.5).toFixed(2)} | ${q(own, 0.5).toFixed(2)} |`,
  );
}
await c.close();
console.log("| App | Modules | In-process p50 (ms) | Child, round trip p50 | Child, its own p50 |");
console.log("|---|---|---|---|---|");
for (const r of rows) console.log(r);
console.log(`all apps: in-process ${fmt(all.here)}; child round trip ${fmt(all.there)}; child's own ${fmt(all.own)}`);

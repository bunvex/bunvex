// The HTTP suite: one server per storage, the seed, then each scenario at each VU level.
// Prints the best req/s of the VU levels, the same shape as the Mac and VPS tables.
//   bun bench/load/run.ts
// Env: STORES (memory sqlite postgres mysql), VUS (8 32 128), DURATION (10s), SCENARIOS,
//      PORT, DATA, PG_URL, MYSQL_URL, PSQL, MYSQL.
// Postgres and MySQL must already be listening (scripts/mac-stores.sh start). The 4 MiB/s write cap
// stays off unless MAX_BYTES_WRITTEN_PER_SECOND is set. Fan-out is not this suite.
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { bestPoint, markdownTable, type Point, pointFromSummary, type SummaryExport, scenarioLabel } from "./report.ts";

const root = `${import.meta.dir}/../..`;
const dataDir = process.env.DATA ?? `${root}/.data`;
const port = Number(process.env.PORT ?? 3210);
const base = process.env.BENCH_URL ?? `http://127.0.0.1:${port}`;
const duration = process.env.DURATION ?? "10s";
const words = (value: string | undefined, fallback: string) => (value ?? fallback).split(/[,\s]+/).filter(Boolean);

const stores = words(process.env.STORES, "memory sqlite postgres mysql");
const vuLevels = words(process.env.VUS, "8 32 128").map(Number);
const scenarioIds = words(process.env.SCENARIOS, "cached uncached insert increment1000 increment1 action mix");
const k6Path = Bun.which("k6");
if (k6Path === null) throw new Error("k6 is not on PATH");
const k6: string = k6Path;
for (const id of scenarioIds) scenarioLabel(id);
if (vuLevels.some((n) => !Number.isInteger(n) || n < 1)) throw new Error(`bad VUS=${process.env.VUS}`);

const urls: Record<string, string | undefined> = {
  memory: undefined,
  sqlite: undefined,
  postgres: process.env.PG_URL ?? `postgres://${process.env.USER ?? "postgres"}@127.0.0.1:5434/bunvex`,
  mysql: process.env.MYSQL_URL ?? "mysql://root@127.0.0.1:3307/bunvex",
};

function databaseName(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*\/([^?#]*)/i.exec(url);
  const name = match?.[1] ? decodeURIComponent(match[1]) : "bunvex";
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`unsupported database name ${name}`);
  return name;
}

async function command(cmd: string[], env?: Record<string, string>, cwd = root): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd[0]} exited ${code}\n${err || out}`.trim());
}

function wipeLocalFiles(): void {
  mkdirSync(dataDir, { recursive: true });
  rmSync(`${dataDir}/bunvex.log`, { force: true });
  for (const name of readdirSync(dataDir))
    if (name.startsWith("bunvex.sqlite")) rmSync(`${dataDir}/${name}`, { force: true });
}

async function freshDatabase(store: string): Promise<void> {
  wipeLocalFiles();
  const url = urls[store];
  if (url === undefined && !(store in urls)) throw new Error(`unknown storage ${store}`);
  if (store === "postgres" && url) {
    const db = databaseName(url);
    const psql = process.env.PSQL ?? "/opt/homebrew/opt/postgresql@17/bin/psql";
    await command([
      psql,
      "-h",
      "127.0.0.1",
      "-p",
      "5434",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid()`,
      "-c",
      `DROP DATABASE IF EXISTS ${db}`,
      "-c",
      `CREATE DATABASE ${db}`,
    ]);
  }
  if (store === "mysql" && url) {
    const db = databaseName(url);
    const mysql = process.env.MYSQL ?? "/opt/homebrew/opt/mysql@8.4/bin/mysql";
    await command([
      mysql,
      "-h127.0.0.1",
      "-P3307",
      "-uroot",
      "-e",
      `DROP DATABASE IF EXISTS ${db}; CREATE DATABASE ${db}`,
    ]);
  }
}

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return { ...env, ...extra };
}

function serverEnv(store: string): Record<string, string> {
  const env = childEnv();
  env.PERSISTENCE = store;
  env.DATA = dataDir;
  env.PORT = String(port);
  env.DO_NOT_REQUIRE_SSL ||= "1";
  const url = urls[store];
  if (url) env.PERSISTENCE_URL = url;
  else delete env.PERSISTENCE_URL;
  return env;
}

async function portBusy(): Promise<boolean> {
  try {
    await fetch(`${base}/version`, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

async function serverLog(logPath: string): Promise<string> {
  const out = await Bun.file(logPath)
    .text()
    .catch(() => "");
  const err = await Bun.file(`${logPath}.err`)
    .text()
    .catch(() => "");
  return `${out}\n${err}`.slice(-2000);
}

async function waitReady(proc: Bun.Subprocess, logPath: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let code: number | null = null;
  proc.exited.then((exited) => {
    code = exited;
  });
  while (Date.now() < deadline) {
    if (code !== null) throw new Error(`server exited ${code}\n${await serverLog(logPath)}`);
    try {
      const res = await fetch(`${base}/version`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await Bun.sleep(200);
  }
  proc.kill();
  throw new Error(`server did not listen on ${base}\n${await serverLog(logPath)}`);
}

async function stopServer(proc: Bun.Subprocess): Promise<void> {
  proc.kill();
  const timed = await Promise.race([
    proc.exited.then(() => "exited" as const),
    Bun.sleep(5_000).then(() => "timeout" as const),
  ]);
  if (timed === "timeout") proc.kill(9);
}

async function runPoint(scenario: string, vus: number): Promise<Point> {
  const summaryPath = `${dataDir}/k6-summary.json`;
  const summaryRel = summaryPath.startsWith(`${root}/`) ? summaryPath.slice(root.length + 1) : summaryPath;
  rmSync(summaryPath, { force: true });
  const proc = Bun.spawn(
    [
      k6,
      "run",
      "-q",
      "--log-output",
      "none",
      "-e",
      `SUMMARY=${summaryRel}`,
      "-e",
      `SCENARIO=${scenario}`,
      "-e",
      `VUS=${vus}`,
      "-e",
      `DURATION=${duration}`,
      "-e",
      `BENCH_URL=${base}`,
      `${import.meta.dir}/k6.js`,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`k6 ${scenario} vus=${vus} exited ${code}\n${err || out}`.trim());
  const summary = (await Bun.file(summaryPath).json()) as SummaryExport;
  return pointFromSummary(summary, scenario, vus);
}

function printPoint(store: string, point: Point): void {
  const pct = (point.errors * 100).toFixed(2);
  console.log(`${store} ${point.scenario} vus=${point.vus} ${Math.round(point.rate)} req/s errors=${pct}%`);
}

const byStore = new Map<string, Map<string, Point>>();
let server: Bun.Subprocess | undefined;
process.once("SIGINT", () => {
  server?.kill();
  process.exit(130);
});

console.log(
  `HTTP suite: ${stores.join(" ")} · ${duration} · VUs ${vuLevels.join("/")} · best req/s. ` +
    "macOS fsync does not flush the drive cache, so durable-write numbers are optimistic.",
);

for (const store of stores) {
  if (await portBusy()) throw new Error(`${base} is already open; stop the other server first`);
  await freshDatabase(store);
  const logPath = `${dataDir}/load-server-${store}.log`;
  rmSync(logPath, { force: true });
  rmSync(`${logPath}.err`, { force: true });
  server = Bun.spawn(["bun", "bench/server.ts"], {
    cwd: root,
    env: serverEnv(store),
    stdout: Bun.file(logPath),
    stderr: Bun.file(`${logPath}.err`),
  });
  try {
    await waitReady(server, logPath);
    const seed = Bun.spawn(["bun", "bench/seed.ts"], {
      cwd: root,
      env: { ...serverEnv(store), BENCH_URL: base },
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await seed.exited) !== 0) throw new Error(`seed failed for ${store}`);
    const points = new Map<string, Point>();
    for (const scenario of scenarioIds) {
      const runs: Point[] = [];
      for (const vus of vuLevels) {
        const point = await runPoint(scenario, vus);
        runs.push(point);
        printPoint(store, point);
      }
      const best = bestPoint(runs);
      if (best) points.set(scenario, best);
    }
    byStore.set(store, points);
  } finally {
    await stopServer(server);
    server = undefined;
  }
}

const rows = scenarioIds.map((id) => ({
  label: scenarioLabel(id),
  cells: stores.map((store) => byStore.get(store)?.get(id)),
}));
console.log(`\n## HTTP (best of ${vuLevels.join(" / ")} VUs, req/s)\n`);
console.log(markdownTable(stores, rows));
console.log(
  "\n⚠ = more than 1% of calls failed. The uncached read and the mix's reads send a fresh argument each call, " +
    "so they miss the query cache; the mix is 9 reads and 1 insert out of every 10. " +
    "macOS fsync does not flush the drive cache.",
);

const saved = Object.fromEntries([...byStore].map(([store, points]) => [store, Object.fromEntries(points)]));
await Bun.write(
  `${dataDir}/load-results.json`,
  JSON.stringify({ at: new Date().toISOString(), duration, vuLevels, stores: saved }, null, 2),
);

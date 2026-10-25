// STUDY-184 step 1. Cached reads on one memory server, then on two with separate data directories.
// Same 32 connections either way. The load runs in this process, so on a 2-core box it shares the machine
// with the servers, as k6 did in the 5 Oct bench. Listens on 127.0.0.1 only.

import { readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";

const ports = [3410, 3412];
const concurrency = Number(process.env.CONCURRENCY ?? 32);
const durationMs = Number(process.env.DURATION_MS ?? 10_000);
const root = ".data/two-read";

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return { ...env, ...extra };
}

function cpuTicks(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(rest[11]) + Number(rest[12]);
  } catch {
    return null;
  }
}

async function start(port: number): Promise<Bun.Subprocess> {
  const dir = `${root}/${port}`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const proc = Bun.spawn(["bun", "bench/server.ts"], {
    env: childEnv({
      PERSISTENCE: "memory",
      DATA: dir,
      PORT: String(port),
      BENCH_HOSTNAME: "127.0.0.1",
      INSTANCE_NAME: `two-read-${port}`,
      INSTANCE_SECRET: "ab".repeat(32),
    }),
    stdout: "ignore",
    stderr: Bun.file(`${dir}/server.err`),
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${url}/version`)).ok) return proc;
    } catch {
      // Not listening yet.
    }
    if (proc.exitCode !== null) break;
    await Bun.sleep(100);
  }
  const err = await Bun.file(`${dir}/server.err`).text();
  throw new Error(`server ${port} did not start\n${err.slice(-500)}`);
}

async function seed(port: number): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "bench:seedItems", args: { tenants: 1, perTenant: 20, tenantOffset: 0 } }),
  });
  const body = await res.text();
  if (!body.startsWith('{"status":"success"')) throw new Error(`seed ${port}: ${body.slice(0, 200)}`);
}

async function load(urls: string[], procs: Bun.Subprocess[]): Promise<void> {
  const body = JSON.stringify({ path: "bench:listCached", args: {} });
  const warmupEnd = performance.now() + 1000;
  await Promise.all(
    Array.from({ length: concurrency }, async (_, i) => {
      const url = urls[i % urls.length];
      while (performance.now() < warmupEnd) {
        const res = await fetch(`${url}/api/query`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        await res.text();
      }
    }),
  );
  const before = procs.map((proc) => cpuTicks(proc.pid));
  const clientBefore = cpuTicks(process.pid);
  const started = performance.now();
  let ok = 0;
  let failed = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async (_, i) => {
      const url = urls[i % urls.length];
      const end = started + durationMs;
      while (performance.now() < end) {
        try {
          const res = await fetch(`${url}/api/query`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          });
          const text = await res.text();
          if (text.startsWith('{"status":"success"')) ok++;
          else failed++;
        } catch {
          failed++;
        }
      }
    }),
  );
  const seconds = (performance.now() - started) / 1000;
  const hz = 100;
  const serverCpu = procs.map((proc, i) => {
    const after = cpuTicks(proc.pid);
    const ticks = before[i] === null || after === null ? null : (after - before[i]!) / hz / seconds;
    return { pid: proc.pid, core: ticks === null ? null : Math.round(ticks * 100) / 100 };
  });
  const clientAfter = cpuTicks(process.pid);
  const clientCore =
    clientBefore === null || clientAfter === null
      ? null
      : Math.round(((clientAfter - clientBefore) / hz / seconds) * 100) / 100;
  console.log(
    JSON.stringify({
      servers: urls.length,
      concurrency,
      seconds: Math.round(seconds * 10) / 10,
      ok,
      failed,
      perSecond: Math.round(ok / seconds),
      serverCpu,
      clientCore,
    }),
  );
}

async function stop(procs: Bun.Subprocess[]): Promise<void> {
  for (const proc of procs) proc.kill("SIGTERM");
  await Promise.all(procs.map((proc) => proc.exited));
}

// One OS process per server, each with its own connections. The in-process load above is a single asker.
async function splitLoad(urls: string[], procs: Bun.Subprocess[]): Promise<void> {
  const before = procs.map((proc) => cpuTicks(proc.pid));
  const kids = urls.map((url) =>
    Bun.spawn([process.execPath, import.meta.path], {
      env: childEnv({
        ROLE: "client",
        LOAD_URL: url,
        CONCURRENCY: String(concurrency),
        DURATION_MS: String(durationMs),
      }),
      stdout: "pipe",
      stderr: "inherit",
    }),
  );
  const texts = await Promise.all(kids.map((kid) => new Response(kid.stdout).text()));
  const codes = await Promise.all(kids.map((kid) => kid.exited));
  if (codes.some((code) => code !== 0)) throw new Error(`a client exited ${codes.join(",")}`);
  const rows = texts.map((text) => {
    const line = text
      .trim()
      .split("\n")
      .reverse()
      .find((row) => row.startsWith("{"));
    if (!line) throw new Error(`client printed no result\n${text.slice(-300)}`);
    return JSON.parse(line) as { perSecond: number; failed: number; clientCore: number | null; seconds: number };
  });
  const seconds = Math.max(...rows.map((row) => row.seconds));
  const hz = 100;
  const serverCpu = procs.map((proc, i) => {
    const after = cpuTicks(proc.pid);
    const ticks = before[i] === null || after === null ? null : (after - before[i]!) / hz / seconds;
    return { pid: proc.pid, core: ticks === null ? null : Math.round(ticks * 100) / 100 };
  });
  console.log(
    JSON.stringify({
      servers: urls.length,
      clients: urls.length,
      concurrency,
      seconds,
      failed: rows.reduce((sum, row) => sum + row.failed, 0),
      perSecond: rows.reduce((sum, row) => sum + row.perSecond, 0),
      each: rows.map((row) => row.perSecond),
      serverCpu,
      clientCores: rows.map((row) => row.clientCore),
    }),
  );
}

if (process.env.ROLE === "client") {
  const url = process.env.LOAD_URL;
  if (!url) throw new Error("LOAD_URL is required");
  await load([url], []);
  process.exit(0);
}

const split = process.env.SPLIT === "1";
for (const count of [1, 2]) {
  const procs: Bun.Subprocess[] = [];
  try {
    for (let i = 0; i < count; i++) procs.push(await start(ports[i]!));
    for (let i = 0; i < count; i++) await seed(ports[i]!);
    const urls = ports.slice(0, count).map((port) => `http://127.0.0.1:${port}`);
    if (split) await splitLoad(urls, procs);
    else await load(urls, procs);
  } finally {
    await stop(procs);
  }
}
console.log("TWO-READ-DONE");

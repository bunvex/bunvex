// STUDY-184 §5. N bench servers, each on its own copy of one seeded SQLite store and its own port, each loaded
// by its own k6 at the same time. The sum is a ceiling for N processes: nothing is shared or coordinated, so a
// real follower (one store, invalidation, forwarding) can only do worse. k6 is Go and multi-threaded, so the
// client is not one JavaScript thread, which is what limited the first draft's in-process load.
//   N=2 SCENARIO=cached bun bench/scale/independent.ts
// Env: N (1), SCENARIO (cached), VUS (32 per server), DURATION (10s), BASE_PORT (3500), DATA (.data/independent).
// The first run seeds `${DATA}/seed` once (bench/seed.ts); later runs copy it.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";

const root = `${import.meta.dir}/../..`;
const n = Number(process.env.N ?? 1);
const scenario = process.env.SCENARIO ?? "cached";
const vus = process.env.VUS ?? "32";
const duration = process.env.DURATION ?? "10s";
const basePort = Number(process.env.BASE_PORT ?? 3500);
const data = process.env.DATA ?? `${root}/.data/independent`;
const k6 = Bun.which("k6");
if (k6 === null) throw new Error("k6 is not on PATH");

const env = (dir: string, port: number) => ({
  ...process.env,
  PERSISTENCE: "sqlite",
  DATA: dir,
  // Each server also binds its site port (port + 1), so servers are 10 ports apart.
  PORT: String(port),
  DO_NOT_REQUIRE_SSL: "1",
  BENCH_HOSTNAME: "127.0.0.1",
});

async function ready(port: number) {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/version`);
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error(`server on ${port} did not start`);
}

const seed = `${data}/seed`;
if (!existsSync(`${seed}/bunvex.sqlite`)) {
  mkdirSync(seed, { recursive: true });
  const server = Bun.spawn(["bun", "bench/server.ts"], { cwd: root, env: env(seed, basePort), stdout: "ignore" });
  await ready(basePort);
  const run = Bun.spawn(["bun", "bench/seed.ts"], {
    cwd: root,
    env: { ...process.env, BENCH_URL: `http://127.0.0.1:${basePort}` },
  });
  if ((await run.exited) !== 0) throw new Error("seed failed");
  server.kill("SIGINT");
  await server.exited;
}

const servers = [];
for (let i = 1; i <= n; i++) {
  const dir = `${data}/s${i}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(seed)) if (f.startsWith("bunvex.sqlite")) cpSync(`${seed}/${f}`, `${dir}/${f}`);
  const port = basePort + 10 * i;
  servers.push({
    port,
    proc: Bun.spawn(["bun", "bench/server.ts"], { cwd: root, env: env(dir, port), stdout: "ignore" }),
  });
}
await Promise.all(servers.map((s) => ready(s.port)));

const runs = servers.map(({ port }) => {
  const summary = `${data}/k6-${port}.json`;
  const proc = Bun.spawn(
    [k6, "run", "-q", "-e", `SCENARIO=${scenario}`, "-e", `VUS=${vus}`, "-e", `DURATION=${duration}`].concat([
      "-e",
      `BENCH_URL=http://127.0.0.1:${port}`,
      "--summary-export",
      summary,
      "bench/load/k6.js",
    ]),
    { cwd: root, stdout: "ignore", stderr: "ignore" },
  );
  return proc.exited.then(() => Bun.file(summary).json());
});
const results = await Promise.all(runs);
for (const s of servers) s.proc.kill("SIGINT");
await Promise.all(servers.map((s) => s.proc.exited));

let total = 0;
for (const [i, r] of results.entries()) {
  const rate: number = r.metrics.http_reqs.rate;
  const errors: number = r.metrics.bench_errors.value;
  total += rate * (1 - errors);
  console.log(`server ${i + 1}: ${Math.round(rate)} req/s, errors ${errors.toFixed(3)}`);
}
console.log(`${scenario}, ${n} server(s): ${Math.round(total)} req/s without errors`);

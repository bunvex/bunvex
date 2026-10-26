// bench/cloud: runs on the server box, started by cloud.ts. Starts N bench servers (bench/server.ts) on HOST, each
// on its own copy of one seeded store, writes their pids, prints READY and stops them on SIGINT. As
// bench/scale/independent.ts, nothing is shared between the servers. SQLite copies the seed's files; Postgres
// makes each database from the seed as a template, in one Postgres container listening on 127.0.0.1 only.
// The seed (bench/seed.ts) is made once per persistence and kept for later runs.
// Env: N (1), PERSISTENCE (sqlite | postgres), HOST (0.0.0.0), BASE_PORT (3500), DATA (/root/bench-data).
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const root = `${import.meta.dir}/../..`;
const n = Number(process.env.N ?? 1);
const persistence = process.env.PERSISTENCE ?? "sqlite";
const host = process.env.HOST ?? "0.0.0.0";
const basePort = Number(process.env.BASE_PORT ?? 3500);
const data = process.env.DATA ?? "/root/bench-data";
const pg = "postgres://postgres:bench@127.0.0.1:5432";
if (persistence !== "sqlite" && persistence !== "postgres") throw new Error(`PERSISTENCE=${persistence}`);

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.join(" ")}: ${err || out}`);
  return out;
}
const psql = (sql: string) =>
  run(["docker", "exec", "bench-pg", "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-qc", sql]);

async function startPostgres() {
  if ((await run(["docker", "ps", "-q", "-f", "name=^bench-pg$"])).trim()) return;
  await run(["docker", "rm", "-f", "bench-pg"]).catch(() => {});
  await run(
    ["docker", "run", "-d", "--name", "bench-pg", "--network", "host", "-e", "POSTGRES_PASSWORD=bench"].concat([
      "postgres:17",
      "-c",
      "listen_addresses=127.0.0.1",
      "-c",
      "max_connections=1000",
    ]),
  );
  for (let i = 0; i < 100; i++) {
    try {
      await psql("select 1");
      return;
    } catch {
      await Bun.sleep(300);
    }
  }
  throw new Error("postgres did not start");
}

const env = (store: string, port: number) => ({
  ...process.env,
  PERSISTENCE: persistence,
  ...(persistence === "sqlite" ? { DATA: store } : { PERSISTENCE_URL: `${pg}/${store}` }),
  // Each server also binds its site port (port + 1), so servers are 10 ports apart.
  PORT: String(port),
  DO_NOT_REQUIRE_SSL: "1",
  BENCH_HOSTNAME: host,
});
const local = host === "0.0.0.0" ? "127.0.0.1" : host;

async function ready(port: number, proc: Bun.Subprocess) {
  for (let i = 0; i < 300; i++) {
    if (proc.exitCode !== null) throw new Error(`server on ${port} exited with ${proc.exitCode}`);
    try {
      await fetch(`http://${local}:${port}/version`);
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error(`server on ${port} did not start`);
}
const serve = (store: string, port: number) =>
  Bun.spawn(["bun", "bench/server.ts"], { cwd: root, env: env(store, port), stdout: "ignore", stderr: "inherit" });

if (persistence === "postgres") await startPostgres();

const seed = persistence === "sqlite" ? `${data}/sqlite-seed` : "seed";
const seeded = `${data}/${persistence}-seeded`;
if (!existsSync(seeded)) {
  mkdirSync(data, { recursive: true });
  if (persistence === "sqlite") {
    rmSync(seed, { recursive: true, force: true });
    mkdirSync(seed, { recursive: true });
  } else {
    await psql("DROP DATABASE IF EXISTS seed WITH (FORCE)");
    await psql("CREATE DATABASE seed");
  }
  const server = serve(seed, basePort);
  await ready(basePort, server);
  const fill = Bun.spawn(["bun", "bench/seed.ts"], {
    cwd: root,
    env: { ...process.env, BENCH_URL: `http://${local}:${basePort}` },
    stdout: "inherit",
  });
  if ((await fill.exited) !== 0) throw new Error("seed failed");
  server.kill("SIGINT");
  await server.exited;
  writeFileSync(seeded, "");
}

const servers: { port: number; proc: Bun.Subprocess }[] = [];
for (let i = 1; i <= n; i++) {
  const port = basePort + 10 * i;
  let store = `s${i}`;
  if (persistence === "sqlite") {
    store = `${data}/s${i}`;
    rmSync(store, { recursive: true, force: true });
    mkdirSync(store, { recursive: true });
    for (const f of readdirSync(seed)) if (f.startsWith("bunvex.sqlite")) cpSync(`${seed}/${f}`, `${store}/${f}`);
  } else {
    await psql(`DROP DATABASE IF EXISTS ${store} WITH (FORCE)`);
    await psql(`CREATE DATABASE ${store} TEMPLATE seed`);
  }
  servers.push({ port, proc: serve(store, port) });
}
await Promise.all(servers.map((s) => ready(s.port, s.proc)));
writeFileSync(`${data}/pids`, servers.map((s) => s.proc.pid).join("\n"));

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, async () => {
    for (const s of servers) s.proc.kill("SIGINT");
    await Promise.all(servers.map((s) => s.proc.exited));
    process.exit(0);
  });
console.log(`READY ${servers.map((s) => s.port).join(",")}`);

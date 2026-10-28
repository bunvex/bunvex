// bench/cloud: runs on the server box, started by versus.ts. Starts one product's server on the database box's
// Postgres, listening on HOST:3210, writes its pid to /root/bench-data/pids, prints READY and stops it on SIGINT.
//   TARGET=convex: Convex's prebuilt backend (CONVEX_BIN), `--db postgres-v5`, instance `bench` (its database is
//     named after the instance), the app from convex-app.ts deployed by Convex's CLI.
//   TARGET=bunvex: bench/server.ts with PERSISTENCE=postgres on the database `bunvex_bench`.
// FRESH=1 drops and creates the database (and deploys, and seeds with bench/seed.ts); without it the server opens the
// store a FRESH run left. SPLAY=off sets SUBSCRIPTION_INVALIDATION_DELAY_MULTIPLIER=0 (the same knob on both).
// Both lift the write throughput limit (MAX_BYTES_WRITTEN_PER_SECOND), as bench/server.ts does by default.
// Env: TARGET, DB_URL (postgres://user:pass@host:5432, no database), HOST, PORT (3210), FRESH, SPLAY (on), DATA,
// CONVEX_BIN, CONVEX_APP.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import postgres from "postgres";

const root = `${import.meta.dir}/../..`;
const target = process.env.TARGET;
const dbUrl = process.env.DB_URL;
const host = process.env.HOST ?? "127.0.0.1";
const fresh = process.env.FRESH === "1";
const port = Number(process.env.PORT ?? 3210);
const convexBin = process.env.CONVEX_BIN ?? "/root/convex-backend/convex-local-backend";
const convexApp = process.env.CONVEX_APP ?? "/root/convex-app";
const data = process.env.DATA ?? "/root/bench-data";
// A fixed secret: the store a FRESH run made opens again on the restart for SPLAY=on.
const INSTANCE = "bench";
const SECRET = "4361f2d1a4e6b3f0c8f5d2e9a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8";
if (target !== "convex" && target !== "bunvex") throw new Error(`TARGET=${target}`);
if (!dbUrl) throw new Error("DB_URL is required");
const database = target === "convex" ? INSTANCE : "bunvex_bench";

async function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.join(" ")}: ${(err || out).slice(-3000)}`);
  return out;
}

if (fresh) {
  const sql = postgres(`${dbUrl}/postgres`, { max: 1, onnotice: () => {} });
  await sql.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await sql.unsafe(`CREATE DATABASE ${database}`);
  await sql.end();
  rmSync(`${data}/convex-storage`, { recursive: true, force: true });
}
mkdirSync(data, { recursive: true });

const knobs = {
  MAX_BYTES_WRITTEN_PER_SECOND: String(Number.MAX_SAFE_INTEGER),
  ...(process.env.SPLAY === "off" ? { SUBSCRIPTION_INVALIDATION_DELAY_MULTIPLIER: "0" } : {}),
};
const origin = `http://${host}:${port}`;
const answers = () =>
  fetch(`${origin}/version`).then(
    (r) => r.ok,
    () => false,
  );
// Another server on the port would take the seed and the load in this one's place.
if (await answers()) throw new Error(`something already answers on ${origin}`);
const server =
  target === "convex"
    ? Bun.spawn(
        [convexBin, dbUrl, "--db", "postgres-v5", "--do-not-require-ssl", "--disable-beacon"].concat([
          "--instance-name",
          INSTANCE,
          "--instance-secret",
          SECRET,
          "--interface",
          host,
          "--port",
          String(port),
          "--site-proxy-port",
          String(port + 1),
          "--convex-origin",
          origin,
          "--convex-site",
          `http://${host}:${port + 1}`,
          "--local-storage",
          `${data}/convex-storage`,
        ]),
        { env: { ...process.env, RUST_LOG: "warn", ...knobs }, stdout: "inherit", stderr: "inherit" },
      )
    : Bun.spawn(["bun", "bench/server.ts"], {
        cwd: root,
        env: {
          ...process.env,
          ...knobs,
          PERSISTENCE: "postgres",
          PERSISTENCE_URL: `${dbUrl}/${database}`,
          DO_NOT_REQUIRE_SSL: "1",
          PORT: String(port),
          BENCH_HOSTNAME: host,
        },
        stdout: "inherit",
        stderr: "inherit",
      });

for (let i = 0; ; i++) {
  if (server.exitCode !== null) throw new Error(`${target} exited with ${server.exitCode}`);
  if (i === 600) throw new Error(`${target} did not start`);
  if (await answers()) break;
  await Bun.sleep(100);
}

if (fresh) {
  if (target === "convex") {
    const adminKey = (
      await run([convexBin, "keygen", "admin-key", "--instance-name", INSTANCE, "--instance-secret", SECRET])
    ).trim();
    // The boxes have no Node: Bun runs Convex's CLI (the deploy is not measured).
    await run(["bun", `${convexApp}/node_modules/.bin/convex`, "deploy", "--yes", "--typecheck=disable"], {
      cwd: convexApp,
      env: { CONVEX_SELF_HOSTED_URL: origin, CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey },
    });
  }
  console.log((await run(["bun", "bench/seed.ts"], { cwd: root, env: { BENCH_URL: origin } })).trim());
}

writeFileSync(`${data}/pids`, String(server.pid));
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, async () => {
    server.kill("SIGINT");
    // The next server binds the same port: wait until this one is gone, killed if it lingers.
    const killer = setTimeout(() => server.kill("SIGKILL"), 15_000);
    await server.exited;
    clearTimeout(killer);
    process.exit(0);
  });
console.log(`READY ${target}`);

// STUDY-136 §3.5: the index cache end to end. The real backend (`bunvex-local-backend`, run by Bun) over a
// store, the app in bench/index-cache-e2e/ pushed with `bunvex deploy`, and HTTP load from separate processes
// (bench/index-cache-e2e-load.ts) through the public HTTP client. Phases alternate the index cache off
// (INDEX_CACHE_SIZE=0) and on (the default), each on a freshly started backend over the same data, after a
// warm-up phase. Per phase: throughput, latencies, the index cache's counters (from /api/debug/index_cache) and
// the store's transactions per second (Postgres's pg_stat_database).
//   PG_URL=postgres://…/db bun bench/index-cache-e2e.ts      (an EMPTY scratch database: its tables are dropped)
//   Env: CHANNELS (1000), MSGS (50), USERS (10000), WRITE_PCT (10), WORKERS (4 load processes),
//        CONC (16 clients per process), SECS (20 per phase), ROUNDS (2), SKEW (1)
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BunvexHttpClient } from "bunvex/browser";
import postgres from "postgres";

const env = (k: string, d: number) => Number(process.env[k] ?? d);
const PG_URL = process.env.PG_URL;
if (!PG_URL) throw new Error("PG_URL: an empty scratch Postgres database");
const CHANNELS = env("CHANNELS", 1000);
const MSGS = env("MSGS", 50);
const USERS = env("USERS", 10_000);
const WORKERS = env("WORKERS", 4);
const SECS = env("SECS", 20);
const ROUNDS = env("ROUNDS", 2);

const ROOT = resolve(import.meta.dir, "..");
const BACKEND = join(ROOT, "packages/bunvex/bin/local-backend.ts");
const CLI = join(ROOT, "packages/bunvex/bin/bunvex.ts");
const APP = join(import.meta.dir, "index-cache-e2e");
const state = mkdtempSync(join(tmpdir(), "bunvex-index-cache-e2e-"));
const name = "index-cache-e2e";
const secret = randomBytes(32).toString("hex");
const port = 20_000 + Math.floor(Math.random() * 10_000);
const url = `http://127.0.0.1:${port}`;

async function run(cmd: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")} failed:\n${out}\n${err}`);
  return out;
}

// A fresh database: drop what an earlier run left.
const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
const tables = await sql`select tablename from pg_tables where schemaname = 'public'`;
for (const t of tables) await sql.unsafe(`drop table if exists "${t.tablename}" cascade`);

let backend: ReturnType<typeof Bun.spawn> | null = null;
async function start(indexCache: boolean) {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    INDEX_CACHE_SIZE: indexCache ? undefined : "0",
    // A capacity measurement, as bench/server.ts: Convex's 4 MiB/s write limit (STUDY-78) lifted unless set.
    MAX_BYTES_WRITTEN_PER_SECOND: process.env.MAX_BYTES_WRITTEN_PER_SECOND || String(Number.MAX_SAFE_INTEGER),
  };
  backend = Bun.spawn(
    [
      process.execPath,
      BACKEND,
      "--db",
      "postgres",
      "--do-not-require-ssl",
      "--port",
      String(port),
      "--site-proxy-port",
      String(port + 1),
      "--instance-name",
      name,
      "--instance-secret",
      secret,
      "--local-storage",
      join(state, "storage"),
      PG_URL!,
    ],
    { cwd: state, env: childEnv, stdout: "ignore", stderr: "pipe" },
  );
  for (let i = 0; ; i++) {
    const answer = await fetch(`${url}/instance_name`)
      .then((r) => r.text())
      .catch(() => null);
    if (answer === name) return;
    if (backend.exitCode !== null || i > 600)
      throw new Error(`the backend did not start:\n${await new Response(backend.stderr as ReadableStream).text()}`);
    await Bun.sleep(100);
  }
}
async function stop() {
  if (!backend) return;
  backend.kill("SIGTERM");
  await backend.exited;
  backend = null;
}

const adminKey = (
  await run(
    [process.execPath, BACKEND, "keygen", "admin-key", "--instance-name", name, "--instance-secret", secret],
    state,
  )
).trim();
const debug = async (path: string) =>
  (await fetch(`${url}${path}`, { headers: { authorization: `Bunvex ${adminKey}` } })).json() as Promise<any>;
const commits = async () => {
  const [r] =
    await sql`select xact_commit + xact_rollback as n from pg_stat_database where datname = current_database()`;
  return Number(r!.n);
};

try {
  // Deploy and seed, on a backend with the default (index cache on).
  await start(true);
  const envFile = join(state, "deployment.env");
  writeFileSync(envFile, `BUNVEX_SELF_HOSTED_URL=${url}\nBUNVEX_SELF_HOSTED_ADMIN_KEY=${adminKey}\n`);
  await run([process.execPath, CLI, "deploy", "--typecheck=disable", "--env-file", envFile], APP);
  const http = new BunvexHttpClient(url, { logger: false });
  const t0 = performance.now();
  await http.mutation("chat:seedSettings" as never, {} as never);
  const channels: string[] = [];
  for (let c = 0; c < CHANNELS; c += 20)
    channels.push(
      ...((await http.mutation(
        "chat:seedChannels" as never,
        {
          from: c,
          count: Math.min(20, CHANNELS - c),
          msgs: MSGS,
        } as never,
      )) as string[]),
    );
  const users: string[] = [];
  for (let u = 0; u < USERS; u += 500)
    users.push(
      ...((await http.mutation(
        "chat:seedUsers" as never,
        { from: u, count: Math.min(500, USERS - u) } as never,
      )) as string[]),
    );
  const idsFile = join(state, "ids.json");
  writeFileSync(idsFile, JSON.stringify({ channels, users }));
  console.log(
    JSON.stringify({
      CHANNELS,
      MSGS,
      USERS,
      WRITE_PCT: env("WRITE_PCT", 10),
      WORKERS,
      CONC: env("CONC", 16),
      SECS,
      ROUNDS,
      SKEW: env("SKEW", 1),
      seedMs: Math.round(performance.now() - t0),
    }),
  );
  await stop();

  const pct = (xs: number[], p: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return Number((s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0).toFixed(2));
  };
  let phaseNo = 0;
  const phase = async (on: boolean) => {
    phaseNo++;
    await start(on);
    const c0 = await commits();
    const loads = Array.from({ length: WORKERS }, () =>
      Bun.spawn([process.execPath, join(import.meta.dir, "index-cache-e2e-load.ts"), url, idsFile], {
        stdout: "pipe",
        stderr: "inherit",
      }),
    );
    const outs = await Promise.all(loads.map(async (p) => JSON.parse(await new Response(p.stdout).text())));
    const c1 = await commits();
    const q = outs.flatMap((o) => o.queries as number[]);
    const m = outs.flatMap((o) => o.mutations as number[]);
    const errors = outs.reduce((a, o) => a + o.errors, 0);
    const ic = await debug("/api/debug/index_cache");
    const qc = await debug("/api/debug/query_cache");
    await stop();
    const ops = q.length + m.length;
    console.log(
      JSON.stringify({
        phase: phaseNo,
        indexCache: on ? "on" : "off",
        opsPerSec: Math.round(ops / SECS),
        queriesPerSec: Math.round(q.length / SECS),
        mutationsPerSec: Math.round(m.length / SECS),
        queryP50: pct(q, 0.5),
        queryP99: pct(q, 0.99),
        mutationP50: pct(m, 0.5),
        mutationP99: pct(m, 0.99),
        errors,
        firstError: outs.find((o) => o.firstError)?.firstError,
        queryCacheHitRate: Number((qc.hits / Math.max(1, qc.hits + qc.misses)).toFixed(3)),
        indexCacheHitRate: ic.enabled ? Number((ic.hits / Math.max(1, ic.hits + ic.misses)).toFixed(3)) : 0,
        indexCacheMB: ic.enabled ? Number((ic.bytes / 2 ** 20).toFixed(1)) : 0,
        storeTxPerSec: Math.round((c1 - c0) / SECS),
        storeTxPerOp: Number(((c1 - c0) / Math.max(1, ops)).toFixed(2)),
      }),
    );
  };
  await phase(false); // warm-up
  for (let r = 0; r < ROUNDS; r++) {
    await phase(false);
    await phase(true);
  }
} finally {
  await stop();
  await sql.end();
  rmSync(state, { recursive: true, force: true });
}

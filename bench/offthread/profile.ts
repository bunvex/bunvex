// STUDY-190 §3: profiles of bench/server.ts under bench/load/k6.js, one server per scenario and store, with the
// main thread's time put in buckets (buckets.ts) and divided by the requests served.
//   bun bench/offthread/profile.ts
// Env:
//   PERSISTENCES (sqlite,postgres), SCENARIOS (cached,uncached,insert,increment1000), VUS (32), DURATION (20s);
//   SEED_SQLITE: a directory holding a seeded bunvex.sqlite (bench/seed.ts), copied for each run;
//   PG_URL: a Postgres server URL without database, PG_TEMPLATE: a seeded database each run is created from;
//   OUT: where profiles and the summary go; SERVER_PIN / LOAD_PIN: a prefix such as "taskset -c 0" (Linux);
//   SERVER: the server script (bench/server.ts; bench/offthread/server.ts runs a prototype), with its env passed on;
//   PROFILE=0: no profiler (rates without its cost); REPEATS (1): runs per point, each on a fresh copy of the store;
//   LOAD_SSH=root@<host>: k6 runs there (its repository at LOAD_REPO, /root/bunvex), against URL_HOST (the server
//   then listens on 0.0.0.0).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { bucketize, report } from "./buckets.ts";

const root = Bun.fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const list = (v: string | undefined, d: string) => (v ?? d).split(",").filter(Boolean);
const persistences = list(process.env.PERSISTENCES, "sqlite,postgres");
const scenarios = list(process.env.SCENARIOS, "cached,uncached,insert,increment1000");
const vus = process.env.VUS ?? "32";
const duration = process.env.DURATION ?? "20s";
const out = process.env.OUT ?? `${root}/.data/offthread/profiles`;
const serverScript = process.env.SERVER ?? "bench/server.ts";
const profile = process.env.PROFILE !== "0";
const pin = (v: string | undefined) => (v ? v.split(" ").filter(Boolean) : []);
const port = Number(process.env.PORT ?? 3790);
const repeats = Number(process.env.REPEATS ?? 1);
const loadSsh = process.env.LOAD_SSH;
const urlHost = process.env.URL_HOST ?? "127.0.0.1";
const bun = process.execPath;
const k6 = Bun.which("k6") ?? "k6";
mkdirSync(out, { recursive: true });

async function run(cmd: string[], env?: Record<string, string>): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")}: ${code} ${e.slice(-2000)}`);
  return o;
}

/** CPU seconds of a process (all threads), and on Linux per thread name. */
async function cpu(pid: number): Promise<{ total: number; threads: Record<string, number> }> {
  if (process.platform === "linux") {
    const hz = 100;
    const threads: Record<string, number> = {};
    let total = 0;
    for (const t of readdirSync(`/proc/${pid}/task`)) {
      try {
        const s = readFileSync(`/proc/${pid}/task/${t}/stat`, "utf8");
        const name = s.slice(s.indexOf("(") + 1, s.lastIndexOf(")")).replace(/[0-9]+$/, "#");
        const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
        const sec = (Number(f[11]) + Number(f[12])) / hz;
        threads[name] = (threads[name] ?? 0) + sec;
        total += sec;
      } catch {}
    }
    return { total, threads };
  }
  const t = (await run(["ps", "-o", "time=", "-p", String(pid)])).trim();
  const [m, s] = t.split(":");
  return { total: Number(m) * 60 + Number(s), threads: {} };
}

/** The server being measured: killed if this script fails, so no stray server holds the port for the next run. */
let current: ReturnType<typeof Bun.spawn> | null = null;
process.on("exit", () => current?.kill("SIGKILL"));

async function ready() {
  for (let i = 0; i < 300; i++) {
    if (current?.exitCode !== null) throw new Error("the server exited before it was ready");
    try {
      if ((await fetch(`http://127.0.0.1:${port}/version`)).ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("server not ready");
}

const summary: string[] = [];
for (const p of persistences)
  for (const sc of scenarios)
    for (let rep = 1; rep <= repeats; rep++) {
      const tag = repeats > 1 ? `${p}-${sc}-r${rep}` : `${p}-${sc}`;
      const dir = `${out}/${tag}`;
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const env: Record<string, string> = {
        PORT: String(port),
        BENCH_HOSTNAME: loadSsh ? "0.0.0.0" : "127.0.0.1",
        DO_NOT_REQUIRE_SSL: "1",
        PERSISTENCE: p,
      };
      let db = "";
      if (p === "sqlite") {
        const seed = process.env.SEED_SQLITE;
        if (!seed || !existsSync(`${seed}/bunvex.sqlite`))
          throw new Error("SEED_SQLITE must hold a seeded bunvex.sqlite");
        cpSync(seed, `${dir}/data`, { recursive: true });
        env.DATA = `${dir}/data`;
      } else if (p === "postgres") {
        const url = process.env.PG_URL;
        if (!url) throw new Error("PG_URL is needed for postgres");
        db = `offthread_${sc}`;
        const admin = new Bun.SQL(`${url}/postgres`);
        await admin.unsafe(`drop database if exists ${db}`);
        await admin.unsafe(`create database ${db} template ${process.env.PG_TEMPLATE ?? "seed190"}`);
        await admin.close();
        env.PERSISTENCE_URL = `${url}/${db}`;
        env.DATA = `${dir}/files`;
      } else throw new Error(`unknown persistence ${p}`);
      const server = Bun.spawn(
        [
          ...pin(process.env.SERVER_PIN),
          bun,
          ...(profile ? ["--cpu-prof", `--cpu-prof-dir=${dir}`, "--cpu-prof-name=main.cpuprofile"] : []),
          `${root}/${serverScript}`,
        ],
        { cwd: root, env: { ...process.env, ...env }, stdout: "ignore", stderr: Bun.file(`${dir}/server.log`) },
      );
      current = server;
      await ready();
      // Wait out the start's background work (table summaries are restored after the server listens): the
      // profile's samples before the idle gap this leaves are not counted.
      for (let prev = (await cpu(server.pid)).total, i = 0; i < 120; i++) {
        await Bun.sleep(500);
        const now = (await cpu(server.pid)).total;
        if (now - prev < 0.02) break;
        prev = now;
      }
      await Bun.sleep(1000);
      const c0 = await cpu(server.pid);
      const t0 = performance.now();
      const k6args = [
        "run",
        "-q",
        "--summary-trend-stats",
        "avg,med,p(90),p(99),max",
        "-e",
        `SCENARIO=${sc}`,
        "-e",
        `VUS=${vus}`,
        "-e",
        `DURATION=${duration}`,
        "-e",
        `BENCH_URL=http://${urlHost}:${port}`,
      ];
      const k6out = loadSsh
        ? await run([
            "ssh",
            "-o",
            "StrictHostKeyChecking=accept-new",
            loadSsh,
            `k6 ${k6args.map((a) => `'${a}'`).join(" ")} ${process.env.LOAD_REPO ?? "/root/bunvex"}/bench/load/k6.js`,
          ])
        : await run([...pin(process.env.LOAD_PIN), k6, ...k6args, `${root}/bench/load/k6.js`]);
      const el = (performance.now() - t0) / 1000;
      const c1 = await cpu(server.pid);
      server.kill("SIGINT");
      await server.exited;
      current = null;
      const m = JSON.parse(k6out).metrics;
      const reqs = m.http_reqs.values.count as number;
      const rps = m.http_reqs.values.rate as number;
      const p99 = m.http_req_duration.values["p(99)"] as number;
      const err = m.bench_errors?.values?.rate ?? 0;
      const threads = Object.entries(c1.threads)
        .map(([k, v]) => [k, v - (c0.threads[k] ?? 0)] as const)
        .filter(([, v]) => v / el >= 0.02)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${(v / el).toFixed(2)}`)
        .join(", ");
      let text =
        `## ${tag}\n\n${rps.toFixed(0)} req/s, p99 ${p99.toFixed(1)} ms, errors ${(err * 100).toFixed(2)}%, ` +
        `server ${((c1.total - c0.total) / el).toFixed(2)} cores${threads ? ` (${threads})` : ""}\n\n`;
      if (profile) {
        const f = `${dir}/main.cpuprofile`;
        if (existsSync(f)) text += `${report(bucketize(JSON.parse(readFileSync(f, "utf8")), 800), reqs, 4)}\n`;
      }
      console.log(text);
      summary.push(text);
      writeFileSync(`${out}/summary.md`, summary.join("\n"));
      if (db) {
        const admin = new Bun.SQL(`${process.env.PG_URL}/postgres`);
        await admin.unsafe(`drop database if exists ${db}`);
        await admin.close();
      }
      rmSync(`${dir}/data`, { recursive: true, force: true });
    }

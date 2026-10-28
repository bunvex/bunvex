// The versus bench: Convex and bunvex on the same server droplet, one at a time, each on the same Postgres on its own
// droplet, driven from a third. Rents three DigitalOcean droplets by the hour in one region's private network:
//   server  runs Convex's prebuilt backend (the release bunvex follows), then bench/server.ts (versus-serve.ts)
//   db      Postgres 17 in Docker, nothing else
//   load    k6 over HTTP (bench/load/k6.js, the VPS reports' scenarios) and fanout.ts, WebSocket subscribers with
//           each product's own client
// Each target gets a fresh database, the same seed (bench/seed.ts) and the same functions (bench/functions.ts; for
// Convex through convex-app.ts). Writes bench/results/cloud/<stamp>-versus-<sha>/ and destroys the droplets.
// Needs `doctl` logged in and ~/.ssh/id_ed25519.pub, as cloud.ts.
//   bun bench/cloud/versus.ts all        up, sync, run, down (down also on failure or Ctrl-C)
//   bun bench/cloud/versus.ts up | sync | run | down | status
// Env: RUN (versus), REGION (sfo2), SERVER_SIZE (c-4), DB_SIZE (c-4), LOAD_SIZE (s-8vcpu-16gb),
// TARGETS (convex,bunvex), SCENARIOS (cached,uncached,insert,increment1000,increment1,action,mix), VUS (8,32,128),
// DURATION (20s), REPEATS (3), FANOUT (100,1000,5000,10000), MESSAGES (20), CONVEX_RELEASE, KEEP=1.
// c-4 is the largest dedicated-CPU size this account may create (sfo2, blr1, lon1); the load box is the largest
// shared-CPU one, so the generator is never the limit.
import { mkdirSync, writeFileSync } from "node:fs";
import { type Box, cpu, remote, root, runOf, sh, status } from "./boxes.ts";

type State = { server: Box; db: Box; load: Box; createdAt: string; droplets: boolean };
const {
  runTag,
  stateFile,
  ssh,
  readState,
  writeState,
  sshKeyFingerprint,
  createDroplet,
  provision,
  down,
  machine,
  ...boxes
} = runOf<State>(process.env.RUN ?? "versus");
const list = (name: string, fallback: string) => (process.env[name] ?? fallback).split(",").filter(Boolean);
// The release the parity files follow (docs/parity/upstream.md), and the differential tests' oracle.
const CONVEX_RELEASE = process.env.CONVEX_RELEASE ?? "precompiled-2026-10-26-04d2f3b";
const PG = "postgres://postgres:bench";

async function up() {
  if (await Bun.file(stateFile).exists()) throw new Error(`boxes already up (${stateFile}): run \`down\` first`);
  const region = process.env.REGION ?? "sfo2";
  const key = await sshKeyFingerprint();
  console.log(`creating droplets in ${region} …`);
  const [server, db, load] = await Promise.all([
    createDroplet(`${runTag}-server`, process.env.SERVER_SIZE ?? "c-4", region, key),
    createDroplet(`${runTag}-db`, process.env.DB_SIZE ?? "c-4", region, key),
    createDroplet(`${runTag}-load`, process.env.LOAD_SIZE ?? "s-8vcpu-16gb", region, key),
  ]);
  writeState({ server, db, load, createdAt: new Date().toISOString(), droplets: true });
  const hourly = [server, db, load].reduce((sum, b) => sum + (b.hourly ?? 0), 0);
  console.log(`server ${server.private}, db ${db.private}, load ${load.private}; $${hourly.toFixed(3)}/h`);
  await Promise.all([server, db, load].map(provision));
}

async function sync(): Promise<string> {
  const s = readState();
  const sha = await boxes.sync([s.server, s.load]);
  // Convex's backend on the server box; its app (and npm package, for the load box's client) on both.
  await ssh(
    s.server,
    `set -e; mkdir -p /root/convex-backend && cd /root/convex-backend && ` +
      `if [ "$(cat RELEASE 2>/dev/null)" != "${CONVEX_RELEASE}" ]; then ` +
      `curl -fsSL --retry 3 -o b.zip https://github.com/get-convex/convex-backend/releases/download/${CONVEX_RELEASE}/convex-local-backend-x86_64-unknown-linux-gnu.zip && ` +
      `unzip -o -q b.zip && rm b.zip && chmod +x convex-local-backend && echo ${CONVEX_RELEASE} > RELEASE; fi`,
  );
  await Promise.all(
    [s.server, s.load].map((b) =>
      ssh(
        b,
        `cd ${remote} && bun bench/cloud/convex-app.ts /root/convex-app && cd /root/convex-app && bun install >/dev/null`,
      ),
    ),
  );
  console.log(`Convex ${CONVEX_RELEASE} on the server box`);
  return sha;
}

/** Postgres 17 on the db box, listening on its private address only. The same instance serves both targets. */
async function startPostgres(db: Box) {
  await ssh(
    db,
    `docker rm -f bench-pg >/dev/null 2>&1 || true; docker run -d --name bench-pg --network host ` +
      `-e POSTGRES_PASSWORD=bench postgres:17 -c listen_addresses=${db.private} -c max_connections=1000 ` +
      `-c shared_buffers=2GB >/dev/null; ` +
      `for i in $(seq 1 100); do docker exec bench-pg pg_isready -h ${db.private} -q && exit 0; sleep 0.5; done; exit 1`,
  );
}

type Serve = { stop: () => Promise<void>; log: () => Promise<string> };
async function serve(s: State, target: string, fresh: boolean, splay: "on" | "off"): Promise<Serve> {
  const env = `TARGET=${target} FRESH=${fresh ? 1 : 0} SPLAY=${splay} HOST=${s.server.private} DB_URL=${PG}@${s.db.private}:5432`;
  const pid = (
    await ssh(
      s.server,
      `ulimit -n 1048576; cd ${remote} && (${env} nohup bun bench/cloud/versus-serve.ts >/root/serve.log 2>&1 & echo $!)`,
    )
  ).trim();
  const log = () => ssh(s.server, "cat /root/serve.log");
  for (let i = 0; ; i++) {
    const text = await log();
    if (/^READY /m.test(text)) break;
    if (i > 900 || !(await ssh(s.server, `kill -0 ${pid} && echo up || true`)).includes("up"))
      throw new Error(`versus-serve.ts (${target}) did not start:\n${text.slice(-3000)}`);
    await Bun.sleep(1000);
  }
  return {
    log,
    stop: async () => {
      await ssh(s.server, `kill -INT ${pid}; while kill -0 ${pid} 2>/dev/null; do sleep 0.2; done`);
    },
  };
}

const rss = async (s: State) =>
  Number((await ssh(s.server, "grep VmRSS /proc/$(cat /root/bench-data/pids)/status | awk '{print $2}'")).trim() || 0) /
  1024;

async function http(s: State, target: string, scenario: string, vus: string) {
  const duration = process.env.DURATION ?? "20s";
  const [before, dbBefore, loadBefore] = await Promise.all([cpu(ssh, s.server), cpu(ssh, s.db), cpu(ssh, s.load)]);
  const out = await ssh(
    s.load,
    `ulimit -n 1048576; cd ${remote} && TARGET=${s.server.private} PORTS=3210 SCENARIO=${scenario} ` +
      `VUS=${vus} DURATION=${duration} bun bench/cloud/load.ts`,
  );
  const [after, dbAfter, loadAfter] = await Promise.all([cpu(ssh, s.server), cpu(ssh, s.db), cpu(ssh, s.load)]);
  const seconds = (after.at - before.at) / 1000;
  const [r] = JSON.parse(out.trim().split("\n").at(-1)!) as {
    rate: number;
    errors: number;
    p50: number;
    p99: number;
  }[];
  return {
    kind: "http" as const,
    target,
    scenario,
    vus: Number(vus),
    duration,
    rate: r!.rate * (1 - r!.errors),
    errors: r!.errors,
    p50: r!.p50,
    p99: r!.p99,
    serverCores: (after.servers - before.servers) / seconds,
    dbCores: (dbAfter.box - dbBefore.box) / seconds,
    loadCores: (loadAfter.box - loadBefore.box) / seconds,
  };
}

async function fanout(s: State, target: string, n: string, splay: "on" | "off") {
  const messages = process.env.MESSAGES ?? "20";
  // The server's memory while the subscribers are connected: sampled until the run ends, the peak kept.
  let peak = 0;
  let done = false;
  const sampler = (async () => {
    while (!done) {
      peak = Math.max(peak, await rss(s).catch(() => 0));
      await Bun.sleep(2000);
    }
  })();
  try {
    const out = await ssh(
      s.load,
      `ulimit -n 1048576; cd ${remote} && CLIENT=${target} TARGET_URL=http://${s.server.private}:3210 N=${n} ` +
        `MESSAGES=${messages} bun bench/cloud/fanout.ts 2>/dev/null`,
    );
    const r = JSON.parse(out.trim().split("\n").at(-1)!) as {
      delivered: number;
      p50: number | null;
      p99: number | null;
      max: number | null;
      subscribeSeconds: number;
    };
    return { kind: "fanout" as const, target, splay, n: Number(n), messages: Number(messages), ...r, rssMb: peak };
  } finally {
    done = true;
    await sampler;
  }
}

type Result = Awaited<ReturnType<typeof http>> | Awaited<ReturnType<typeof fanout>>;

async function runAll(sha: string) {
  const s = readState();
  const repeats = Number(process.env.REPEATS ?? 3);
  const results: Result[] = [];
  await startPostgres(s.db);
  for (const target of list("TARGETS", "convex,bunvex")) {
    // HTTP and the fan-out with the splay off first (fresh store, seeded), then the fan-out with the shipped splay.
    let server = await serve(s, target, true, "off");
    console.log(`${target}: ${(await server.log()).match(/^seed ok.*$/m)?.[0] ?? "started"}`);
    try {
      for (const scenario of list("SCENARIOS", "cached,uncached,insert,increment1000,increment1,action,mix"))
        for (const vus of list("VUS", "8,32,128"))
          for (let r = 1; r <= repeats; r++) {
            const m = await http(s, target, scenario, vus);
            console.log(
              `${target} ${scenario} vus=${vus} #${r}: ${Math.round(m.rate)} req/s, errors ${m.errors.toFixed(3)}, ` +
                `p99 ${m.p99.toFixed(1)} ms, server ${m.serverCores.toFixed(2)} cores, db ${m.dbCores.toFixed(2)}, ` +
                `load ${m.loadCores.toFixed(2)}`,
            );
            results.push({ ...m, repeat: r } as Result);
          }
      for (const splay of ["off", "on"] as const) {
        if (splay === "on") {
          await server.stop();
          server = await serve(s, target, false, "on");
        }
        for (const n of list("FANOUT", "100,1000,5000,10000")) {
          const m = await fanout(s, target, n, splay).catch((e: Error) => ({
            kind: "fanout" as const,
            target,
            splay,
            n: Number(n),
            failed: e.message.slice(-500),
          }));
          console.log(`${target} fan-out splay=${splay} n=${n}: ${JSON.stringify(m)}`);
          results.push(m as Result);
        }
      }
    } finally {
      await server.stop();
    }
  }
  await write(s, sha, repeats, results);
}

async function write(s: State, sha: string, repeats: number, results: Result[]) {
  const [serverInfo, dbInfo, loadInfo] = await Promise.all([machine(s.server), machine(s.db), machine(s.load)]);
  const k6 = (await ssh(s.load, "k6 version | head -1")).trim();
  const pg = (await ssh(s.db, "docker exec bench-pg postgres --version")).trim();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const out = `${root}/bench/results/cloud/${stamp}-versus-${sha}`;
  mkdirSync(out, { recursive: true });
  // Public addresses are not committed.
  const box = (b: Box, m: string[]) => ({ ...b, public: "stripped", machine: m });
  const meta = {
    suite: "versus",
    sha,
    bun: Bun.version,
    k6,
    postgres: pg,
    convex: CONVEX_RELEASE,
    server: box(s.server, serverInfo),
    db: box(s.db, dbInfo),
    load: box(s.load, loadInfo),
    env: { REGION: process.env.REGION ?? "sfo2", DURATION: process.env.DURATION ?? "20s", REPEATS: repeats },
  };
  writeFileSync(`${out}/results.json`, `${JSON.stringify({ meta, results }, null, 2)}\n`);
  writeFileSync(`${out}/summary.md`, summary(meta, results));
  await sh(["bunx", "biome", "format", "--write", `${out}/results.json`]);
  console.log(`\n${summary(meta, results)}\nwritten to ${out}`);
}

function summary(
  meta: {
    sha: string;
    convex: string;
    server: { machine: string[] };
    db: { machine: string[] };
    load: { machine: string[] };
  },
  results: Result[],
) {
  const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const targets = [...new Set(results.map((r) => r.target))];
  const httpRows = results.filter((r) => r.kind === "http") as Awaited<ReturnType<typeof http>>[];
  const lines = [
    `# versus at ${meta.sha}: Convex ${meta.convex} and bunvex, each on Postgres on its own droplet`,
    "",
    `server ${meta.server.machine[0]} vCPUs (${meta.server.machine[1]}), db ${meta.db.machine[0]} vCPUs ` +
      `(${meta.db.machine[1]}), load ${meta.load.machine[0]} vCPUs (${meta.load.machine[1]})`,
    "",
    "## HTTP: best of the VU counts (median of the repeats), req/s · p99 ms · server cores · db cores",
    "",
    `| scenario | ${targets.join(" | ")} |`,
    `|---|${targets.map(() => "--:|").join("")}`,
  ];
  for (const scenario of [...new Set(httpRows.map((r) => r.scenario))]) {
    const cells = targets.map((target) => {
      const points = Map.groupBy(
        httpRows.filter((r) => r.target === target && r.scenario === scenario),
        (r) => r.vus,
      );
      const best = [...points.values()]
        .map((g) => ({
          vus: g[0]!.vus,
          rate: median(g.map((r) => r.rate)),
          p99: median(g.map((r) => r.p99)),
          cores: median(g.map((r) => r.serverCores)),
          db: median(g.map((r) => r.dbCores)),
          errors: Math.max(...g.map((r) => r.errors)),
        }))
        .toSorted((a, b) => b.rate - a.rate)[0];
      if (!best) return "–";
      return (
        `${Math.round(best.rate)}${best.errors > 0.01 ? " ⚠" : ""} · ${best.p99.toFixed(0)} · ` +
        `${best.cores.toFixed(2)} · ${best.db.toFixed(2)} (${best.vus} VUs)`
      );
    });
    lines.push(`| ${scenario} | ${cells.join(" | ")} |`);
  }
  lines.push("", "⚠ = more than 1 % errors.");
  for (const splay of ["off", "on"]) {
    const rows = results.filter((r) => r.kind === "fanout" && r.splay === splay) as (Result &
      Record<string, unknown>)[];
    if (rows.length === 0) continue;
    lines.push(
      "",
      `## Fan-out, splay ${splay === "off" ? "off (SUBSCRIPTION_INVALIDATION_DELAY_MULTIPLIER=0)" : "on (shipped)"}: delivered · p99 delivery · server RSS`,
      "",
      `| subscribers | ${targets.join(" | ")} |`,
      `|--:|${targets.map(() => "--:|").join("")}`,
    );
    for (const n of [...new Set(rows.map((r) => r.n as number))]) {
      const cells = targets.map((target) => {
        const r = rows.find((x) => x.target === target && x.n === n);
        if (!r) return "–";
        if (r.failed) return "failed";
        const p99 = r.p99 as number | null;
        return `${((r.delivered as number) * 100).toFixed(0)} % · ${p99 === null ? "–" : p99 >= 1000 ? `${(p99 / 1000).toFixed(2)} s` : `${p99} ms`} · ${Math.round(r.rssMb as number)} MB`;
      });
      lines.push(`| ${n} | ${cells.join(" | ")} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

const sha = async () => (await sh(["git", "-C", root, "rev-parse", "--short", "HEAD"])).trim();
const [command = "status", ...args] = process.argv.slice(2);
switch (command) {
  case "up":
    await up();
    break;
  case "sync":
    await sync();
    break;
  case "run":
    await runAll(await sha());
    break;
  case "down":
    if (args[0] === "all") throw new Error("versus.ts destroys only its own run's droplets: use cloud.ts down all");
    await down();
    break;
  case "status":
    await status();
    break;
  case "all": {
    let interrupted = false;
    process.once("SIGINT", () => {
      interrupted = true;
      console.log("\ninterrupted: destroying the droplets …");
      down().finally(() => process.exit(130));
    });
    try {
      await up();
      await runAll(await sync());
    } finally {
      if (!interrupted && !process.env.KEEP) await down();
    }
    break;
  }
  default:
    throw new Error(`unknown command ${command}`);
}

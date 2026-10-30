// The cloud bench: rents two DigitalOcean droplets by the hour (a server box and a load box, CPU-Optimized, in one
// region's private network), runs a suite of bench/load/k6.js scenarios against bench/server.ts, writes the
// results to bench/results/cloud/, and destroys the droplets. Needs `doctl` logged in (`doctl auth init`) and
// ~/.ssh/id_ed25519.pub, which is registered on the account the first time.
//   bun bench/cloud/cloud.ts all single   up, sync, run the suite, down (down also on failure or Ctrl-C)
//   bun bench/cloud/cloud.ts up | sync | run <suite> | down [all] | status
// RUN=<name> keeps a run's droplets (tag bunvex-bench-<name>) and state apart from another session's: `down`
// destroys only its own run's droplets, `down all` every bench droplet. `status` lists every run's.
//   bun bench/cloud/cloud.ts use <server-ip> [<load-ip>]   existing boxes instead of droplets (down skips them)
// Suites: quick, single (one server: sqlite and postgres, 4 scenarios), independent (1-4 servers, sqlite).
// PERSISTENCES, NS and SCENARIOS (comma-separated) override a suite's matrix.
// Env: RUN (default), SERVER_SIZE (c-8), LOAD_SIZE (c-8), REGION (nyc3), VUS (32 per server), DURATION (30s), REPEATS (3),
// KEEP=1 (all: leave the droplets up).
import { mkdirSync, writeFileSync } from "node:fs";
import { type Box, cpu as cpuOf, root, runOf, sh, status } from "./boxes.ts";

type State = { server: Box; load: Box; createdAt: string; droplets: boolean };
// Each run has its own name (RUN, default "default"), droplet tag and state (boxes.ts).
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
} = runOf<State>(process.env.RUN ?? "default");
const remote = "/root/bunvex";

async function up() {
  if (await Bun.file(stateFile).exists()) throw new Error(`boxes already up (${stateFile}): run \`down\` first`);
  const region = process.env.REGION ?? "nyc3";
  const key = await sshKeyFingerprint();
  console.log(`creating droplets in ${region} …`);
  const [server, load] = await Promise.all([
    createDroplet(`${runTag}-server`, process.env.SERVER_SIZE ?? "c-8", region, key),
    createDroplet(`${runTag}-load`, process.env.LOAD_SIZE ?? "c-8", region, key),
  ]);
  writeState({ server, load, createdAt: new Date().toISOString(), droplets: true });
  const hourly = (server.hourly ?? 0) + (load.hourly ?? 0);
  console.log(`server ${server.public} (${server.private}), load ${load.public} (${load.private}); $${hourly}/h`);
  await Promise.all([provision(server), provision(load)]);
}

async function use(serverIp: string, loadIp?: string) {
  const server = { name: "server", public: serverIp, private: serverIp };
  const load = loadIp ? { name: "load", public: loadIp, private: loadIp } : server;
  writeState({ server, load, createdAt: new Date().toISOString(), droplets: false });
  await Promise.all([...new Set([server, load])].map(provision));
}

async function sync(): Promise<string> {
  const s = readState();
  return boxes.sync([s.server, s.load]);
}

type Point = { persistence: string; n: number; scenario: string };
const list = (name: string, fallback: string[]) => process.env[name]?.split(",").filter(Boolean) ?? fallback;
function matrix(suite: string): Point[] {
  const base: Record<string, { persistences: string[]; ns: string[]; scenarios: string[] }> = {
    quick: { persistences: ["sqlite"], ns: ["1"], scenarios: ["cached"] },
    single: {
      persistences: ["sqlite", "postgres"],
      ns: ["1"],
      scenarios: ["cached", "uncached", "insert", "increment1000"],
    },
    independent: { persistences: ["sqlite"], ns: ["1", "2", "3", "4"], scenarios: ["cached", "uncached", "insert"] },
  };
  const m = base[suite];
  if (!m) throw new Error(`unknown suite ${suite}: ${Object.keys(base).join(", ")}`);
  const points: Point[] = [];
  for (const persistence of list("PERSISTENCES", m.persistences))
    for (const n of list("NS", m.ns))
      for (const scenario of list("SCENARIOS", m.scenarios)) points.push({ persistence, n: Number(n), scenario });
  return points;
}

async function measure(s: State, p: Point) {
  const env = `N=${p.n} PERSISTENCE=${p.persistence} HOST=${s.server.private}`;
  const pid = (
    await ssh(s.server, `cd ${remote} && (${env} nohup bun bench/cloud/serve.ts >/root/serve.log 2>&1 & echo $!)`)
  ).trim();
  try {
    let ports = "";
    for (let i = 0; !ports; i++) {
      const log = await ssh(s.server, "cat /root/serve.log");
      ports = /^READY (.+)$/m.exec(log)?.[1] ?? "";
      if (!ports && (i > 600 || !(await ssh(s.server, `kill -0 ${pid} && echo up || true`)).includes("up")))
        throw new Error(`serve.ts did not start:\n${log.slice(-3000)}`);
      if (!ports) await Bun.sleep(1000);
    }
    const [before, loadBefore] = await Promise.all([cpuOf(ssh, s.server), cpuOf(ssh, s.load)]);
    const vus = process.env.VUS ?? "32";
    const duration = process.env.DURATION ?? "30s";
    const out = await ssh(
      s.load,
      `ulimit -n 1048576; cd ${remote} && TARGET=${s.server.private} PORTS=${ports} SCENARIO=${p.scenario} ` +
        `VUS=${vus} DURATION=${duration} bun bench/cloud/load.ts`,
    );
    const [after, loadAfter] = await Promise.all([cpuOf(ssh, s.server), cpuOf(ssh, s.load)]);
    const seconds = (after.at - before.at) / 1000;
    const servers = JSON.parse(out.trim().split("\n").at(-1)!) as { rate: number; errors: number; p99: number }[];
    return {
      ...p,
      vus: Number(vus),
      duration,
      rate: servers.reduce((sum, r) => sum + r.rate * (1 - r.errors), 0),
      errors: Math.max(...servers.map((r) => r.errors)),
      p99: Math.max(...servers.map((r) => r.p99)),
      serverCores: (after.servers - before.servers) / seconds,
      boxCores: (after.box - before.box) / seconds,
      // The load box's busy cores: near its vCPU count means k6, not the server, set the rate.
      loadCores: (loadAfter.box - loadBefore.box) / seconds,
      servers,
    };
  } finally {
    await ssh(s.server, `kill -INT ${pid}; while kill -0 ${pid} 2>/dev/null; do sleep 0.2; done`);
  }
}

async function runSuite(suite: string, sha: string) {
  const s = readState();
  const repeats = Number(process.env.REPEATS ?? 3);
  const points = matrix(suite);
  const results = [];
  for (const p of points)
    for (let r = 1; r <= repeats; r++) {
      const m = await measure(s, p);
      console.log(
        `${p.persistence} n=${p.n} ${p.scenario} #${r}: ${Math.round(m.rate)} req/s, errors ${m.errors.toFixed(3)}, ` +
          `p99 ${m.p99.toFixed(1)} ms, servers ${m.serverCores.toFixed(2)} cores, box ${m.boxCores.toFixed(2)}, ` +
          `load box ${m.loadCores.toFixed(2)}`,
      );
      results.push({ ...m, repeat: r });
    }
  const [serverInfo, loadInfo] = await Promise.all([machine(s.server), machine(s.load)]);
  const k6 = (await ssh(s.load, "k6 version | head -1")).trim();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const out = `${root}/bench/results/cloud/${stamp}-${suite}-${sha}`;
  mkdirSync(out, { recursive: true });
  const env = { REGION: process.env.REGION, VUS: process.env.VUS, DURATION: process.env.DURATION, REPEATS: repeats };
  const meta = {
    suite,
    sha,
    bun: Bun.version,
    k6,
    server: { ...s.server, machine: serverInfo },
    load: { ...s.load, machine: loadInfo },
    env,
  };
  writeFileSync(`${out}/results.json`, `${JSON.stringify({ meta, results }, null, 2)}\n`);
  writeFileSync(`${out}/summary.md`, summary(meta, results));
  // In the repo's JSON style, so the results can be committed as they are.
  await sh(["bunx", "biome", "format", "--write", `${out}/results.json`]);
  console.log(`\n${summary(meta, results)}\nwritten to ${out}`);
}

type Result = Awaited<ReturnType<typeof measure>>;
function summary(meta: { suite: string; sha: string; server: { machine: string[] } }, results: Result[]) {
  const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const groups = Map.groupBy(results, (r) => `${r.persistence}|${r.n}|${r.scenario}`);
  const rows = [...groups.values()].map((g) => {
    const rates = g.map((r) => r.rate);
    const [first] = g;
    return (
      `| ${first!.persistence} | ${first!.n} | ${first!.scenario} | ${Math.round(median(rates))} | ` +
      `${Math.round(Math.min(...rates))}–${Math.round(Math.max(...rates))} | ${median(g.map((r) => r.p99)).toFixed(1)} | ` +
      `${median(g.map((r) => r.serverCores)).toFixed(2)} | ${median(g.map((r) => r.boxCores)).toFixed(2)} | ${median(g.map((r) => r.loadCores)).toFixed(2)} | ` +
      `${Math.max(...g.map((r) => r.errors)).toFixed(3)} |`
    );
  });
  const [cores, model] = meta.server.machine;
  return [
    `# ${meta.suite} at ${meta.sha}: server ${cores} vCPUs, ${model}`,
    "",
    "| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |",
    "|---|---:|---|---:|---:|---:|---:|---:|---:|---:|",
    ...rows,
    "",
  ].join("\n");
}

const [command = "status", ...args] = process.argv.slice(2);
switch (command) {
  case "up":
    await up();
    break;
  case "use":
    if (!args[0]) throw new Error("use <server-ip> [<load-ip>]");
    await use(args[0], args[1]);
    break;
  case "sync":
    await sync();
    break;
  case "run":
    await runSuite(args[0] ?? "quick", (await sh(["git", "-C", root, "rev-parse", "--short", "HEAD"])).trim());
    break;
  case "down":
    await down(args[0] === "all");
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
      await runSuite(args[0] ?? "quick", await sync());
    } finally {
      if (!interrupted && !process.env.KEEP) await down();
    }
    break;
  }
  default:
    throw new Error(`unknown command ${command}`);
}

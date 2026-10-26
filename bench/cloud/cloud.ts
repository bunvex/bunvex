// The cloud bench: rents two DigitalOcean droplets by the hour (a server box and a load box, CPU-Optimized, in one
// region's private network), runs a suite of bench/load/k6.js scenarios against bench/server.ts, writes the
// results to bench/results/cloud/, and destroys the droplets. Needs `doctl` logged in (`doctl auth init`) and
// ~/.ssh/id_ed25519.pub, which is registered on the account the first time.
//   bun bench/cloud/cloud.ts all single   up, sync, run the suite, down (down also on failure or Ctrl-C)
//   bun bench/cloud/cloud.ts up | sync | run <suite> | down | status
//   bun bench/cloud/cloud.ts use <server-ip> [<load-ip>]   existing boxes instead of droplets (down skips them)
// Suites: quick, single (one server: sqlite and postgres, 4 scenarios), independent (1-4 servers, sqlite).
// PERSISTENCES, NS and SCENARIOS (comma-separated) override a suite's matrix.
// Env: SERVER_SIZE (c-8), LOAD_SIZE (c-8), REGION (nyc3), VUS (32 per server), DURATION (30s), REPEATS (3),
// KEEP=1 (all: leave the droplets up).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const root = Bun.fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const dir = `${root}/.data/cloud`;
const stateFile = `${dir}/state.json`;
const knownHosts = `${dir}/known_hosts`;
const TAG = "bunvex-bench";
const remote = "/root/bunvex";

type Box = { name: string; id?: number; public: string; private: string; size?: string; hourly?: number };
type State = { server: Box; load: Box; createdAt: string; droplets: boolean };

async function sh(cmd: string[], input?: string | Blob): Promise<string> {
  const proc = Bun.spawn(cmd, { stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (input !== undefined && proc.stdin) {
    proc.stdin.write(typeof input === "string" ? input : await input.arrayBuffer());
    proc.stdin.end();
  }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.slice(0, 4).join(" ")} … exited with ${code}: ${(err || out).slice(-3000)}`);
  return out;
}
const sshArgs = (box: Box) => [
  "ssh",
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  `UserKnownHostsFile=${knownHosts}`,
  "-o",
  "ConnectTimeout=10",
  `root@${box.public}`,
];
const ssh = (box: Box, command: string, input?: string | Blob) => sh([...sshArgs(box), command], input);

function readState(): State {
  if (!existsSync(stateFile)) throw new Error("no boxes: run `up` (or `use`) first");
  return JSON.parse(readFileSync(stateFile, "utf8"));
}
function writeState(s: State) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(s, null, 2)}\n`);
}

async function sshKeyFingerprint(): Promise<string> {
  const pub = `${homedir()}/.ssh/id_ed25519.pub`;
  const fingerprint = (await sh(["ssh-keygen", "-l", "-E", "md5", "-f", pub])).split(" ")[1]!.replace(/^MD5:/, "");
  const known = await sh(["doctl", "compute", "ssh-key", "list", "--format", "FingerPrint", "--no-header"]);
  if (!known.split("\n").some((l) => l.trim() === fingerprint))
    await sh(["doctl", "compute", "ssh-key", "import", TAG, "--public-key-file", pub]);
  return fingerprint;
}

async function createDroplet(name: string, size: string, region: string, key: string): Promise<Box> {
  const out = await sh(
    ["doctl", "compute", "droplet", "create", name, "--size", size, "--region", region].concat([
      "--image",
      "ubuntu-24-04-x64",
      "--ssh-keys",
      key,
      "--tag-names",
      TAG,
      "--wait",
      "--output",
      "json",
    ]),
  );
  const d = JSON.parse(out)[0];
  const ip = (type: string) => d.networks.v4.find((n: { type: string }) => n.type === type)?.ip_address as string;
  return { name, id: d.id, public: ip("public"), private: ip("private"), size, hourly: d.size?.price_hourly };
}

async function waitForSsh(box: Box) {
  for (let i = 0; i < 60; i++) {
    try {
      await ssh(box, "true");
      return;
    } catch {
      await Bun.sleep(5000);
    }
  }
  throw new Error(`no ssh on ${box.name} (${box.public})`);
}

async function provision(box: Box) {
  await waitForSsh(box);
  const version = Bun.version;
  const out = await ssh(box, `bash -s ${version}`, Bun.file(`${import.meta.dir}/provision.sh`));
  console.log(`${box.name}: ${out.trim().split("\n").at(-1)}`);
}

async function up() {
  if (existsSync(stateFile)) throw new Error(`boxes already up (${stateFile}): run \`down\` first`);
  const region = process.env.REGION ?? "nyc3";
  const key = await sshKeyFingerprint();
  console.log(`creating droplets in ${region} …`);
  const [server, load] = await Promise.all([
    createDroplet(`${TAG}-server`, process.env.SERVER_SIZE ?? "c-8", region, key),
    createDroplet(`${TAG}-load`, process.env.LOAD_SIZE ?? "c-8", region, key),
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

async function down() {
  if (existsSync(stateFile) && !readState().droplets) {
    console.log("existing boxes (`use`): nothing to destroy");
  } else {
    // By tag, so a droplet a crashed run left behind goes too.
    await sh(["doctl", "compute", "droplet", "delete", "--tag-name", TAG, "--force"]);
    console.log(`destroyed every droplet tagged ${TAG}`);
  }
  rmSync(stateFile, { force: true });
  rmSync(knownHosts, { force: true });
}

async function status() {
  const out = await sh(["doctl", "compute", "droplet", "list", "--tag-name", TAG, "--output", "json"]);
  const droplets = JSON.parse(out || "[]") as { name: string; created_at: string; size: { price_hourly: number } }[];
  if (droplets.length === 0) console.log(`no droplets tagged ${TAG}`);
  for (const d of droplets) {
    const hours = (Date.now() - Date.parse(d.created_at)) / 3_600_000;
    console.log(`${d.name}: up ${hours.toFixed(1)} h, about $${(Math.ceil(hours) * d.size.price_hourly).toFixed(2)}`);
  }
}

/** The committed tree at HEAD (not the working copy), so a result always names the commit it measured. */
async function sync(): Promise<string> {
  const s = readState();
  const sha = (await sh(["git", "-C", root, "rev-parse", "--short", "HEAD"])).trim();
  if ((await sh(["git", "-C", root, "status", "--porcelain", "--untracked-files=no"])).trim())
    console.warn("the working tree has changes: the boxes get HEAD, without them");
  const archive = Bun.spawnSync(["git", "-C", root, "archive", "--format=tar", "HEAD"]).stdout;
  for (const box of new Set([s.server, s.load]))
    await ssh(
      box,
      `rm -rf ${remote} && mkdir -p ${remote} && tar -x -C ${remote} && cd ${remote} && bun install --frozen-lockfile >/dev/null`,
      new Blob([archive]),
    );
  console.log(`synced ${sha}`);
  return sha;
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

/** CPU seconds: the whole box (busy jiffies, every core) and the bench servers' processes. */
async function cpu(box: Box) {
  const out = await ssh(
    box,
    "head -1 /proc/stat; getconf CLK_TCK; for p in $(cat /root/bench-data/pids 2>/dev/null); do cat /proc/$p/stat; done",
  );
  const [stat, tick, ...procs] = out.trim().split("\n");
  const hz = Number(tick);
  const f = stat!.trim().split(/\s+/).slice(1).map(Number);
  const box_ = (f.reduce((a, b) => a + b, 0) - f[3]! - f[4]!) / hz;
  // utime and stime are fields 14 and 15; count from after the `(comm)` field, which may contain spaces.
  const servers = procs.reduce((sum, line) => {
    const rest = line.slice(line.lastIndexOf(")") + 2).split(" ");
    return sum + (Number(rest[11]) + Number(rest[12])) / hz;
  }, 0);
  return { box: box_, servers, at: performance.now() };
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
    const [before, loadBefore] = await Promise.all([cpu(s.server), cpu(s.load)]);
    const vus = process.env.VUS ?? "32";
    const duration = process.env.DURATION ?? "30s";
    const out = await ssh(
      s.load,
      `ulimit -n 1048576; cd ${remote} && TARGET=${s.server.private} PORTS=${ports} SCENARIO=${p.scenario} ` +
        `VUS=${vus} DURATION=${duration} bun bench/cloud/load.ts`,
    );
    const [after, loadAfter] = await Promise.all([cpu(s.server), cpu(s.load)]);
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

async function machine(box: Box) {
  return (
    await ssh(
      box,
      "nproc; grep -m1 'model name' /proc/cpuinfo | cut -d: -f2; free -g | awk '/Mem:/{print $2}'; uname -r",
    )
  )
    .trim()
    .split("\n")
    .map((l) => l.trim());
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
      await runSuite(args[0] ?? "quick", await sync());
    } finally {
      if (!interrupted && !process.env.KEEP) await down();
    }
    break;
  }
  default:
    throw new Error(`unknown command ${command}`);
}

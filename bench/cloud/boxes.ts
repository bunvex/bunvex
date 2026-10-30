// bench/cloud: the DigitalOcean droplets and ssh both cloud benches use (cloud.ts, versus.ts). A run (RUN) has its own
// droplet tag and state directory, so two sessions benchmarking at the same time never destroy each other's droplets;
// every droplet also carries TAG, for `status` and `down all`.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

export const root = Bun.fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
export const TAG = "bunvex-bench";
export const remote = "/root/bunvex";

export type Box = { name: string; id?: number; public: string; private: string; size?: string; hourly?: number };

export async function sh(cmd: string[], input?: string | Blob): Promise<string> {
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

/** One run's droplets, ssh and state file; `State` is what the bench keeps about its boxes. */
export function runOf<State extends { droplets: boolean }>(run: string) {
  if (!/^[a-z0-9-]+$/.test(run)) throw new Error(`RUN=${run}: lowercase letters, digits and - only`);
  const runTag = `${TAG}-${run}`;
  const dir = `${root}/.data/cloud/${run}`;
  const stateFile = `${dir}/state.json`;
  const knownHosts = `${dir}/known_hosts`;

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
        `${TAG},${runTag}`,
        "--wait",
        "--output",
        "json",
      ]),
    );
    const created = JSON.parse(out)[0];
    if (!created?.id) throw new Error(`creating ${name}: ${out.slice(0, 2000)}`);
    // `--wait` can answer before the addresses are assigned: read the droplet again until both are there.
    let d = created;
    for (let i = 0; !(d.networks?.v4 ?? []).some((n: { type: string }) => n.type === "private"); i++) {
      if (i === 60) throw new Error(`${name} got no addresses`);
      await Bun.sleep(5000);
      d = JSON.parse(await sh(["doctl", "compute", "droplet", "get", String(created.id), "--output", "json"]))[0];
    }
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

  async function down(all = false) {
    // `down all` destroys every bench droplet, every run's: for one a crashed session left behind.
    const tag = all ? TAG : runTag;
    if (!all && existsSync(stateFile) && !readState().droplets) {
      console.log("existing boxes (`use`): nothing to destroy");
    } else {
      // By tag, so a droplet a crashed run left behind goes too.
      await sh(["doctl", "compute", "droplet", "delete", "--tag-name", tag, "--force"]);
      console.log(`destroyed every droplet tagged ${tag}`);
    }
    rmSync(stateFile, { force: true });
    rmSync(knownHosts, { force: true });
  }

  /** The committed tree at HEAD (not the working copy), so a result always names the commit it measured. */
  async function sync(boxes: Box[]): Promise<string> {
    const sha = (await sh(["git", "-C", root, "rev-parse", "--short", "HEAD"])).trim();
    if ((await sh(["git", "-C", root, "status", "--porcelain", "--untracked-files=no"])).trim())
      console.warn("the working tree has changes: the boxes get HEAD, without them");
    const archive = Bun.spawnSync(["git", "-C", root, "archive", "--format=tar", "HEAD"]).stdout;
    for (const box of new Set(boxes))
      await ssh(
        box,
        `rm -rf ${remote} && mkdir -p ${remote} && tar -x -C ${remote} && cd ${remote} && bun install --frozen-lockfile >/dev/null`,
        new Blob([archive]),
      );
    console.log(`synced ${sha}`);
    return sha;
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

  return {
    runTag,
    stateFile,
    ssh,
    readState,
    writeState,
    sshKeyFingerprint,
    createDroplet,
    provision,
    down,
    sync,
    machine,
  };
}

export async function status() {
  const out = await sh(["doctl", "compute", "droplet", "list", "--tag-name", TAG, "--output", "json"]);
  const droplets = JSON.parse(out || "[]") as { name: string; created_at: string; size: { price_hourly: number } }[];
  if (droplets.length === 0) console.log(`no droplets tagged ${TAG}`);
  for (const d of droplets) {
    const hours = (Date.now() - Date.parse(d.created_at)) / 3_600_000;
    console.log(`${d.name}: up ${hours.toFixed(1)} h, about $${(Math.ceil(hours) * d.size.price_hourly).toFixed(2)}`);
  }
}

/** CPU seconds on a box: the whole box (busy jiffies, every core) and the processes whose pids `pids` lists. */
export async function cpu(ssh: (box: Box, cmd: string) => Promise<string>, box: Box, pids = "/root/bench-data/pids") {
  const out = await ssh(
    box,
    `head -1 /proc/stat; getconf CLK_TCK; for p in $(cat ${pids} 2>/dev/null); do cat /proc/$p/stat; done`,
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

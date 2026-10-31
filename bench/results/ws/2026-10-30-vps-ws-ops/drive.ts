// The driver of this run, as it ran on the VPS (paths are that box's: bunvex at /root/wsbench/bunvex, Convex's backend
// and app beside it, Postgres 17 on 127.0.0.1:5432). For each target it starts the server on the local Postgres
// (versus-serve.ts, fresh and seeded), then runs ws-ops.ts points and samples the server's and the box's CPU over each
// point's measured window. results.jsonl is its output; close-reasons.jsonl is a second run of the three points where
// connections were closed, after ws-ops.ts learned to record why.
//   TARGETS=convex,bunvex PLAN=scenario:conns:repeats,… SECS=10 bun drive.ts
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const root = "/root/wsbench/bunvex";
const out = "/root/wsbench/results.jsonl";
const targets = (process.env.TARGETS ?? "convex,bunvex").split(",");
const plan = (
  process.env.PLAN ??
  "insert:64:3,insert:512:3,increment:64:3,increment:512:3,query-cached:64:3,query-cached:512:3,query-uncached:64:3,query-uncached:512:3,chat:64:3,chat:512:3,chat:2048:1"
).split(",");
const secs = process.env.SECS ?? "10";

type Sample = { t: number; ticks: number; busy: number };
const ticksOf = (pid: number) => {
  const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ");
  return Number(f[11]) + Number(f[12]); // utime, stime
};
const busyOf = () => {
  const f = readFileSync("/proc/stat", "utf8").split("\n")[0]!.split(/\s+/).slice(1).map(Number);
  const total = f.slice(0, 8).reduce((a, b) => a + b, 0);
  return total - f[3]! - f[4]!; // minus idle and iowait
};

for (const target of targets) {
  const log = `/root/wsbench/serve-${target}.log`;
  writeFileSync(log, "");
  const server = Bun.spawn(["bun", "bench/cloud/versus-serve.ts"], {
    cwd: root,
    env: {
      ...process.env,
      TARGET: target,
      FRESH: "1",
      SPLAY: "off",
      HOST: "127.0.0.1",
      DB_URL: "postgres://postgres:bench@127.0.0.1:5432",
      DATA: "/root/wsbench/data",
      CONVEX_BIN: "/root/wsbench/convex-backend/convex-local-backend",
      CONVEX_APP: "/root/wsbench/convex-app",
    },
    stdout: Bun.file(log),
    stderr: Bun.file(log),
  });
  for (let i = 0; ; i++) {
    const text = readFileSync(log, "utf8");
    if (/^READY /m.test(text)) break;
    if (server.exitCode !== null || i > 600) throw new Error(`${target} did not start:\n${text.slice(-3000)}`);
    await Bun.sleep(1000);
  }
  console.log(`${target}: ${readFileSync(log, "utf8").match(/^seed ok.*$/m)?.[0]}`);
  const pid = Number(readFileSync("/root/wsbench/data/pids", "utf8"));

  for (const point of plan) {
    const [scenario, conns, repeats] = point.split(":") as [string, string, string];
    for (let r = 1; r <= Number(repeats); r++) {
      const samples: Sample[] = [];
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          samples.push({ t: Date.now(), ticks: ticksOf(pid), busy: busyOf() });
          await Bun.sleep(100);
        }
      })();
      const proc = Bun.spawn(["bun", "bench/cloud/ws-ops.ts"], {
        cwd: root,
        env: {
          ...process.env,
          LABEL: target,
          TARGET_URL: "http://127.0.0.1:3210",
          SCENARIO: scenario,
          CONNS: conns,
          SECS: secs,
          WARMUP: "3",
          PROCS: "2",
        },
        stdout: "pipe",
        stderr: "inherit",
      });
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      sampling = false;
      await sampler;
      let row: Record<string, unknown>;
      try {
        const m = JSON.parse(text.trim().split("\n").at(-1)!) as { windowStart: number; windowEnd: number };
        const at = (t: number) => samples.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
        const a = at(m.windowStart);
        const b = at(m.windowEnd);
        const dt = (b.t - a.t) / 1000;
        row = {
          ...m,
          repeat: r,
          serverCores: Number(((b.ticks - a.ticks) / 100 / dt).toFixed(2)),
          boxCores: Number(((b.busy - a.busy) / 100 / dt).toFixed(2)),
        };
      } catch (e) {
        row = {
          label: target,
          scenario,
          conns: Number(conns),
          repeat: r,
          failed: `${(e as Error).message}: ${text.slice(-300)}`,
        };
      }
      appendFileSync(out, `${JSON.stringify(row)}\n`);
      console.log(JSON.stringify(row));
      await Bun.sleep(2000);
    }
  }
  server.kill("SIGINT");
  await server.exited;
  await Bun.sleep(3000);
}
console.log("done");

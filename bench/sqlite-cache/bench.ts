// STUDY-174 Q6: does SQLite's default page cache (Convex's: no pragma, 2 000 KiB) read slower than the 256 MiB
// bunvex set, on a store the OS page cache cannot hold? The real local backend (packages/bunvex/bin/local-backend.ts,
// on SQLite) serves the app of ./app; a closed-loop driver sends point gets by id, index range reads and paginated
// queries over HTTP, and records each call's latency, the throughput and the backend's memory.
//
// It runs on a patched copy of the repository (./patch-backend.ts), whose store reads `cache_size` from
// BENCH_SQLITE_CACHE_KIB. Linux only for `run`: the backend runs in a transient systemd scope with `MemoryMax`, which
// counts the OS page cache the backend's reads fill too, and the OS page cache is dropped before every run.
//
//   bun bench/sqlite-cache/bench.ts seed --state <dir> --docs 5000000
//   bun bench/sqlite-cache/bench.ts run --state <dir> --cache 262144|default --memory-max 2G --mode uniform|hot \
//     --warmup 60 --seconds 180 --concurrency 16 --out <file.json>
//
// The store under <dir> is seeded once and reused by every run: the reads write nothing.

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BunvexHttpClient } from "bunvex/browser";
import { anyApi } from "bunvex/server";

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    state: { type: "string" },
    docs: { type: "string", default: "5000000" },
    batch: { type: "string", default: "4000" },
    cache: { type: "string", default: "default" }, // KiB, or "default": no pragma
    "memory-max": { type: "string", default: "" }, // systemd's MemoryMax, e.g. 2G; empty: no limit
    mode: { type: "string", default: "uniform" }, // uniform: every group; hot: HOT_GROUPS of them
    warmup: { type: "string", default: "60" },
    seconds: { type: "string", default: "180" },
    concurrency: { type: "string", default: "16" },
    out: { type: "string" },
    label: { type: "string", default: "" },
  },
});
const cmd = positionals[0];
const STATE = resolve(flags.state ?? ".data/sqlite-cache");
const ROOT = resolve(import.meta.dir, "../..");
const BACKEND = join(ROOT, "packages/bunvex/bin/local-backend.ts");
const CLI = join(ROOT, "packages/bunvex/bin/bunvex.ts");
const api = anyApi;
const GROUPS = 1000;
/** The hot set: 20 of the 1 000 groups, ~2 % of the store (on 5 M documents ~120 MB of rows and index). */
const HOT_GROUPS = 20;
const NAME = "bunvex-sqlite-cache";
/** Coprime with GROUPS, so the sampled ids cover every group. */
const SAMPLE_EVERY = 49;
const MB = 2 ** 20;

async function exec(argv: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
  const p = Bun.spawn(argv, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) throw new Error(`${argv.join(" ")} failed:\n${out}\n${err}`);
  return out;
}

type Meta = { secret: string; port: number; docs: number; seededAt: string; seedSeconds: number };

/** Starts the backend on the store of STATE (in a systemd scope when `memoryMax` is set); resolves once it answers. */
async function startBackend(meta: Meta, env: Record<string, string>, memoryMax: string) {
  const t0 = performance.now();
  const argv = [
    process.execPath,
    BACKEND,
    "--port",
    String(meta.port),
    "--site-proxy-port",
    String(meta.port + 1),
    "--instance-name",
    NAME,
    "--local-storage",
    join(STATE, "storage"),
    join(STATE, "backend.sqlite3"),
  ];
  const wrapped = memoryMax
    ? ["systemd-run", "--scope", "--quiet", "-p", `MemoryMax=${memoryMax}`, "-p", "MemorySwapMax=0", "--", ...argv]
    : argv;
  const proc = Bun.spawn(wrapped, {
    cwd: STATE,
    env: { ...process.env, INSTANCE_SECRET: meta.secret, ...env },
    stdout: "ignore",
    stderr: "pipe",
  });
  let stderr = "";
  (async () => {
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) stderr += new TextDecoder().decode(chunk);
  })();
  const url = `http://127.0.0.1:${meta.port}`;
  for (;;) {
    const answer = await fetch(`${url}/instance_name`)
      .then((r) => r.text())
      .catch(() => null);
    if (answer === NAME) break;
    // The start reads the table summaries' checkpoint and the log since (STUDY-72): `settle` keeps that short.
    if (proc.exitCode !== null || performance.now() - t0 > 30 * 60_000) {
      proc.kill("SIGTERM");
      await proc.exited;
      throw new Error(`the backend did not start:\n${stderr}`);
    }
    await Bun.sleep(100);
  }
  const stop = async () => {
    proc.kill("SIGTERM");
    await proc.exited;
  };
  return { proc, url, stop, stderr: () => stderr, startSeconds: (performance.now() - t0) / 1000 };
}

/** The ts of the table summaries' checkpoint, and of the store's newest document. */
function checkpointLag(): { checkpoint: bigint; head: bigint } {
  const db = new Database(join(STATE, "backend.sqlite3"), { readonly: true });
  try {
    const row = db.query("select json_value from persistence_globals where key = 'table_summary_v2'").get() as {
      json_value: string;
    } | null;
    const ts = row ? (JSON.parse(row.json_value) as { ts: string }).ts : null;
    const checkpoint = ts ? Buffer.from(ts, "base64").readBigInt64LE(0) : 0n;
    const head = (db.query("select max(ts) as m from documents").safeIntegers(true).get() as { m: bigint }).m;
    return { checkpoint, head };
  } finally {
    db.close();
  }
}

/**
 * Makes the table summaries' checkpoint catch up with the store, so every later start reads a short log. A checkpoint
 * is written 500 commits after the last (DATABASE_WORKERS_MIN_COMMITS), or 10 minutes after it with a commit since,
 * as Convex's: one written mid-seed would leave a million documents for every start to replay.
 */
async function settle(http: BunvexHttpClient, ids: string[]) {
  const { head } = checkpointLag();
  for (let i = 0; i < 600; i++) await http.mutation(api.items.touch, { id: ids[i % ids.length]! });
  for (let i = 0; i < 120; i++) {
    const lag = checkpointLag();
    if (lag.checkpoint >= head) return console.log("settle: the checkpoint is at the store's head");
    await Bun.sleep(1000);
  }
  throw new Error("the table summary checkpoint did not catch up");
}

// ---- seed -------------------------------------------------------------------------------------------------------

async function seed() {
  if (existsSync(join(STATE, "meta.json"))) throw new Error(`${STATE} is already seeded`);
  mkdirSync(STATE, { recursive: true });
  const docs = Number(flags.docs);
  const batch = Number(flags.batch);
  const meta: Meta = {
    secret: randomBytes(32).toString("hex"),
    port: 20_000 + Math.floor(Math.random() * 10_000),
    docs,
    seededAt: new Date().toISOString(),
    seedSeconds: 0,
  };
  const t0 = performance.now();
  // The seed writes as fast as it can: Convex's write-rate limits (4 MiB/s) would make a 5 GB store take hours.
  const backend = await startBackend(
    meta,
    { MAX_BYTES_WRITTEN_PER_SECOND: String(2 ** 40), MAX_ROWS_WRITTEN_PER_SECOND: String(2 ** 40) },
    "",
  );
  try {
    const adminKey = (
      await exec([process.execPath, BACKEND, "keygen", "admin-key", "--instance-name", NAME], STATE, {
        INSTANCE_SECRET: meta.secret,
      })
    ).trim();
    const project = join(STATE, "project");
    mkdirSync(join(project, "bunvex"), { recursive: true });
    for (const f of readdirSync(join(import.meta.dir, "app")))
      cpSync(join(import.meta.dir, "app", f), join(project, "bunvex", f));
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "sqlite-cache-app", private: true }));
    symlinkSync(join(ROOT, "bench/node_modules"), join(project, "node_modules"));
    const envFile = join(STATE, "deployment.env");
    writeFileSync(envFile, `BUNVEX_SELF_HOSTED_URL=${backend.url}\nBUNVEX_SELF_HOSTED_ADMIN_KEY=${adminKey}\n`);
    await exec([process.execPath, CLI, "deploy", "--typecheck=disable", "--env-file", envFile], project);
    const http = new BunvexHttpClient(backend.url, { logger: false });
    const ids: string[] = [];
    for (let start = 0; start < docs; start += batch) {
      const count = Math.min(batch, docs - start);
      ids.push(...((await http.mutation(api.items.seed, { start, count, sampleEvery: SAMPLE_EVERY })) as string[]));
      if ((start / batch) % 50 === 0) {
        const file = Bun.file(join(STATE, "backend.sqlite3")).size / MB;
        console.log(
          `seed: ${start + count}/${docs} docs, ${file.toFixed(0)} MB, ${((performance.now() - t0) / 1000).toFixed(0)} s`,
        );
      }
    }
    writeFileSync(join(STATE, "ids.json"), JSON.stringify(ids));
    await settle(http, ids);
  } finally {
    await backend.stop();
  }
  meta.seedSeconds = (performance.now() - t0) / 1000;
  writeFileSync(join(STATE, "meta.json"), JSON.stringify(meta, null, 2));
  console.log(
    `seed: done, ${(Bun.file(join(STATE, "backend.sqlite3")).size / MB).toFixed(0)} MB in ${meta.seedSeconds.toFixed(0)} s`,
  );
}

/** For a store seeded before `settle` existed: deploys the app again (for `touch`) and settles. */
async function checkpoint() {
  const meta = JSON.parse(readFileSync(join(STATE, "meta.json"), "utf8")) as Meta;
  const ids = JSON.parse(readFileSync(join(STATE, "ids.json"), "utf8")) as string[];
  const backend = await startBackend(meta, {}, "");
  console.log(`checkpoint: the backend started in ${backend.startSeconds.toFixed(0)} s`);
  try {
    const project = join(STATE, "project");
    for (const f of readdirSync(join(import.meta.dir, "app")))
      cpSync(join(import.meta.dir, "app", f), join(project, "bunvex", f));
    const envFile = join(STATE, "deployment.env");
    await exec([process.execPath, CLI, "deploy", "--typecheck=disable", "--env-file", envFile], project);
    await settle(new BunvexHttpClient(backend.url, { logger: false }), ids);
  } finally {
    await backend.stop();
  }
}

// ---- run --------------------------------------------------------------------------------------------------------

const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : Number.NaN;

/** The backend's resident memory, and its cgroup's (anonymous and file-backed: the OS page cache it filled). */
function memory(pid: number) {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const rss = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) * 1024;
  const cg = readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().split("::")[1];
  const dir = `/sys/fs/cgroup${cg}`;
  let current = 0;
  let anon = 0;
  let file = 0;
  try {
    current = Number(readFileSync(join(dir, "memory.current"), "utf8"));
    const stat = readFileSync(join(dir, "memory.stat"), "utf8");
    anon = Number(/^anon (\d+)/m.exec(stat)?.[1] ?? 0);
    file = Number(/^file (\d+)/m.exec(stat)?.[1] ?? 0);
  } catch {}
  return { rss, cgroup: { current, anon, file } };
}

/** Major page faults and read bytes of the backend process: how much it read from disk. */
function io(pid: number) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ioText = readFileSync(`/proc/${pid}/io`, "utf8");
  return {
    majflt: Number(fields[9]),
    readBytes: Number(/read_bytes: (\d+)/.exec(ioText)?.[1] ?? 0),
    rchar: Number(/rchar: (\d+)/.exec(ioText)?.[1] ?? 0),
    cpuTicks: Number(fields[11]) + Number(fields[12]),
  };
}

/** Other bunvex backends on the machine (another tenant's soak, say): a run they overlap is not clean. */
function otherBackends(self: number): number[] {
  const pids: number[] = [];
  for (const d of readdirSync("/proc")) {
    const pid = Number(d);
    if (!pid || pid === self) continue;
    try {
      if (readFileSync(`/proc/${d}/cmdline`, "utf8").includes("local-backend")) pids.push(pid);
    } catch {}
  }
  return pids;
}

async function run() {
  const meta = JSON.parse(readFileSync(join(STATE, "meta.json"), "utf8")) as Meta;
  const ids = JSON.parse(readFileSync(join(STATE, "ids.json"), "utf8")) as string[];
  const perGroup = Math.ceil(meta.docs / GROUPS);
  const groups = flags.mode === "hot" ? HOT_GROUPS : GROUPS;
  // Sampled ids are every SAMPLE_EVERY-th document: document i is in group i % GROUPS.
  const hotIds = ids.filter((_, k) => (k * SAMPLE_EVERY) % GROUPS < groups);
  const pool = flags.mode === "hot" ? hotIds : ids;
  if (!pool.length) throw new Error("no ids for this mode");
  const cacheEnv: Record<string, string> = flags.cache === "default" ? {} : { BENCH_SQLITE_CACHE_KIB: flags.cache! };

  // Cold start: drop the OS page cache, so every run starts from the disk.
  await exec(["sync"], STATE);
  writeFileSync("/proc/sys/vm/drop_caches", "3");
  const backend = await startBackend(meta, cacheEnv, flags["memory-max"]!);
  const pid = backend.proc.pid;
  const seen = /bench cache_size=(\{[^\n]*\})/.exec(backend.stderr())?.[1];
  if (!seen) throw new Error(`the backend is not patched (no "bench cache_size=" line):\n${backend.stderr()}`);
  const http = new BunvexHttpClient(backend.url, { logger: false });
  const rand = (n: number) => Math.floor(Math.random() * n);
  const lat = { get: [] as number[], range: [] as number[], page: [] as number[] };
  let calls = 0;
  let errors = 0;
  const errorSamples: string[] = [];
  let recording = false;
  let stopping = false;
  const timed = async <T>(op: keyof typeof lat, f: () => Promise<T>): Promise<T | undefined> => {
    const t0 = performance.now();
    try {
      const r = await f();
      calls++;
      if (recording) lat[op].push(performance.now() - t0);
      return r;
    } catch (e) {
      errors++;
      if (errorSamples.length < 10) errorSamples.push(`${op}: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  };
  // One worker: 40 % point gets, 40 % range reads of 20, 20 % a paginated walk of up to 4 pages of 25.
  const worker = async () => {
    while (!stopping) {
      const r = Math.random();
      const group = rand(groups);
      const from = rand(perGroup);
      if (r < 0.4) await timed("get", () => http.query(api.items.get, { id: pool[rand(pool.length)]! }));
      else if (r < 0.8) await timed("range", () => http.query(api.items.range, { group, from, limit: 20 }));
      else {
        let cursor: string | null = null;
        for (let p = 0; p < 4 && !stopping; p++) {
          const res = (await timed("page", () =>
            http.query(api.items.page, { group, from, paginationOpts: { numItems: 25, cursor } }),
          )) as { isDone: boolean; continueCursor: string } | undefined;
          if (!res || res.isDone) break;
          cursor = res.continueCursor;
        }
      }
    }
  };
  // Every 5 s, warm-up included: memory, and the calls and disk reads so far (is the run at its steady state?).
  const samples: {
    t: number;
    rss: number;
    cgroup: ReturnType<typeof memory>["cgroup"];
    calls: number;
    diskReadBytes: number;
  }[] = [];
  const t0 = performance.now();
  const sampler = setInterval(
    () => samples.push({ t: (performance.now() - t0) / 1000, ...memory(pid), calls, diskReadBytes: io(pid).readBytes }),
    5000,
  );
  const workers = Array.from({ length: Number(flags.concurrency) }, worker);
  await Bun.sleep(Number(flags.warmup) * 1000);
  const others0 = otherBackends(pid);
  const io0 = io(pid);
  recording = true;
  const m0 = performance.now();
  await Bun.sleep(Number(flags.seconds) * 1000);
  recording = false;
  const measured = (performance.now() - m0) / 1000;
  const io1 = io(pid);
  const others1 = otherBackends(pid);
  stopping = true;
  await Promise.all(workers);
  clearInterval(sampler);
  const end = memory(pid);
  await backend.stop();

  const ops = Object.fromEntries(
    Object.entries(lat).map(([op, a]) => {
      const s = a.toSorted((x, y) => x - y);
      return [
        op,
        {
          count: s.length,
          perSecond: s.length / measured,
          p50: percentile(s, 50),
          p95: percentile(s, 95),
          p99: percentile(s, 99),
        },
      ];
    }),
  );
  const all = Object.values(lat)
    .flat()
    .toSorted((x, y) => x - y);
  const measuredSamples = samples.filter((s) => s.t >= Number(flags.warmup));
  const result = {
    label: flags.label,
    cache: flags.cache,
    cacheSeen: JSON.parse(seen),
    memoryMax: flags["memory-max"] || null,
    mode: flags.mode,
    docs: meta.docs,
    storeBytes: Bun.file(join(STATE, "backend.sqlite3")).size,
    concurrency: Number(flags.concurrency),
    warmupSeconds: Number(flags.warmup),
    measuredSeconds: measured,
    startSeconds: backend.startSeconds,
    startedAt: new Date(Date.now() - (performance.now() - t0)).toISOString(),
    all: {
      count: all.length,
      perSecond: all.length / measured,
      p50: percentile(all, 50),
      p95: percentile(all, 95),
      p99: percentile(all, 99),
    },
    ops,
    errors,
    errorSamples,
    otherBackends: { atStart: others0, atEnd: others1 },
    memory: {
      rssEnd: end.rss,
      rssMax: Math.max(...measuredSamples.map((s) => s.rss), end.rss),
      cgroupEnd: end.cgroup,
    },
    io: {
      majorFaults: io1.majflt - io0.majflt,
      diskReadBytes: io1.readBytes - io0.readBytes,
      readSyscallBytes: io1.rchar - io0.rchar,
      cpuSeconds: (io1.cpuTicks - io0.cpuTicks) / 100,
    },
    samples,
    // Each op's latency distribution, in 0.1 % steps (the raw calls are too many to keep).
    quantiles: Object.fromEntries(
      Object.entries(lat).map(([op, a]) => {
        const s = a.toSorted((x, y) => x - y);
        return [op, Array.from({ length: 1001 }, (_, k) => Math.round(percentile(s, k / 10) * 1000) / 1000)];
      }),
    ),
  };
  const line = `${flags.label} cache=${flags.cache} mode=${flags.mode} ${result.all.perSecond.toFixed(0)}/s p50 ${result.all.p50.toFixed(2)} p95 ${result.all.p95.toFixed(2)} p99 ${result.all.p99.toFixed(2)} ms rss ${(end.rss / MB).toFixed(0)} MB disk ${(result.io.diskReadBytes / MB).toFixed(0)} MB errors ${errors}${others0.length || others1.length ? " OTHER BACKENDS RAN" : ""}`;
  console.log(line);
  if (flags.out) writeFileSync(flags.out, JSON.stringify(result));
}

if (cmd === "seed") await seed();
else if (cmd === "checkpoint") await checkpoint();
else if (cmd === "run") await run();
else {
  console.error("usage: bench.ts seed|run --state <dir> …");
  process.exit(2);
}

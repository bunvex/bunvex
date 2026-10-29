// The soak test (STUDY-174 §2): this repository's local backend (the program the release compiles, run by Bun, on
// SQLite) with the app of ./app deployed by the CLI, then a mixed workload for `--minutes`: sync clients that
// subscribe, send, bump a hot counter, hold a room presence and reconnect now and then; HTTP queries, a search,
// the cache canary; scheduled jobs; file uploads. Every `--sample` seconds it records the backend's /metrics, its
// file descriptors and the driver's latencies; at the end it closes every client, drains the scheduler, measures
// an idle tail, and judges the run by the rules of rules.ts (trends, not single samples).
//
//   bun bench/soak/soak.ts --minutes 45 --out .data/soak
//
// Diagnostics (STUDY-174 F6): `--off subs,storage,…` leaves workload parts out, to bisect a failing trend;
// `--probe` preloads ./probe.ts into the backend, which writes its memory detail to `<out>/probe.jsonl` (read by
// ./analyze.ts). The backend's stderr is kept in `<out>/backend.stderr`.
//
// `--report-only R1,…` judges and reports those rules but leaves them out of the exit code (the nightly's R1 until
// STUDY-174 Q6 is decided, §10.3).
//
// Exit code: 0 when every rule passes (report-only ones aside), 1 when one fails, 2 when the run itself broke. The report is
// `<out>/report.json` (every sample, re-judgeable) and `<out>/report.md`.
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BunvexClient, BunvexHttpClient } from "@bunvex/client";
import { anyApi } from "@bunvex/server";
import {
  exitCode,
  type JobRecord,
  judge,
  parseReportOnly,
  percentile,
  type RunData,
  type Sample,
  withReportOnly,
} from "./rules.ts";

const { values: flags } = parseArgs({
  options: {
    minutes: { type: "string", default: "45" },
    warmup: { type: "string" }, // minutes; default max(3, 20 % of the run)
    sample: { type: "string", default: "15" }, // seconds
    clients: { type: "string", default: "20" },
    out: { type: "string", default: ".data/soak" },
    // A job due this many days ahead (0: none): an idle scheduler must sleep until it, not poll.
    "far-future-days": { type: "string", default: "30" },
    "idle-seconds": { type: "string", default: "60" },
    // The caches' budgets, in MiB: small, so they fill during the warm-up and a growth past it is not a cache
    // filling up (the defaults, 512 MiB and 100 MiB, take longer than a run to fill).
    "index-cache-mib": { type: "string", default: "32" },
    "query-cache-mib": { type: "string", default: "16" },
    // SQLite's page cache (256 MiB, DV-550) fills with the store, ~70 minutes at the workload's write rate: this many
    // MiB of ballast are written before the workload and read once at its start, so the cache is full before R1 and
    // R2 judge (STUDY-174 Q6, §10.3). 0: none.
    "page-cache-fill-mib": { type: "string", default: "320" },
    // Workload parts to leave out, comma-separated: subs, rooms, reconnects, sync-mutations, hot, httpq,
    // canary, search, scheduler, storage, crons, logtail, clients (no sync clients at all).
    off: { type: "string", default: "" },
    // The backend's memory probe (./probe.ts), and how often it forces a full GC first (0: never).
    probe: { type: "boolean", default: false },
    "probe-gc-minutes": { type: "string", default: "10" },
    // Rules judged and reported but left out of the exit code, comma-separated ids (R1, R7a, …): a known
    // failure that waits on a decision, never a way to silence a new one. Empty by default.
    "report-only": { type: "string", default: "" },
  },
});
const MINUTES = Number(flags.minutes);
const WARMUP_S = flags.warmup !== undefined ? Number(flags.warmup) * 60 : Math.max(180, MINUTES * 60 * 0.2);
const SAMPLE_S = Number(flags.sample);
const CLIENTS = Number(flags.clients);
const OUT = resolve(flags.out!);
const IDLE_S = Number(flags["idle-seconds"]);
const OFF = new Set((flags.off ?? "").split(",").filter(Boolean));
const on = (part: string) => !OFF.has(part);
let REPORT_ONLY: Set<string>;
try {
  REPORT_ONLY = parseReportOnly(flags["report-only"] ?? "");
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const BENCH = resolve(import.meta.dir, "..");
const ROOT = resolve(BENCH, "..");
const BACKEND = join(ROOT, "apps/local-backend/local-backend.ts");
const CLI = join(ROOT, "packages/cli/bin/bunvex.ts");
const api = anyApi;

// ---- The backend -----------------------------------------------------------------------------------------------

async function run(cmd: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")} failed:\n${out}\n${err}`);
  return out;
}

function freePort(): number {
  for (;;) {
    const p = 20_000 + Math.floor(Math.random() * 12_000);
    try {
      Bun.listen({ hostname: "127.0.0.1", port: p, socket: { data() {} } }).stop(true);
      Bun.listen({ hostname: "127.0.0.1", port: p + 1, socket: { data() {} } }).stop(true);
      return p;
    } catch {}
  }
}

const state = mkdtempSync(join(tmpdir(), "bunvex-soak-"));
const port = freePort();
const url = `http://127.0.0.1:${port}`;
const name = "bunvex-soak";
const secret = randomBytes(32).toString("hex");
const backend = Bun.spawn(
  [
    process.execPath,
    ...(flags.probe ? ["--preload", join(import.meta.dir, "probe.ts")] : []),
    BACKEND,
    "--port",
    String(port),
    "--site-proxy-port",
    String(port + 1),
    "--instance-name",
    name,
    "--local-storage",
    join(state, "storage"),
    join(state, "backend.sqlite3"),
  ],
  {
    cwd: state,
    env: {
      ...process.env,
      INSTANCE_SECRET: secret,
      INDEX_CACHE_SIZE: String(Number(flags["index-cache-mib"]) * 2 ** 20),
      UDF_CACHE_MAX_SIZE: String(Number(flags["query-cache-mib"]) * 2 ** 20),
      ...(flags.probe
        ? { SOAK_PROBE_OUT: join(OUT, "probe.jsonl"), SOAK_PROBE_GC_MINUTES: flags["probe-gc-minutes"]! }
        : {}),
    },
    stdout: "ignore",
    stderr: "pipe",
  },
);
let stderrTail = "";
(async () => {
  for await (const chunk of backend.stderr as ReadableStream<Uint8Array>) {
    const text = new TextDecoder().decode(chunk);
    appendFileSync(join(OUT, "backend.stderr"), text);
    stderrTail = (stderrTail + text).slice(-8000);
  }
})();
const cleanup = async () => {
  backend.kill("SIGTERM");
  await backend.exited;
  rmSync(state, { recursive: true, force: true });
};
process.on("SIGINT", () => void cleanup().then(() => process.exit(2)));

for (let i = 0; ; i++) {
  const answer = await fetch(`${url}/instance_name`)
    .then((r) => r.text())
    .catch(() => null);
  if (answer === name) break;
  if (backend.exitCode !== null || i > 300) {
    console.error(`the backend did not start:\n${stderrTail}`);
    process.exit(2);
  }
  await Bun.sleep(100);
}
const adminKey = (
  await run([process.execPath, BACKEND, "keygen", "admin-key", "--instance-name", name], state, {
    INSTANCE_SECRET: secret,
  })
).trim();
// The app in a project of its own, with this workspace's packages.
const project = join(state, "project");
mkdirSync(join(project, "bunvex"), { recursive: true });
for (const f of readdirSync(join(import.meta.dir, "app")))
  if (on("crons") || f !== "crons.ts") cpSync(join(import.meta.dir, "app", f), join(project, "bunvex", f));
writeFileSync(join(project, "package.json"), JSON.stringify({ name: "soak-app", private: true, type: "module" }));
symlinkSync(join(BENCH, "node_modules"), join(project, "node_modules"));
const envFile = join(state, "deployment.env");
writeFileSync(envFile, `BUNVEX_SELF_HOSTED_URL=${url}\nBUNVEX_SELF_HOSTED_ADMIN_KEY=${adminKey}\n`);
await run([process.execPath, CLI, "deploy", "--typecheck=disable", "--env-file", envFile], project);
console.log(
  `soak: backend pid ${backend.pid} at ${url}; ${MINUTES} min, warm-up ${WARMUP_S / 60} min, ${CLIENTS} clients`,
);

// ---- What the driver measures -----------------------------------------------------------------------------------

const lat = new Map<string, number[]>();
const record = (op: string, ms: number) => {
  const a = lat.get(op);
  if (a) a.push(ms);
  else lat.set(op, [ms]);
};
let unexpectedErrors = 0;
const errorSamples: string[] = [];
const failed = (what: string, e: unknown) => {
  unexpectedErrors++;
  if (errorSamples.length < 20) errorSamples.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
};
/** Calls that failed as the workload expects: a hot counter's mutation that lost every OCC retry (Convex's too). */
let expectedFailures = 0;
async function timed<T>(op: string, f: () => Promise<T>, expected?: RegExp): Promise<T | undefined> {
  const t0 = performance.now();
  try {
    const r = await f();
    record(op, performance.now() - t0);
    return r;
  } catch (e) {
    if (expected?.test(e instanceof Error ? e.message : String(e))) expectedFailures++;
    else failed(op, e);
    return undefined;
  }
}
/** An OCC failure's message (`OccError`): the documents changed on every retry. */
const OCC = /changed while this mutation was being run/;

/** The backend's `/metrics`, summed by metric name (labels dropped). */
async function metrics(): Promise<Map<string, number>> {
  const text = await (await fetch(`${url}/metrics`)).text();
  const m = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const sp = line.lastIndexOf(" ");
    const key = line.slice(0, sp).replace(/\{.*\}$/, "");
    m.set(key, (m.get(key) ?? 0) + Number(line.slice(sp + 1)));
  }
  return m;
}

/** The backend's open file descriptors (Linux: /proc; elsewhere: lsof). */
async function fds(): Promise<number> {
  try {
    return readdirSync(`/proc/${backend.pid}/fd`).length;
  } catch {
    const out = await run(["lsof", "-p", String(backend.pid)], state).catch(() => "");
    return Math.max(0, out.trim().split("\n").length - 1);
  }
}

/** The backend's CPU time so far, in seconds (Linux: /proc/<pid>/stat; elsewhere: ps). */
/**
 * Where the backend's resident memory is (Linux: /proc/<pid>/smaps_rollup): anonymous (the heaps, native buffers)
 * vs file-backed (mapped files, such as SQLite's), in bytes; and the store's files on disk. Diagnostics for a
 * failing R1: the heap gauge alone cannot tell a native leak from a page cache.
 */
async function memoryDetail(): Promise<Sample["detail"]> {
  const files = (name: string) => {
    try {
      return Bun.file(join(state, name)).size;
    } catch {
      return 0;
    }
  };
  const store = { dbBytes: files("backend.sqlite3"), walBytes: files("backend.sqlite3-wal") };
  try {
    const text = await Bun.file(`/proc/${backend.pid}/smaps_rollup`).text();
    const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+) kB`, "m").exec(text)?.[1] ?? 0) * 1024;
    return { anonBytes: kb("Anonymous"), fileBytes: kb("Rss") - kb("Anonymous"), ...store };
  } catch {
    return { anonBytes: null, fileBytes: null, ...store };
  }
}

async function cpuSeconds(): Promise<number> {
  try {
    const stat = await Bun.file(`/proc/${backend.pid}/stat`).text();
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return (Number(f[11]) + Number(f[12])) / 100; // utime + stime, in clock ticks (USER_HZ = 100)
  } catch {
    const t = (await run(["ps", "-o", "cputime=", "-p", String(backend.pid)], state)).trim();
    const parts = t.split(/[:.-]/).map(Number);
    // [[dd-]hh:]mm:ss.cc
    const [ss, cc] = [parts[parts.length - 2]!, parts[parts.length - 1]!];
    const mm = parts[parts.length - 3] ?? 0;
    const hh = parts[parts.length - 4] ?? 0;
    return hh * 3600 + mm * 60 + ss + cc / 100;
  }
}

/** The function log stream, tailed: per function, its calls and its runs (cache misses), past the warm-up. */
const logTail = { cursor: 0, canaryCalls: 0, canaryMisses: 0, failures: 0 };
let canaryCounting = false;
async function tailLogs() {
  const r = await fetch(`${url}/api/stream_function_logs?cursor=${logTail.cursor}`, {
    headers: { authorization: `Bunvex ${adminKey}` },
  });
  const body = (await r.json()) as {
    entries: { kind: string; identifier?: string; udfType?: string; cachedResult?: boolean; error?: string | null }[];
    newCursor: number;
  };
  for (const e of body.entries) {
    if (e.kind !== "Completion") continue;
    // A hot counter's lost OCC attempts are logged as their own completions, with an error: expected.
    // So is a ballast write the write-rate limit refused: the fill waits and writes it again.
    const throttledFill = e.identifier?.startsWith("ballast") && /TooManyWrites/.test(e.error ?? "");
    if (
      e.error &&
      !/OptimisticConcurrency|conflict/i.test(e.error) &&
      !OCC.test(e.error) &&
      !throttledFill &&
      logTail.failures++ < 20
    )
      errorSamples.push(`${e.identifier}: ${e.error.split("\n")[0]}`);
    if (e.identifier?.startsWith("config") && e.udfType === "Query" && canaryCounting) {
      logTail.canaryCalls++;
      if (!e.cachedResult) logTail.canaryMisses++;
    }
  }
  logTail.cursor = body.newCursor;
}

// ---- The workload ----------------------------------------------------------------------------------------------

let alive = true;
const loops: Promise<void>[] = [];
/** Run `f` about every `ms` (with jitter) until the workload stops; calls may overlap up to `max`. */
function every(ms: number, f: () => Promise<unknown>, max = 4) {
  let inflight = 0;
  loops.push(
    (async () => {
      while (alive) {
        if (inflight < max) {
          inflight++;
          void f().finally(() => inflight--);
        }
        await Bun.sleep(ms * (0.5 + Math.random()));
      }
    })(),
  );
}

const http = new BunvexHttpClient(url, { logger: false });

// ---- The page cache's ballast ------------------------------------------------------------------------------------

const FILL_MIB = Number(flags["page-cache-fill-mib"]);
const BALLAST_DOC = 8000; // bytes of body: overflow pages, so few rows hold many pages
const BALLAST_BATCH = 64; // ~512 KB a mutation
// Paced at ~2 MiB a second, half the deployment's write-rate limit (MAX_BYTES_WRITTEN_PER_SECOND, 4 MiB), so the
// crons that run meanwhile keep their share and the limit refuses nothing (a refusal is retried, not an error).
const BALLAST_BATCH_MS = (BALLAST_BATCH * BALLAST_DOC * 1000) / (2 * 2 ** 20);
if (FILL_MIB > 0) {
  const docs = Math.ceil((FILL_MIB * 2 ** 20) / BALLAST_DOC);
  const t0 = performance.now();
  for (let from = 0, batch = 0; from < docs; ) {
    const count = Math.min(BALLAST_BATCH, docs - from);
    const wait = t0 + batch * BALLAST_BATCH_MS - performance.now();
    if (wait > 0) await Bun.sleep(wait);
    try {
      await http.mutation(api.ballast.fill, { from, count, size: BALLAST_DOC });
      from += count;
      batch++;
    } catch (e) {
      // The write-rate limit (TooManyWrites, as Convex's): wait and write the same batch again.
      if (!/TooManyWrites|Too many writes/.test(e instanceof Error ? e.message : String(e))) throw e;
      await Bun.sleep(250);
    }
  }
  console.log(`soak: ${FILL_MIB} MiB of ballast written in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
}
/** When the ballast's read finished (seconds from the start), `null` until then. */
let pageCacheFilledSeconds: number | null = null;

const CHANNELS = Array.from({ length: 10 }, (_, i) => `c${i}`);
const WORDS = ["apple", "river", "stone", "cloud", "ember", "maple", "orbit", "quartz", "tiger", "violet"];
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;

type Driven = { client: BunvexClient; stops: (() => void)[]; subs: number };
const clients = new Set<Driven>();
const reconnectTimes: number[] = [];

function openClient(i: number): Driven {
  const client = new BunvexClient(url, { logger: false, unsavedChangesWarning: false } as never);
  const d: Driven = { client, stops: [], subs: 0 };
  const channel = CHANNELS[i % CHANNELS.length]!;
  if (on("subs"))
    d.stops.push(
      client.onUpdate(
        api.messages.list,
        { channel },
        () => {},
        (e) => failed("subscription", e),
      ),
    );
  if (on("subs"))
    d.stops.push(
      client.onUpdate(
        api.counters.get,
        { name: "hot" },
        () => {},
        (e) => failed("subscription", e),
      ),
    );
  d.subs = on("subs") ? 2 : 0;
  const room = on("rooms")
    ? (client.client.joinRoom(api.rooms.lobby as never, { n: i % 3 }) as {
        setPresence(p: unknown): void;
        leave(): void;
      })
    : { setPresence() {}, leave() {} };
  d.stops.push(() => room.leave());
  clients.add(d);
  // Its own loop: a message every ~1 s, a bump every ~2 s, a presence every ~0.5 s; replaced after 30–90 s.
  loops.push(
    (async () => {
      const replaceAt = Date.now() + 30_000 + Math.random() * 60_000;
      let n = 0;
      while (alive && clients.has(d)) {
        n++;
        room.setPresence({ x: Math.random(), y: Math.random() });
        if (n % 2 === 0 && on("sync-mutations"))
          void timed("sync mutation", () =>
            client.mutation(api.messages.send, {
              channel,
              author: `u${i}`,
              body: `${pick(WORDS)} ${pick(WORDS)} ${n}`,
            }),
          );
        if (n % 4 === 0 && on("hot"))
          void timed("sync mutation (hot counter)", () => client.mutation(api.counters.bump, { name: "hot" }), OCC);
        await Bun.sleep(500);
        if (Date.now() > replaceAt && alive && on("reconnects")) {
          await closeClient(d);
          reconnectTimes.push(Date.now());
          openClient(i);
          return;
        }
      }
    })(),
  );
  return d;
}

async function closeClient(d: Driven) {
  clients.delete(d);
  for (const s of d.stops) s();
  await d.client.close();
}

const tStart = Date.now();
const elapsed = () => (Date.now() - tStart) / 1000;
// The ballast, read once at the start of the warm-up, beside the workload: the page cache fills to its budget.
if (FILL_MIB > 0)
  void (async () => {
    let cursor: string | null = null;
    let n = 0;
    for (;;) {
      const page = (await http.query(api.ballast.read, { paginationOpts: { numItems: 128, cursor } })) as {
        n: number;
        isDone: boolean;
        continueCursor: string;
      };
      n += page.n;
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    pageCacheFilledSeconds = elapsed();
    console.log(`soak: the ballast read (${n} documents) finished at t=${Math.round(pageCacheFilledSeconds)}s`);
  })().catch((e) => failed("ballast read", e));
if (on("clients")) for (let i = 0; i < CLIENTS; i++) openClient(i);
// HTTP queries: a channel's list (invalidated often), the canary (written every 5 min), a search.
if (on("httpq"))
  every(100, () => timed("http query", () => http.query(api.messages.list, { channel: pick(CHANNELS) })), 8);
if (on("canary"))
  every(100, () => timed("http query (canary)", () => http.query(api.config.get, { key: "canary" })), 8);
if (on("search"))
  every(500, () =>
    timed("search", () => http.query(api.messages.search, { text: pick(WORDS), channel: pick(CHANNELS) })),
  );
let canaryWrites = 0;
every(300_000, async () => {
  await timed("http mutation", () => http.mutation(api.config.set, { key: "canary", value: Date.now() }));
  if (canaryCounting) canaryWrites++;
});
// Scheduled jobs: two a second, due within 2 s.
let jobsScheduled = 0;
if (on("scheduler"))
  every(
    500,
    async () => {
      const seq = ++jobsScheduled;
      const r = await timed("schedule", () =>
        http.mutation(api.jobs.schedule, { seq, delayMs: Math.floor(Math.random() * 2000) }),
      );
      if (r === undefined) jobsScheduled--; // not scheduled: not expected to run (counted as an error already)
    },
    1,
  );
// File storage: upload, read back, delete.
if (on("storage"))
  every(5000, () =>
    timed("storage round trip", async () => {
      const upload = (await http.mutation(api.files.uploadUrl, {})) as string;
      const r = await fetch(upload, { method: "POST", body: randomBytes(16 * 1024) });
      const { storageId } = (await r.json()) as { storageId: string };
      const id = await http.mutation(api.files.save, { storageId });
      const fileUrl = (await http.query(api.files.url, { id })) as string;
      if ((await (await fetch(fileUrl)).arrayBuffer()).byteLength !== 16 * 1024)
        throw new Error("file read back short");
      await http.mutation(api.files.remove, { id });
    }),
  );
await http.mutation(api.config.set, { key: "canary", value: 0 });
const FAR_DAYS = Number(flags["far-future-days"]);
if (FAR_DAYS > 0) await http.mutation(api.jobs.far, { days: FAR_DAYS });

// ---- Sampling ---------------------------------------------------------------------------------------------------

const samples: Sample[] = [];
let prev = await metrics();
const baselineFds = await fds();
const logTimer = setInterval(() => on("logtail") && void tailLogs().catch((e) => failed("log tail", e)), 1000);
const deadline = tStart + MINUTES * 60_000;
while (Date.now() < deadline) {
  await Bun.sleep(SAMPLE_S * 1000);
  if (backend.exitCode !== null) {
    console.error(`the backend exited (${backend.exitCode}):\n${stderrTail}`);
    process.exit(2);
  }
  if (!canaryCounting && elapsed() >= WARMUP_S) canaryCounting = true;
  const m = await metrics();
  const delta = (k: string) => (m.get(k) ?? 0) - (prev.get(k) ?? 0);
  const latency: Sample["latency"] = {};
  for (const [op, xs] of lat)
    latency[op] = xs.length ? { p50: percentile(xs, 50), p99: percentile(xs, 99), n: xs.length } : null;
  lat.clear();
  const s: Sample = {
    t: elapsed(),
    rssBytes: m.get("bunvex_process_resident_memory_bytes") ?? 0,
    heapBytes: m.get("bunvex_process_heap_bytes") ?? 0,
    indexCacheBytes: m.get("bunvex_index_cache_bytes") ?? 0,
    fds: await fds(),
    detail: await memoryDetail(),
    cacheHits: delta("bunvex_query_cache_hits_total"),
    cacheMisses: delta("bunvex_query_cache_misses_total"),
    sessions: m.get("bunvex_sync_sessions") ?? 0,
    subscriptions: m.get("bunvex_sync_subscriptions") ?? 0,
    roomMembers: m.get("bunvex_rooms_members") ?? 0,
    clients: clients.size,
    subscriptionsOpen: [...clients].reduce((n, c) => n + c.subs, 0),
    recentReconnects: reconnectTimes.filter((t) => t > Date.now() - 10_000).length,
    latency,
    eventLoopLagSeconds: m.get("bunvex_process_event_loop_lag_seconds") ?? 0,
    backlogSeconds: m.get("bunvex_scheduled_job_backlog_seconds") ?? 0,
  };
  samples.push(s);
  prev = m;
  const hit = s.cacheHits + s.cacheMisses ? ((100 * s.cacheHits) / (s.cacheHits + s.cacheMisses)).toFixed(1) : "-";
  const anon = s.detail?.anonBytes != null ? ` anon=${(s.detail.anonBytes / 2 ** 20).toFixed(0)}MB` : "";
  console.log(
    `t=${Math.round(s.t)}s${anon} wal=${((s.detail?.walBytes ?? 0) / 2 ** 20).toFixed(0)}MB rss=${(s.rssBytes / 2 ** 20).toFixed(0)}MB heap=${(s.heapBytes / 2 ** 20).toFixed(0)}MB idx=${(s.indexCacheBytes / 2 ** 20).toFixed(0)}MB fds=${s.fds} hit=${hit}% sessions=${s.sessions}/${s.clients} subs=${s.subscriptions}/${s.subscriptionsOpen} members=${s.roomMembers} canary=${logTail.canaryMisses}/${logTail.canaryCalls} lag=${(s.eventLoopLagSeconds * 1000).toFixed(0)}ms backlog=${s.backlogSeconds.toFixed(1)}s errors=${unexpectedErrors}`,
  );
}

// ---- The drain and the idle tail ---------------------------------------------------------------------------------

alive = false;
await Promise.all([...clients].map(closeClient));
await Promise.race([Promise.all(loops), Bun.sleep(30_000)]);
await tailLogs().catch(() => {});
clearInterval(logTimer);
// Every job due by now has run, or the scheduler lost it.
const jobs: JobRecord[] = [];
for (let tries = 0; tries < 60; tries++) {
  jobs.length = 0;
  for (let after = 0; ; ) {
    const page = (await http.query(api.jobs.page, { after, limit: 4000 })) as [number, number, number | null, number][];
    for (const [seq, dueAt, ranAt, runs] of page) jobs.push({ seq, dueAt, ranAt, runs });
    if (page.length < 4000) break;
    after = page[page.length - 1]![0];
  }
  if (jobs.length >= jobsScheduled && jobs.every((j) => j.runs >= 1)) break;
  await Bun.sleep(1000);
}
await Bun.sleep(8000); // past the rooms' reconnect grace (5 s)
const m = await metrics();
const final = {
  sessions: m.get("bunvex_sync_sessions") ?? -1,
  subscriptions: m.get("bunvex_sync_subscriptions") ?? -1,
  roomMembers: m.get("bunvex_rooms_members") ?? -1,
  fds: await fds(),
};
// The idle tail: nothing runs, nothing is due (but the far-future job and cron): the backend must sleep.
await Bun.sleep(Math.min(30, IDLE_S / 2) * 1000);
const cpu0 = await cpuSeconds();
const t0 = performance.now();
await Bun.sleep(IDLE_S * 1000);
const idleCpu = ((await cpuSeconds()) - cpu0) / ((performance.now() - t0) / 1000);

const data: RunData = {
  durationSeconds: MINUTES * 60,
  warmupSeconds: WARMUP_S,
  indexCacheBudgetBytes: Number(flags["index-cache-mib"]) * 2 ** 20,
  ...(FILL_MIB > 0 ? { pageCacheFilledSeconds } : {}),
  samples,
  final,
  baselineFds,
  idleCpu,
  canary: { misses: logTail.canaryMisses, writes: canaryWrites, calls: logTail.canaryCalls },
  jobs,
  jobsScheduled,
  unexpectedErrors: unexpectedErrors + logTail.failures,
};
const results = withReportOnly(judge(data), REPORT_ONLY);
mkdirSync(OUT, { recursive: true });
writeFileSync(
  join(OUT, "report.json"),
  JSON.stringify({ flags, results, errorSamples, expectedFailures, ...data }, null, 1),
);
const md = [
  `# Soak report`,
  "",
  `${MINUTES} min, warm-up ${(WARMUP_S / 60).toFixed(1)} min, ${CLIENTS} clients, ${samples.length} samples, bun ${Bun.version}, ${process.platform}; ${expectedFailures} hot-counter mutations lost every OCC retry (expected).`,
  "",
  "| Rule | Result | Detail |",
  "|---|---|---|",
  ...results.map(
    (r) => `| ${r.rule} | ${r.pass ? "pass" : r.reportOnly ? "fail (report-only)" : "**FAIL**"} | ${r.detail} |`,
  ),
  "",
  ...(REPORT_ONLY.size ? [`Report-only (judged, not in the exit code): ${[...REPORT_ONLY].join(", ")}.`, ""] : []),
  ...(errorSamples.length ? ["Errors (first 20):", "", ...errorSamples.map((e) => `- ${e}`), ""] : []),
].join("\n");
writeFileSync(join(OUT, "report.md"), md);
console.log(`\n${md}`);
await cleanup();
process.exit(exitCode(results));

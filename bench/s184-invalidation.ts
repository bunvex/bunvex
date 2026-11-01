// STUDY-184 §5.6 (measurement 3), end to end: what a commit costs the one process that holds every subscription,
// and the commit rate it sustains while it holds them. A real server (a separate process, `createServer` on the
// memory store unless PERSISTENCE says otherwise) holds N subscriptions opened by real WebSocket sync sessions in
// CLIENTS other processes, PER_SOCKET subscriptions per socket (more past MAX_SOCKETS sockets: macOS has about 16k
// ephemeral ports to one address). Subscription i is `subs:watch({g: i mod G, i})`: the newest
// document of group g on the `by_g` index (a chat room's latest message), a distinct execution per subscription
// (no two share a result). A commit is `subs:bump({g, t})` over HTTP, inserting a newer document into group g, so
// it invalidates the N/G subscriptions of that group: G = N (about one), 100 (1 %) or 10 (10 %). An insert reads
// nothing, so concurrent writers never conflict. N = 0 writes over 1000 groups with nobody watching.
//
// Per cell, two phases:
//   - isolated: after WARMUP commits, COMMITS commits one at a time (fewer when each invalidates many); each waits until the clients received every update it caused.
//     The server's CPU per commit, minus the same with no subscription, is the leader's invalidation cost:
//     matching, the reruns, and the transitions pushed.
//   - saturated: WRITERS writers commit as fast as the server answers, for SECS seconds. Reported: commits/s,
//     updates pushed/s, server CPU, and p50/p99 from a commit's start to its update at a client. A session folds
//     the commits that arrive while it reruns into its next transition, as Convex's, so updates per commit fall.
//
// Splaying (Convex's SUBSCRIPTION_INVALIDATION_DELAY_*) spreads a wide invalidation over count × 5 ms, so it is
// turned off (multiplier 0) to measure the CPU; SPLAY=1 keeps it.
//   bun bench/s184-invalidation.ts
// Env: NS (0,1000,10000,100000), FANOUTS (one,1%,10%), PER_SOCKET (20), MAX_SOCKETS (12000), CLIENTS (4),
//      WARMUP (200), COMMITS (200), SECS (10), PROFILE,
//      WRITERS (16), SPLAY, PERSISTENCE (memory, durable: its log file in a fresh directory per cell) and the store's
//      own variables.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@bunvex/core";
import {
  createServer,
  defineSchema,
  defineTable,
  Functions,
  mutation,
  openPersistence,
  persistenceConfigFromEnv,
  query,
} from "@bunvex/server";
import { v } from "@bunvex/values";

const NS = (process.env.NS ?? "0,1000,10000,100000").split(",").map(Number);
const FANOUTS = (process.env.FANOUTS ?? "one,1%,10%").split(",");
const PER_SOCKET = Number(process.env.PER_SOCKET ?? 20);
const MAX_SOCKETS = Number(process.env.MAX_SOCKETS ?? 12_000);
const WARMUP = Number(process.env.WARMUP ?? 200);
const CLIENTS = Number(process.env.CLIENTS ?? 4);
const COMMITS = Number(process.env.COMMITS ?? 200);
const SECS = Number(process.env.SECS ?? 10);
const WRITERS = Number(process.env.WRITERS ?? 16);
/** Queries added per ModifyQuerySet. */
const BATCH = 500;

const groupsOf = (fanout: string, n: number) =>
  fanout === "one" ? n : fanout === "1%" ? 100 : fanout === "10%" ? 10 : 1000;
/** Subscriptions i < n with i mod groups = g. */
const inGroup = (n: number, groups: number, g: number) => (g < n ? Math.floor((n - 1 - g) / groups) + 1 : 0);
const now = () => performance.timeOrigin + performance.now();
/** Every child, killed if the driver fails. */
const children = new Set<{ kill(): void }>();
process.on("exit", () => {
  for (const c of children) c.kill();
});

// --- server -----------------------------------------------------------------------------------------------
async function runServer() {
  const schema = defineSchema({ docs: defineTable({ g: v.number(), t: v.number() }).index("by_g", ["g", "t"]) });
  const engine = await new Engine(schema, await openPersistence(persistenceConfigFromEnv())).init();
  const functions = new Functions(engine).register("subs", {
    // `i` is not read: it makes each subscription its own execution.
    watch: query(async ({ db }: any, { g }: { g: number; i: number }) =>
      db
        .query("docs")
        .withIndex("by_g", (q: any) => q.eq("g", g))
        .order("desc")
        .first(),
    ),
    // An insert reads nothing, so writers never conflict however few groups there are.
    bump: mutation(async ({ db }: any, { g, t }: { g: number; t: number }) => {
      await db.insert("docs", { g, t });
      return null;
    }),
  } as never);
  // Failures in full: the client gets the error's message, and the server prints each failed run from its
  // function log (the execution time and the message), so a failure under load can be told from a bug.
  const app = createServer({
    engine,
    functions,
    port: 0,
    hostname: "127.0.0.1",
    label: "bench-subscriptions",
    redactLogsToClient: false,
  });
  void (async () => {
    let cursor = 0;
    let printed = 0;
    for (;;) {
      const { parts, newCursor } = await app.functionLog.after(cursor, 1000);
      cursor = newCursor;
      for (const part of parts)
        if (part.kind === "Completion" && part.error !== null && printed++ < 50)
          console.error(
            `server: ${part.udfType} ${part.identifier} failed after ${part.executionTime.toFixed(3)} s ` +
              `(user ${part.userExecutionTime?.toFixed(3) ?? "?"} s, ${part.caller}): ${part.error}`,
          );
    }
  })();
  process.on("message", (m: { exit?: boolean; gc?: boolean }) => {
    if (m.exit) process.exit(0);
    if (m.gc) Bun.gc(true);
    const u = process.cpuUsage();
    const mem = process.memoryUsage();
    process.send?.({ cpuMs: (u.user + u.system) / 1000, rssMB: mem.rss / 2 ** 20, heapMB: mem.heapUsed / 2 ** 20 });
  });
  process.send?.({ port: app.server.port });
  await new Promise(() => {});
}

// --- client -----------------------------------------------------------------------------------------------
/** Opens `sockets` sessions holding subscriptions [from, to) between them; reports what it receives. */
async function runClient() {
  const [port, from, to, groups, sockets] = process.argv.slice(3).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const url = `ws://127.0.0.1:${port}/api/1.0.0/sync`;
  let initial = 0;
  let updates = 0;
  let failed = 0;
  let lat: number[] = [];
  let reportQueued = false;
  const report = () => {
    if (reportQueued) return;
    reportQueued = true;
    setTimeout(() => {
      reportQueued = false;
      process.send?.({ initial, updates, failed });
    }, 1);
  };
  const per = Math.ceil((to - from) / sockets);
  const opened: Promise<void>[] = [];
  for (let s = 0; s < sockets; s++) {
    const lo = from + s * per;
    const hi = Math.min(to, lo + per);
    if (lo >= hi) break;
    // A few connects at a time: macOS's listen backlog (somaxconn 128) drops a burst of them.
    if (opened.length >= 32) await Promise.all(opened.splice(0));
    const ws = new WebSocket(url);
    const answered = new Set<number>();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      if (m.type !== "Transition") return;
      const t = now();
      for (const mod of m.modifications) {
        if (mod.type === "QueryFailed") {
          if (failed++ < 20) console.error(`client: query ${mod.queryId} failed: ${mod.errorMessage}`);
        } else if (mod.type !== "QueryUpdated") continue;
        if (!answered.has(mod.queryId)) {
          answered.add(mod.queryId);
          initial++;
        } else {
          updates++;
          if (mod.value?.t > 0) lat.push(t - mod.value.t);
        }
      }
      report();
    };
    opened.push(
      new Promise<void>((r) => {
        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              type: "Connect",
              sessionId: crypto.randomUUID(),
              connectionCount: 0,
              lastCloseReason: null,
              clientTs: 0,
            }),
          );
          let version = 0;
          for (let b = lo; b < hi; b += BATCH) {
            const modifications = [];
            for (let i = b; i < Math.min(hi, b + BATCH); i++)
              modifications.push({ type: "Add", queryId: i - lo, udfPath: "subs:watch", args: [{ g: i % groups, i }] });
            ws.send(
              JSON.stringify({ type: "ModifyQuerySet", baseVersion: version, newVersion: version + 1, modifications }),
            );
            version++;
          }
          r();
        };
      }),
    );
  }
  await Promise.all(opened);
  // DEBUG=1: each client's progress through its initial results.
  if (process.env.DEBUG) setInterval(() => console.error(`client ${from}: initial ${initial} of ${to - from}`), 5000);
  process.on("message", (m: { stats?: boolean }) => {
    if (!m.stats) return;
    process.send?.({ initial, updates, failed, lat });
    lat = [];
  });
  await new Promise(() => {});
}

// --- driver -----------------------------------------------------------------------------------------------
type Cell = Record<string, number | string>;
const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return Number(s[Math.min(s.length - 1, Math.floor(p * s.length))]!.toFixed(1));
};

type Stats = { cpuMs: number; rssMB: number; heapMB?: number };
/** `gc`: collect first, so the heap is what the subscriptions hold. */
type Target = { url: string; stats(gc?: boolean): Promise<Stats>; stop(): Promise<void> };

/** A bunvex server of its own, for one cell. */
async function spawnServer(): Promise<Target> {
  // A store of its own: the memory store keeps a log file under DATA and replays it when it opens.
  const data = mkdtempSync(join(tmpdir(), "bench-subscriptions-"));
  const port = Promise.withResolvers<number>();
  let cpu = Promise.withResolvers<Stats>();
  // PROFILE=<dir>: a CPU profile of the server (Bun's markdown one), written when it exits.
  const prof = process.env.PROFILE ? ["--cpu-prof-md", `--cpu-prof-dir=${process.env.PROFILE}`] : [];
  const server = Bun.spawn(["bun", ...prof, import.meta.path, "server"], {
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      PERSISTENCE: process.env.PERSISTENCE ?? "memory",
      DATA: data,
      DO_NOT_REQUIRE_SSL: "1",
      ...(process.env.SPLAY ? {} : { SUBSCRIPTION_INVALIDATION_DELAY_MULTIPLIER: "0" }),
    },
    ipc(m: { port?: number; cpuMs?: number; rssMB?: number }) {
      if (m.port !== undefined) port.resolve(m.port);
      if (m.cpuMs !== undefined) cpu.resolve(m as Stats);
    },
  });
  children.add(server);
  return {
    url: `http://127.0.0.1:${await port.promise}`,
    stats: async (gc = false) => {
      cpu = Promise.withResolvers();
      server.send({ gc });
      return cpu.promise;
    },
    stop: async () => {
      server.send({ exit: true });
      await server.exited;
      rmSync(data, { recursive: true, force: true });
    },
  };
}

/**
 * A backend already running (TARGET_URL, its process TARGET_PID): Convex's, from
 * packages/differential/scripts/s184-invalidation-oracle.ts. Its CPU and memory come from `ps` (10 ms steps).
 */
function externalTarget(url: string, pid: number): Target {
  return {
    url,
    stats: async () => {
      const out = Bun.spawnSync(["ps", "-o", "time=,rss=", "-p", String(pid)])
        .stdout.toString()
        .trim();
      const [time = "0:0", rss = "0"] = out.split(/\s+/);
      const parts = time.split(":").map(Number);
      const secs = parts.reduce((a, b) => a * 60 + b, 0);
      return { cpuMs: secs * 1000, rssMB: Number(rss) / 1024 };
    },
    stop: async () => {},
  };
}

async function runCell(n: number, fanout: string): Promise<Cell> {
  const groups = groupsOf(fanout, n);
  const target = process.env.TARGET_URL
    ? externalTarget(process.env.TARGET_URL, Number(process.env.TARGET_PID))
    : await spawnServer();
  const serverStats = target.stats;
  const base = target.url;
  const p = Number(new URL(base).port);
  const call = async (path: string, args: object) => {
    const r = await fetch(`${base}/api/mutation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" }),
    });
    const body = await r.text();
    if (!body.startsWith('{"status":"success"')) throw new Error(`${path}: ${body}`);
  };

  // Clients: each holds a slice of the subscriptions over its share of the sockets.
  const clients: { proc: ReturnType<typeof Bun.spawn>; state: { initial: number; updates: number; failed: number } }[] =
    [];
  const statsWait: ((x: { lat: number[]; updates: number }) => void)[] = [];
  let progress: (() => void) | null = null;
  const t0 = performance.now();
  const nClients = n === 0 ? 0 : Math.min(CLIENTS, n);
  const perSocket = Math.max(PER_SOCKET, Math.ceil(n / MAX_SOCKETS));
  const sockets = Math.ceil(n / perSocket);
  for (let c = 0; c < nClients; c++) {
    const from = Math.floor((n * c) / nClients);
    const to = Math.floor((n * (c + 1)) / nClients);
    const state = { initial: 0, updates: 0, failed: 0 };
    const proc = Bun.spawn(
      [
        "bun",
        import.meta.path,
        "client",
        String(p),
        String(from),
        String(to),
        String(groups),
        String(Math.ceil(sockets / nClients)),
      ],
      {
        stdout: "inherit",
        stderr: "inherit",
        ipc(m: { initial: number; updates: number; failed: number; lat?: number[] }) {
          Object.assign(state, { initial: m.initial, updates: m.updates, failed: m.failed });
          if (m.lat) statsWait.shift()?.({ lat: m.lat, updates: m.updates });
          progress?.();
        },
      },
    );
    children.add(proc);
    clients.push({ proc, state });
  }
  const total = (k: "initial" | "updates" | "failed") => clients.reduce((s, c) => s + c.state[k], 0);
  const until = async (cond: () => boolean, ms: number) => {
    const end = performance.now() + ms;
    while (!cond() && performance.now() < end)
      await new Promise<void>((r) => {
        progress = r;
        setTimeout(r, 50);
      });
    progress = null;
    return cond();
  };
  if (!(await until(() => total("initial") >= n, 600_000))) throw new Error(`subscribed ${total("initial")} of ${n}`);
  const setupS = (performance.now() - t0) / 1000;
  const idle = await serverStats(true);
  const collect = async () => {
    const ps = clients.map(() => new Promise<{ lat: number[]; updates: number }>((r) => statsWait.push(r)));
    for (const c of clients) c.proc.send({ stats: true });
    const got = await Promise.all(ps);
    return got.flatMap((x) => x.lat);
  };
  await collect(); // drop the setup's samples

  // Isolated commits, after a warm-up (the JIT, the first transitions).
  let expected = total("updates");
  const isolated = async (count: number) => {
    const walls: number[] = [];
    for (let k = 0; k < count; k++) {
      const g = Math.floor(Math.random() * groups);
      expected += inGroup(n, groups, g);
      const s = performance.now();
      await call("subs:bump", { g, t: now() });
      if (!(await until(() => total("updates") >= expected, 120_000)))
        throw new Error(`updates ${total("updates")} of ${expected}`);
      walls.push(performance.now() - s);
    }
    return walls;
  };
  const invalidated = n === 0 ? 0 : n / groups;
  const scale = (k: number) => Math.max(10, Math.min(k, Math.floor((k * 1000) / Math.max(1000, invalidated))));
  await isolated(scale(WARMUP));
  const commitsIso = scale(COMMITS);
  const c0 = await serverStats();
  const walls = await isolated(commitsIso);
  const c1 = await serverStats();
  const isoLat = await collect();

  // Saturated.
  const u0 = total("updates");
  const s0 = await serverStats();
  const ts0 = performance.now();
  const end = ts0 + SECS * 1000;
  let commits = 0;
  await Promise.all(
    Array.from({ length: WRITERS }, async () => {
      while (performance.now() < end) {
        await call("subs:bump", { g: Math.floor(Math.random() * groups), t: now() });
        commits++;
      }
    }),
  );
  const s1 = await serverStats();
  const wall = (performance.now() - ts0) / 1000;
  const u1 = total("updates");
  // What is in flight: wait until the updates stop.
  let last = -1;
  while (total("updates") !== last) {
    last = total("updates");
    await Bun.sleep(1000);
  }
  const satLat = await collect();
  const failed = total("failed");
  for (const c of clients) c.proc.kill();
  await Promise.all([target.stop(), ...clients.map((c) => c.proc.exited)]);
  return {
    N: n,
    fanout,
    invalidatedPerCommit: n === 0 ? 0 : Math.round(n / groups),
    setupS: Number(setupS.toFixed(1)),
    rssMB: Math.round(idle.rssMB),
    heapMB: Math.round(idle.heapMB ?? Number.NaN),
    perSocket,
    sockets: n === 0 ? 0 : sockets,
    isoCommits: commitsIso,
    isoCpuMsPerCommit: Number(((c1.cpuMs - c0.cpuMs) / commitsIso).toFixed(3)),
    isoWallP50ms: pct(walls, 0.5),
    isoLatP50ms: pct(isoLat, 0.5),
    isoLatP99ms: pct(isoLat, 0.99),
    satCommitsPerSec: Math.round(commits / wall),
    satServerCores: Number(((s1.cpuMs - s0.cpuMs) / 1000 / wall).toFixed(2)),
    satUpdatesPerSec: Math.round((u1 - u0) / wall),
    satUpdatesPerCommit: Number(((u1 - u0) / Math.max(1, commits)).toFixed(1)),
    satLatP50ms: pct(satLat, 0.5),
    satLatP99ms: pct(satLat, 0.99),
    failed,
  };
}

if (process.argv[2] === "server") await runServer();
else if (process.argv[2] === "client") await runClient();
else {
  const rows: Cell[] = [];
  for (const n of NS)
    for (const f of n === 0 ? ["none"] : FANOUTS) {
      // The previous cell's sockets sit in TIME_WAIT (30 s on macOS) and hold their ephemeral ports.
      if (rows.length > 0 && Number(rows.at(-1)!.sockets) > 2000) await Bun.sleep(35_000);
      const row = await runCell(n, f);
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  process.exit(0);
}

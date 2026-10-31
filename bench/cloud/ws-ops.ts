// bench/cloud: operations per second over the sync WebSocket, what an app's client does, driven the same way against
// Convex and bunvex. A raw WebSocket client sends the same bytes to either (Connect, ModifyQuerySet, Mutation), so
// the run measures the server and not a product's client library. Runs on the load box, as fanout.ts; PROCS worker
// processes hold the connections, so one JS thread does not become the generator's limit (the result says if one did).
//
// Scenarios (SCENARIO), all with the functions of bench/functions.ts:
//   insert          each connection keeps DEPTH `bench:insertItem` mutations in flight (closed loop).
//   increment       the same with `bench:increment` over 1 000 counters.
//   query-cached    each connection subscribes to `bench:listCached` and drops it, DEPTH at a time: the server
//                   answers from its query cache, as a client that opens a screen another client already has open.
//   query-uncached  the same with `bench:listByTenant` and a fresh argument each time: every one is executed.
//   chat            what a reactive app does: every connection holds a subscription to `bench:latestMessage` of its
//                   room (PER_ROOM connections to a room) and posts a message every THINK_MS. Reported: the mutation's
//                   acknowledgement, and the time from a post to the update that carries it at a subscriber.
//
// A server runs the mutations of one connection one at a time (Convex's `buffered(1)`, bunvex's connection queue), so
// DEPTH above 1 only fills that queue: capacity scales with CONNS. Latency is from the send to the response (a query:
// to the Transition that has its result). Only completions between WARMUP and WARMUP+SECS count.
//   CLIENT=bunvex TARGET_URL=http://10.0.0.2:3210 SCENARIO=chat CONNS=512 bun bench/cloud/ws-ops.ts
// Env: TARGET_URL, SCENARIO (insert), CONNS (64), DEPTH (1), SECS (15), WARMUP (3), PROCS (cores), THINK_MS (1000),
//      PER_ROOM (10), VERSION (1.48.0, the sync path's version segment), LABEL (printed back).
// Prints one JSON line.

const url = process.env.TARGET_URL;
if (!url) throw new Error("TARGET_URL is required");
const SCENARIOS = ["insert", "increment", "query-cached", "query-uncached", "chat"] as const;
type Scenario = (typeof SCENARIOS)[number];
const scenario = (process.env.SCENARIO ?? "insert") as Scenario;
if (!SCENARIOS.includes(scenario)) throw new Error(`SCENARIO=${scenario}: one of ${SCENARIOS.join(", ")}`);
const CONNS = Number(process.env.CONNS ?? 64);
const DEPTH = Number(process.env.DEPTH ?? 1);
const SECS = Number(process.env.SECS ?? 15);
const WARMUP = Number(process.env.WARMUP ?? 3);
const THINK_MS = Number(process.env.THINK_MS ?? 1000);
const PER_ROOM = Number(process.env.PER_ROOM ?? 10);
const wsUrl = `${url.replace(/^http/, "ws")}/api/${process.env.VERSION ?? "1.48.0"}/sync`;

/** Milliseconds since the epoch with the clock's sub-millisecond part: comparable across this box's processes. */
const now = () => performance.timeOrigin + performance.now();

type Frame = {
  type: string;
  requestId?: number;
  success?: boolean;
  modifications?: { type: string; queryId: number; value?: { sentAt?: number } | null }[];
};

type WorkerReport = {
  ops: number;
  errors: number;
  lat: number[];
  updates: number;
  updateLat: number[];
  cpuSeconds: number;
  closed: number;
  /** How the server closed connections during the run: "code reason" → count. */
  closes: Record<string, number>;
};

if (process.env.WS_WORKER) {
  // A worker: `count` connections, global indexes from `first`. Reports "ready" once they are open (and, for chat,
  // each has its first result), starts on "go" (the epoch ms to start at) and sends its report at the end.
  const count = Number(process.env.COUNT);
  const first = Number(process.env.FIRST);
  const runId = process.env.RUN_ID!;
  let winStart = Number.POSITIVE_INFINITY;
  let winEnd = Number.POSITIVE_INFINITY;
  let stopped = false;
  const lat: number[] = [];
  const updateLat: number[] = [];
  let ops = 0;
  let errors = 0;
  let updates = 0;
  let closed = 0;
  const closes: Record<string, number> = {};

  type Conn = {
    ws: WebSocket;
    idx: number;
    seq: number;
    version: number;
    next: number;
    /** requestId (a mutation) or queryId (a query) → when it was sent. */
    inflight: Map<number, number>;
    lastSeen: number;
    firstResult?: () => void;
  };
  const send = (c: Conn, m: object) => c.ws.send(JSON.stringify(m));
  const inWindow = (t: number) => t >= winStart && t < winEnd;

  const mutationOf = (c: Conn): { udfPath: string; args: object } => {
    const n = c.idx * 1_000_000_000 + c.seq++;
    switch (scenario) {
      case "increment":
        return { udfPath: "bench:increment", args: { key: `k${Math.floor(Math.random() * 1000)}` } };
      case "chat":
        return { udfPath: "bench:postMessage", args: { room: roomOf(c.idx), sentAt: now() } };
      default:
        return { udfPath: "bench:insertItem", args: { tenantId: `t${n % 1000}` } };
    }
  };
  const roomOf = (idx: number) => `ws${runId}-${Math.floor(idx / PER_ROOM)}`;

  const fireMutation = (c: Conn) => {
    const requestId = c.next++;
    const { udfPath, args } = mutationOf(c);
    c.inflight.set(requestId, now());
    send(c, { type: "Mutation", requestId, udfPath, args: [args] });
  };

  /** Drops the query `drop` (if any) and adds the next one, in one ModifyQuerySet. */
  const fireQuery = (c: Conn, drop?: number) => {
    const queryId = c.next++;
    const n = c.idx * 1_000_000_000 + c.seq++;
    const modifications: object[] = [];
    if (drop !== undefined) modifications.push({ type: "Remove", queryId: drop });
    modifications.push(
      scenario === "query-cached"
        ? { type: "Add", queryId, udfPath: "bench:listCached", args: [{}] }
        : { type: "Add", queryId, udfPath: "bench:listByTenant", args: [{ tenantId: `t${n % 1000}`, n }] },
    );
    c.inflight.set(queryId, now());
    send(c, { type: "ModifyQuerySet", baseVersion: c.version, newVersion: ++c.version, modifications });
  };

  const onFrame = (c: Conn, data: string) => {
    const f = JSON.parse(data) as Frame;
    const t = now();
    if (f.type === "MutationResponse") {
      const t0 = c.inflight.get(f.requestId!);
      if (t0 === undefined) return;
      c.inflight.delete(f.requestId!);
      if (inWindow(t)) {
        if (f.success) {
          ops++;
          lat.push(t - t0);
        } else errors++;
      }
      if (scenario !== "chat" && !stopped && t < winEnd) fireMutation(c);
      return;
    }
    if (f.type !== "Transition") return;
    for (const m of f.modifications ?? []) {
      if (m.type !== "QueryUpdated" && m.type !== "QueryFailed") continue;
      if (scenario === "chat") {
        c.firstResult?.();
        c.firstResult = undefined;
        const sentAt = m.value?.sentAt;
        // A later update carries a later post; one at or before the last seen is another connection's older post.
        if (m.type === "QueryUpdated" && sentAt !== undefined && sentAt > c.lastSeen) {
          c.lastSeen = sentAt;
          if (inWindow(t)) {
            updates++;
            updateLat.push(t - sentAt);
          }
        }
        continue;
      }
      const t0 = c.inflight.get(m.queryId);
      if (t0 === undefined) continue;
      c.inflight.delete(m.queryId);
      if (inWindow(t)) {
        if (m.type === "QueryUpdated") {
          ops++;
          lat.push(t - t0);
        } else errors++;
      }
      if (!stopped && t < winEnd) fireQuery(c, m.queryId);
    }
  };

  const open = async (idx: number): Promise<Conn> => {
    const ws = new WebSocket(wsUrl);
    const c: Conn = { ws, idx, seq: 0, version: 0, next: 0, inflight: new Map(), lastSeen: 0 };
    ws.onmessage = (e) => onFrame(c, String(e.data));
    ws.onclose = (e) => {
      if (stopped) return;
      closed++;
      const why = `${e.code} ${e.reason}`.trim().slice(0, 120);
      closes[why] = (closes[why] ?? 0) + 1;
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`could not connect to ${wsUrl}`));
    });
    send(c, {
      type: "Connect",
      sessionId: crypto.randomUUID(),
      connectionCount: 0,
      lastCloseReason: null,
      clientTs: Date.now(),
    });
    return c;
  };

  const conns: Conn[] = [];
  // Opened in batches: a server's accept queue is not what this measures.
  for (let i = 0; i < count; i += 100) {
    const batch = await Promise.all(Array.from({ length: Math.min(100, count - i) }, (_, j) => open(first + i + j)));
    conns.push(...batch);
  }
  if (scenario === "chat") {
    const results = conns.map((c) => new Promise<void>((resolve) => (c.firstResult = resolve)));
    for (const c of conns)
      send(c, {
        type: "ModifyQuerySet",
        baseVersion: c.version,
        newVersion: ++c.version,
        modifications: [
          { type: "Add", queryId: c.next++, udfPath: "bench:latestMessage", args: [{ room: roomOf(c.idx) }] },
        ],
      });
    await Promise.all(results);
  }
  process.send!({ ready: true });

  process.on("message", async (msg: { go?: number }) => {
    if (msg.go === undefined) return;
    winStart = msg.go + WARMUP * 1000;
    winEnd = winStart + SECS * 1000;
    await Bun.sleep(Math.max(0, msg.go - now()));
    if (scenario === "chat") {
      // One post every THINK_MS from each connection, at a random phase, on a fixed schedule (a slow answer does not
      // delay the next post).
      for (const c of conns) {
        let due = now() + Math.random() * THINK_MS;
        const tick = () => {
          if (stopped || now() >= winEnd) return;
          fireMutation(c);
          due += THINK_MS;
          setTimeout(tick, Math.max(0, due - now()));
        };
        setTimeout(tick, Math.max(0, due - now()));
      }
    } else {
      for (const c of conns)
        for (let d = 0; d < DEPTH; d++) {
          if (scenario.startsWith("query")) fireQuery(c);
          else fireMutation(c);
        }
    }
    await Bun.sleep(Math.max(0, winStart - now()));
    const cpu0 = process.cpuUsage();
    await Bun.sleep(Math.max(0, winEnd - now()));
    const cpu1 = process.cpuUsage(cpu0);
    stopped = true;
    const report: WorkerReport = {
      ops,
      errors,
      lat,
      updates,
      updateLat,
      cpuSeconds: (cpu1.user + cpu1.system) / 1e6,
      closed,
      closes,
    };
    process.send!({ report });
    await Bun.sleep(200);
    for (const c of conns) c.ws.close();
    process.exit(0);
  });
} else {
  const procs = Math.min(Number(process.env.PROCS ?? navigator.hardwareConcurrency), CONNS);
  const runId = `${Date.now()}`;
  const timeout = (SECS + WARMUP) * 1000 + 120_000;
  let ready = 0;
  let allReady!: () => void;
  const readyAll = new Promise<void>((r) => (allReady = r));
  const reports: WorkerReport[] = [];
  let reported!: () => void;
  const reportedAll = new Promise<void>((r) => (reported = r));
  let first = 0;
  const workers = Array.from({ length: procs }, (_, i) => {
    const count = Math.floor(CONNS / procs) + (i < CONNS % procs ? 1 : 0);
    const w = Bun.spawn(["bun", import.meta.path], {
      env: { ...process.env, WS_WORKER: "1", COUNT: String(count), FIRST: String(first), RUN_ID: runId },
      stdout: "inherit",
      stderr: "inherit",
      ipc(msg: { ready?: boolean; report?: WorkerReport }) {
        if (msg.ready && ++ready === procs) allReady();
        if (msg.report && reports.push(msg.report) === procs) reported();
      },
    });
    first += count;
    return w;
  });
  const exited = Promise.race(
    workers.map((w) =>
      w.exited.then((code) =>
        code === 0 ? new Promise<never>(() => {}) : Promise.reject(new Error(`a worker exited with ${code}`)),
      ),
    ),
  );
  const deadline = (what: string) =>
    Bun.sleep(timeout).then(() => {
      for (const w of workers) w.kill("SIGKILL");
      return Promise.reject(new Error(`${what} within ${timeout} ms`));
    });
  await Promise.race([readyAll, exited, deadline("not every connection opened")]);
  const go = now() + 1000;
  for (const w of workers) w.send({ go });
  await Promise.race([reportedAll, exited, deadline("not every worker reported")]);

  const sorted = (xs: number[]) => xs.toSorted((a, b) => a - b);
  const at = (xs: number[], q: number) =>
    xs.length === 0 ? null : xs[Math.min(xs.length - 1, Math.floor(q * xs.length))]!;
  const lat = sorted(reports.flatMap((r) => r.lat));
  const updateLat = sorted(reports.flatMap((r) => r.updateLat));
  const sum = (f: (r: WorkerReport) => number) => reports.reduce((a, r) => a + f(r), 0);
  const ops = sum((r) => r.ops);
  const cores = reports.map((r) => r.cpuSeconds / SECS);
  const round = (x: number | null, digits = 2) => (x === null ? null : Number(x.toFixed(digits)));
  const result = {
    label: process.env.LABEL ?? "",
    scenario,
    // The measured window, epoch ms on this box's clock: a driver on the same box samples the server's CPU over it.
    windowStart: Math.round(go + WARMUP * 1000),
    windowEnd: Math.round(go + (WARMUP + SECS) * 1000),
    conns: CONNS,
    depth: DEPTH,
    secs: SECS,
    ops,
    opsPerSec: Math.round(ops / SECS),
    errors: sum((r) => r.errors),
    p50: round(at(lat, 0.5)),
    p99: round(at(lat, 0.99)),
    max: round(lat.at(-1) ?? null),
    ...(scenario === "chat"
      ? {
          updates: sum((r) => r.updates),
          updatesPerSec: Math.round(sum((r) => r.updates) / SECS),
          updateP50: round(at(updateLat, 0.5)),
          updateP99: round(at(updateLat, 0.99)),
        }
      : {}),
    closed: sum((r) => r.closed),
    closes: reports.reduce<Record<string, number>>((all, r) => {
      for (const [why, n] of Object.entries(r.closes)) all[why] = (all[why] ?? 0) + n;
      return all;
    }, {}),
    // The generator's own CPU: a worker near 1 core is the limit of the run, not the server.
    loadCores: round(cores.reduce((a, b) => a + b, 0)),
    maxWorkerCores: round(Math.max(...cores)),
  };
  console.log(JSON.stringify(result));
  await Promise.all(workers.map((w) => w.exited));
  process.exit(0);
}

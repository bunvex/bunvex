// The committer's write log (STUDY-06 D10), in process on the memory driver.
//   bun bench/write-log.ts throughput   W writers commit as fast as they can for SECS: commits/s, log size, RSS
//   bun bench/write-log.ts lag          W noise writers + transactions committing at a snapshot LAG_MS old:
//                                       how many of those fail (conflict or out of retention) though they read
//                                       nothing the noise wrote (STUDY-24 §4.2, A2)
//   bun bench/write-log.ts calibrate    the heap a log entry really takes vs `logEntryBytes`
// Env: W (default 64), SECS (default 10), LAG_MS (default 500), RATE (lag: noise commits/s, default as fast
// as possible), COMMITTER (module exporting `Committer`,
// default @bunvex/core: point it at another build to compare), PERSIST (`memory`, default, or `null`: a
// driver that keeps nothing, so the RSS is the committer's own), HARD_MAX_MB (the optional hard cap).
import { encodeKey, type IndexWrite, type Persistence } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";

const W = Number(process.env.W ?? 64);
const SECS = Number(process.env.SECS ?? 10);
const LAG_MS = Number(process.env.LAG_MS ?? 500);
const RATE = Number(process.env.RATE ?? 0); // lag: cap the noise at about this many commits/s (0: no cap)
const { Committer } = (await import(process.env.COMMITTER ?? "@bunvex/core")) as typeof import("@bunvex/core");
const retention = process.env.HARD_MAX_MB ? { hardMaxBytes: Number(process.env.HARD_MAX_MB) * 2 ** 20 } : {};
const mb = (n: number) => Math.round(n / 2 ** 20);
const pct = (xs: number[], p: number) =>
  xs.length
    ? Number([...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))].toFixed(2))
    : null;
const open = async (): Promise<Persistence> =>
  process.env.PERSIST === "null"
    ? ({ apply() {}, async flush() {} } as unknown as Persistence)
    : MemoryPersistence.open(null, { durable: false });

// The insert of a typical document: three index entries (by_id, a two-field index, by_creation_time).
function itemWrite(tenant: string, createdAt: number) {
  const id = crypto.randomUUID();
  const json = JSON.stringify({ tenantId: tenant, title: "new item", status: "open", amount: 42, createdAt });
  const idx: IndexWrite[] = [
    { index: 1, key: encodeKey([id]), id },
    { index: 2, key: encodeKey([tenant, createdAt, id]), id },
    { index: 3, key: encodeKey([createdAt, id]), id },
  ];
  return { docs: [{ table: 1, id, json }], idx };
}

type Stats = { logLength?: number; logBytes?: number; outOfRetention?: number; conflicts: number; groups: number };

async function throughput() {
  const c = new Committer(await open(), retention);
  let ok = 0;
  const t0 = performance.now();
  const end = t0 + SECS * 1000;
  await Promise.all(
    Array.from({ length: W }, async (_, w) => {
      while (performance.now() < end) {
        const { docs, idx } = itemWrite(`t${w}`, Date.now());
        await c.commit({ snapshot: c.visibleTs, reads: [], docs, idx });
        ok++;
      }
    }),
  );
  const secs = (performance.now() - t0) / 1000;
  Bun.gc(true);
  const s = c as unknown as Stats;
  console.log(
    JSON.stringify({
      bench: "throughput",
      persist: process.env.PERSIST ?? "memory",
      W,
      secs: SECS,
      commits_per_s: Math.round(ok / secs),
      commits: ok,
      log_entries: s.logLength ?? null,
      log_estimate_mb: s.logBytes === undefined ? null : mb(s.logBytes),
      heap_mb: mb(process.memoryUsage().heapUsed),
      rss_mb: mb(process.memoryUsage().rss),
    }),
  );
}

async function lag() {
  const c = new Committer(await open(), retention);
  const history: { t: number; ts: number }[] = []; // visibleTs over time, to take snapshots LAG_MS old
  let noise = 0;
  let attempts = 0;
  let failed = 0;
  const latencies: number[] = []; // per lagged commit, ms (validation against the lag's worth of log)
  const t0 = performance.now();
  const end = t0 + SECS * 1000;
  const sampler = setInterval(() => history.push({ t: performance.now(), ts: c.visibleTs }), 1);
  const noiseWriters = Array.from({ length: W }, async (_, w) => {
    while (performance.now() < end) {
      const { docs, idx } = itemWrite(`t${w}`, Date.now());
      await c.commit({ snapshot: c.visibleTs, reads: [], docs, idx });
      noise++;
      if (RATE) await Bun.sleep((W * 1000) / RATE);
    }
  });
  // Lagged transactions read a key of index 9 that no noise commit writes: they must all commit.
  const lagged = (async () => {
    let n = 0;
    while (performance.now() < end) {
      await Bun.sleep(5);
      const cutoff = performance.now() - LAG_MS;
      if (cutoff < t0) continue;
      let snap: number | undefined;
      for (let i = history.length - 1; i >= 0; i--)
        if (history[i].t <= cutoff) {
          snap = history[i].ts;
          break;
        }
      if (snap === undefined) continue;
      const name = `lagged${n++}`;
      const k = encodeKey([name]);
      const reads = [{ index: 9, lo: k, hi: encodeKey([`${name}\u0000`]) }];
      attempts++;
      const t = performance.now();
      try {
        await c.commit({ snapshot: snap, reads, docs: [], idx: [{ index: 9, key: k, id: `l${n}` }] });
      } catch {
        failed++;
      }
      latencies.push(performance.now() - t);
    }
  })();
  await Promise.all([...noiseWriters, lagged]);
  clearInterval(sampler);
  const secs = (performance.now() - t0) / 1000;
  console.log(
    JSON.stringify({
      bench: "lag",
      persist: process.env.PERSIST ?? "memory",
      W,
      lag_ms: LAG_MS,
      noise_commits_per_s: Math.round(noise / secs),
      lagged_attempts: attempts,
      lagged_failed_pct: Number(((100 * failed) / Math.max(1, attempts)).toFixed(1)),
      lagged_commit_ms_p50: pct(latencies, 0.5),
      lagged_commit_ms_p99: pct(latencies, 0.99),
      conflicts: c.conflicts,
      out_of_retention: (c as unknown as Stats).outOfRetention ?? null,
      rss_mb: mb(process.memoryUsage().rss),
    }),
  );
}

async function calibrate() {
  // Through a committer on a driver that keeps nothing: the heap that remains is the write log, with the
  // per-index columns validation looks writes up in (STUDY-06 D11).
  const N = 200_000;
  const c = new Committer({ apply() {}, async flush() {} } as unknown as Persistence, {
    minRetentionUs: 3.6e9,
    maxRetentionUs: 3.6e9,
    softMaxBytes: 2 ** 40,
  });
  Bun.gc(true);
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < N; i += 1000) {
    const batch: Promise<number>[] = [];
    for (let j = i; j < i + 1000; j++) {
      const { idx } = itemWrite(`t${j % 64}`, 1.79e12 + j);
      batch.push(c.commit({ snapshot: c.visibleTs, reads: [], docs: [], idx }));
    }
    await Promise.all(batch);
  }
  Bun.gc(true);
  const real = process.memoryUsage().heapUsed - before;
  const s = c as unknown as Stats;
  console.log(
    JSON.stringify({
      bench: "calibrate",
      entries: s.logLength,
      real_bytes_per_entry: Math.round(real / N),
      estimated_bytes_per_entry: Math.round((s.logBytes ?? 0) / N),
    }),
  );
}

const which = process.argv[2] ?? "throughput";
if (which === "throughput") await throughput();
else if (which === "lag") await lag();
else if (which === "calibrate") await calibrate();
else throw new Error(`unknown bench ${which}`);

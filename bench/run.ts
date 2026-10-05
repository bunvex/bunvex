// ENGINE-00 microbenchmarks, in-process (no HTTP). `bun bench/run.ts [m1|m2|m3|m4|all]`
// Env: DIR (scratch dir for data files, default ./.data), SECS (per trial, default 5).

import { mkdirSync, rmSync } from "node:fs";
import {
  Committer,
  compareKeys,
  encodeKey,
  type IndexWrite,
  type KeyValue,
  type Persistence,
  prefixEnd,
} from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { compareValues } from "@bunvex/values";

const DIR = process.env.DIR ?? `${import.meta.dir}/../.data`;
const SECS = Number(process.env.SECS ?? 5);
mkdirSync(DIR, { recursive: true });
const which = process.argv[2] ?? "all";
const results: Record<string, unknown>[] = [];
const report = (r: Record<string, unknown>) => {
  results.push(r);
  console.log(JSON.stringify(r));
};
const pct = (a: number[], q: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? Number(s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(3)) : null;
};

// ------------------------------------------------------------------ M1: key encoding

function m1() {
  // correctness first: byte order must equal value order (mixed types included)
  const rnd = (): KeyValue => {
    const r = Math.random();
    if (r < 0.05) return null;
    if (r < 0.1) return Math.random() < 0.5;
    if (r < 0.55) {
      const pick = [0, -0, 1, -1, 1e-300, -1e-300, 2 ** 53, -(2 ** 53), Number.MAX_VALUE, -Number.MAX_VALUE];
      return Math.random() < 0.2 ? pick[Math.floor(Math.random() * pick.length)] : (Math.random() - 0.5) * 1e6;
    }
    const len = Math.floor(Math.random() * 6);
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode([0, 1, 97, 98, 0xe9, 0x4e2d][Math.floor(Math.random() * 6)]);
    return s;
  };
  const cmpVal = (a: KeyValue, b: KeyValue): number => compareValues(a, b); // Convex's order (STUDY-18)
  const tuples = Array.from({ length: 20000 }, () => [rnd(), rnd()] as KeyValue[]);
  const byVal = [...tuples].sort((a, b) => cmpVal(a[0], b[0]) || cmpVal(a[1], b[1]));
  const byKey = [...tuples].sort((a, b) => compareKeys(encodeKey(a), encodeKey(b)));
  let mismatches = 0;
  for (let i = 0; i < byVal.length; i++)
    if (cmpVal(byVal[i][0], byKey[i][0]) !== 0 || cmpVal(byVal[i][1], byKey[i][1]) !== 0) mismatches++;

  // throughput: a typical index tuple (tenantId, createdAt, id)
  const sample = Array.from({ length: 1000 }, (_, i) => [`t${i % 1000}`, 1.79e12 + i, crypto.randomUUID()]);
  let n = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 1000) for (const s of sample) encodeKey(s), n++;
  const encPerS = Math.round(n / ((performance.now() - t0) / 1000));
  const keys = sample.map(encodeKey);
  let c = 0;
  const t1 = performance.now();
  while (performance.now() - t1 < 1000) for (let i = 1; i < keys.length; i++) compareKeys(keys[i - 1], keys[i]), c++;
  const cmpPerS = Math.round(c / ((performance.now() - t1) / 1000));
  report({ m: "M1", order_mismatches: mismatches, of: tuples.length, encodes_per_s: encPerS, compares_per_s: cmpPerS });
}

// ------------------------------------------------------------------ workload shared by M2/M3

const T_ITEMS = 1;
const I_BY_TENANT_CREATED = 1;
const I_BY_CREATION = 2;
function itemWrite(tenant: string, createdAt: number) {
  const id = crypto.randomUUID();
  const json = JSON.stringify({ tenantId: tenant, title: "new item", status: "open", amount: 42, createdAt });
  const idx: IndexWrite[] = [
    { index: I_BY_TENANT_CREATED, key: encodeKey([tenant, createdAt, id]), id },
    { index: I_BY_CREATION, key: encodeKey([createdAt, id]), id },
  ];
  return { docs: [{ table: T_ITEMS, id, json }], idx };
}

async function makeStorage(kind: string, durable: boolean): Promise<Persistence> {
  const f = `${DIR}/${kind}-${durable ? "d" : "n"}`;
  rmSync(f, { force: true });
  rmSync(`${f}-wal`, { force: true });
  rmSync(`${f}-shm`, { force: true });
  if (kind === "sqlite") return new SqlitePersistence(f, { durable });
  return MemoryPersistence.open(f, { durable });
}

// ------------------------------------------------------------------ M2: durable commits

async function m2() {
  for (const kind of ["sqlite", "memory"]) {
    for (const durable of [true, false]) {
      for (const conc of [1, 16, 128]) {
        const st = await makeStorage(kind, durable);
        const c = new Committer(st);
        const lat: number[] = [];
        let ok = 0;
        const end = performance.now() + SECS * 1000;
        await Promise.all(
          Array.from({ length: conc }, async (_, w) => {
            while (performance.now() < end) {
              const { docs, idx } = itemWrite(`t${w % 1000}`, Date.now());
              const t0 = performance.now();
              // At the latest snapshot (one before the write log's retention is refused); no reads: validation is a no-op.
              await c.commit({ snapshot: c.visibleTs, reads: [], docs, idx });
              lat.push(performance.now() - t0);
              ok++;
            }
          }),
        );
        report({
          m: "M2",
          storage: kind,
          durable,
          conc,
          commits_per_s: Math.round(ok / SECS),
          avg_group: Number((ok / Math.max(1, c.groups)).toFixed(1)),
          p50_ms: pct(lat, 0.5),
          p99_ms: pct(lat, 0.99),
        });
        await st.close();
      }
    }
  }
}

// ------------------------------------------------------------------ M3: snapshot range reads

async function m3() {
  for (const kind of ["sqlite", "memory"]) {
    const st = await makeStorage(kind, false);
    const c = new Committer(st);
    // 1000 tenants x 100 items, committed in groups of 1000 (the seed does not measure anything)
    const base = 1.79e12;
    for (let t = 0; t < 1000; t++) {
      const batch: Promise<number>[] = [];
      for (let i = 0; i < 100; i++) {
        const { docs, idx } = itemWrite(`t${t}`, base + i * 1000);
        batch.push(c.commit({ snapshot: c.visibleTs, reads: [], docs, idx }));
      }
      await Promise.all(batch);
    }
    const ts = c.visibleTs;
    // listByTenant: withIndex(by_tenant_created, eq tenant).order(desc).take(20) + fetch the 20 docs
    const lat: number[] = [];
    let n = 0;
    const end = performance.now() + SECS * 1000;
    while (performance.now() < end) {
      const tenant = `t${Math.floor(Math.random() * 1000)}`;
      const t0 = performance.now();
      const prefix = encodeKey([tenant]); // the prefix of every key of this tenant
      // M3 only runs the embedded drivers, which answer synchronously: no await inside the timed loop.
      const ids = st.scan(I_BY_TENANT_CREATED, prefix, prefixEnd(prefix), ts, 20, true) as string[];
      let bytes = 0;
      for (const id of ids) bytes += (st.get(T_ITEMS, id, ts) as string | null)?.length ?? 0;
      lat.push(performance.now() - t0);
      if (ids.length !== 20 || bytes === 0) throw new Error(`bad read: ${ids.length}`);
      n++;
    }
    report({
      m: "M3",
      storage: kind,
      docs: 100000,
      queries_per_s_1core: Math.round(n / SECS),
      p50_ms: pct(lat, 0.5),
      p99_ms: pct(lat, 0.99),
      rss_mb: Math.round(process.memoryUsage().rss / 1048576),
    });
    await st.close();
  }
}

// ------------------------------------------------------------------ M4: OCC validation

// The write log keeps, per commit, the index keys it wrote. A transaction read at snapshot `ts` and
// recorded its read-set as key intervals; it conflicts iff a commit after `ts` wrote a key inside one.
type Interval = { index: number; lo: Uint8Array; hi: Uint8Array };
type LogEntry = { ts: number; writes: { index: number; key: Uint8Array }[] };

function conflicts(log: LogEntry[], from: number, readSet: Interval[]): boolean {
  for (let i = log.length - 1; i >= 0 && log[i].ts > from; i--)
    for (const w of log[i].writes)
      for (const r of readSet)
        if (r.index === w.index && compareKeys(w.key, r.lo) >= 0 && compareKeys(w.key, r.hi) < 0) return true;
  return false;
}

async function m4() {
  // (a) cost per validation vs how many commits happened since the snapshot
  for (const since of [1, 10, 100, 1000]) {
    const log: LogEntry[] = [];
    for (let i = 1; i <= since; i++)
      log.push({
        ts: i,
        writes: [
          { index: 1, key: encodeKey([`k${i}`]) },
          { index: 2, key: encodeKey([i]) },
        ],
      });
    const p = encodeKey(["zzz"]);
    const readSet: Interval[] = [
      { index: 1, lo: p, hi: prefixEnd(p) },
      { index: 2, lo: encodeKey([1e9]), hi: encodeKey([2e9]) },
    ];
    let n = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 500) conflicts(log, 0, readSet), n++;
    report({ m: "M4a", commits_since_snapshot: since, us_per_validation: Number(((500 * 1000) / n).toFixed(3)) });
  }
  // (b) the read-modify-write over 1 000 DISTINCT keys at 32 in flight (the workload that made
  //     minivex's SERIALIZABLE abort 59 % of attempts): with exact intervals only a REAL collision on
  //     the same key can conflict.
  const KEYS = 1000;
  const CONC = 32;
  const log: LogEntry[] = [];
  let ts = 0;
  let attempts = 0;
  let conflictsN = 0;
  let sameKey = 0;
  const inFlight: { key: number; snap: number }[] = [];
  for (let step = 0; step < 200000; step++) {
    // keep CONC transactions in flight; each started at the ts current when it began
    while (inFlight.length < CONC) inFlight.push({ key: Math.floor(Math.random() * KEYS), snap: ts });
    const tx = inFlight.shift()!;
    attempts++;
    const k = encodeKey([`k${tx.key}`]);
    const readSet: Interval[] = [{ index: 1, lo: k, hi: prefixEnd(k) }];
    if (conflicts(log, tx.snap, readSet)) {
      conflictsN++;
      const real = log.some((e) => e.ts > tx.snap && e.writes.some((w) => compareKeys(w.key, k) === 0));
      if (real) sameKey++;
      inFlight.push({ key: tx.key, snap: ts }); // retry at a fresh snapshot
      continue;
    }
    log.push({ ts: ++ts, writes: [{ index: 1, key: k }] });
    if (log.length > 4096) log.splice(0, log.length - 4096);
  }
  report({
    m: "M4b",
    keys: KEYS,
    in_flight: CONC,
    attempts,
    conflict_pct: Number(((100 * conflictsN) / attempts).toFixed(2)),
    false_conflicts: conflictsN - sameKey,
  });
}

if (which === "m1" || which === "all") m1();
if (which === "m2" || which === "all") await m2();
if (which === "m3" || which === "all") await m3();
if (which === "m4" || which === "all") await m4();
await Bun.write(`${DIR}/results-${Date.now()}.json`, JSON.stringify(results, null, 2));
process.exit(0);

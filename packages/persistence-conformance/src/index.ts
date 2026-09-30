// Package @bunvex/persistence-conformance — the PERSIST-01 suite (docs/specs/PERSIST-01-contract.md). Every
// persistence driver, first-party or not, must pass K1–K7:
//
//   K1 byte order          K2 snapshots          K3 no lost update       K4 cache invalidation
//   K5 atomic visibility   K6 crash atomicity (SIGKILL mid-commit)       K7 torn log tail (log drivers)
// and, for drivers with a lease (PERSIST-01 C7, single writer), K10–K18.
//
// A driver is described by a MODULE (so K6 can re-open it in a child process) exporting:
//   open(fresh: boolean): Promise<Persistence>  — fresh = start from an empty store
//   tearTail?(nextTs: number): void | Promise<void> — log-based drivers only: append half a record (K7)
//
//   import { runConformance } from "@bunvex/persistence-conformance";
//   const { failures } = await runConformance({ name: "mydb", driverModule: "/abs/path/driver.ts" });
import { spawn } from "node:child_process";
import {
  compareKeys,
  type Engine,
  encodeKey,
  hasLease,
  type KeyValue,
  LeaseHeldError,
  LeaseLostError,
  OccError,
  type Persistence,
  type ScanDocs,
} from "@bunvex/core";
import { allOfTenant, counter, increment, insertItem, listTenant, newEngine, pair, seedCounters } from "./workload.ts";

export type DriverModule = {
  open(fresh: boolean): Promise<Persistence>;
  tearTail?(nextTs: number): void | Promise<void>;
  /** Lease drivers (K14): whether some writer is inside a flush right now, holding the fence. Lets K13
   *  pause its stale writer exactly there, instead of wherever a random SIGSTOP lands. */
  writerInsideFlush?(): Promise<boolean>;
};

export type Check = "K1" | "K2" | "K3" | "K6" | "K7" | "K8" | "K9" | "K10"; // K3 also runs K4–K5; K10 runs K10–K18
export type ConformanceOptions = {
  name: string;
  /** Absolute path (or resolvable specifier) of the driver module. */
  driverModule: string;
  /** SIGKILL cycles for K6 (default 8). */
  kills?: number;
  /** Subset of checks (default: all). */
  checks?: Check[];
  log?: (line: string) => void;
  /** The driver claims PERSIST-01 C7 (single writer): its absence is a failure, not a skip. */
  requireLease?: boolean;
};

/** The lease TTL the suite gives its child processes, so a reopen after killing one waits little. */
const CHILD_TTL_MS = 1000;
/** How long a store may keep a paused writer's open transaction before a takeover gets through (K13). */
const IDLE_TX_BOUND_MS = 2500;

const FULL_LO = new Uint8Array(0);
const FULL_HI = Uint8Array.from([0xff, 0xff, 0xff, 0xff]);
const rnd = (n: number) => Math.floor(Math.random() * n);

export async function runConformance(opts: ConformanceOptions): Promise<{ failures: number }> {
  const { name } = opts;
  const log = opts.log ?? ((l: string) => console.log(l));
  const mod = (await import(opts.driverModule)) as DriverModule;
  let failures = 0;
  const check = (ok: boolean, what: string) => {
    log(`${ok ? "ok  " : "FAIL"} [${name}] ${what}`);
    if (!ok) failures++;
  };
  const want = (k: Check) => !opts.checks || opts.checks.includes(k);

  // K1 — byte order: keys come back in memcmp order, both directions.
  async function k1(st: Persistence) {
    const vals = (): KeyValue => {
      const r = Math.random();
      if (r < 0.05) return null;
      if (r < 0.1) return Math.random() < 0.5;
      if (r < 0.5) return [0, -1, 1, 1e-300, -(2 ** 53), 2 ** 53, 3.5, -7.25][rnd(8)] * (Math.random() < 0.5 ? 1 : 1e6);
      let s = "";
      for (let i = 0; i < rnd(5); i++) s += String.fromCharCode([0, 1, 97, 98, 0x7f, 0xe9, 0x4e2d][rnd(7)]);
      return s;
    };
    const entries = Array.from({ length: 1500 }, (_, i) => ({
      key: encodeKey([vals(), vals(), `id${i}`]),
      id: `id${i}`,
    }));
    st.apply(
      1,
      entries.map((x) => ({ table: 900, id: x.id, json: "{}" })),
      entries.map((x) => ({ index: 900, key: x.key, id: x.id })),
    );
    await st.flush();
    const want = [...entries].sort((a, b) => compareKeys(a.key, b.key)).map((x) => x.id);
    const asc = await st.scan(900, FULL_LO, FULL_HI, 1, 100000, false);
    const desc = await st.scan(900, FULL_LO, FULL_HI, 1, 100000, true);
    check(
      JSON.stringify(asc) === JSON.stringify(want) && JSON.stringify(desc) === JSON.stringify([...want].reverse()),
      `K1 byte order over ${entries.length} mixed-type keys (asc and desc)`,
    );
  }

  // K2 — snapshots: random puts/deletes over 60 ids across 150 commits vs a reference model.
  async function k2(st: Persistence) {
    const T0 = 10; // after K1's commit
    const model = new Map<string, { ts: number; v: string | null }[]>();
    const keyOf = (id: string) => encodeKey([id]);
    for (let c = 1; c <= 150; c++) {
      const ts = T0 + c;
      const touched = new Set<string>();
      const docs = [];
      const idx = [];
      for (let j = 0; j < 1 + rnd(4); j++) {
        const id = `d${rnd(60)}`;
        if (touched.has(id)) continue;
        touched.add(id);
        const del = Math.random() < 0.25;
        const v = del ? null : JSON.stringify({ c, id });
        docs.push({ table: 901, id, json: v });
        idx.push({ index: 901, key: keyOf(id), id: del ? null : id });
        model.set(id, [...(model.get(id) ?? []), { ts, v }]);
      }
      st.apply(ts, docs, idx);
      if (c % 7 === 0) await st.flush(); // groups of several commits
    }
    await st.flush();
    let bad = 0;
    for (let probe = 0; probe < 60; probe++) {
      const T = T0 + rnd(151);
      const at = (id: string) => {
        const vs = model.get(id)?.filter((x) => x.ts <= T) ?? [];
        return vs.length ? vs[vs.length - 1].v : null;
      };
      for (let i = 0; i < 60; i++) if ((await st.get(901, `d${i}`, T)) !== at(`d${i}`)) bad++;
      const want = [...model.keys()].filter((id) => at(id) !== null).sort((a, b) => compareKeys(keyOf(a), keyOf(b)));
      const got = await st.scan(901, FULL_LO, FULL_HI, T, 1000, false);
      if (JSON.stringify(got) !== JSON.stringify(want)) bad++;
    }
    check(bad === 0, `K2 snapshot reads equal the reference model at 60 random past snapshots (${bad} mismatches)`);
  }

  // K8 — exact limits: a range whose front is full of removed entries and old versions must still yield
  // exactly `limit` live entries (a driver may not over-fetch a fixed multiple and stop there).
  async function k8(st: Persistence) {
    const T0 = 200; // after K2's commits
    const N = 40;
    const id = (i: number) => `e${String(i).padStart(2, "0")}`;
    const keyOf = (i: number) => encodeKey([id(i)]);
    const model = new Map<number, { ts: number; v: string | null }[]>();
    let ts = T0;
    const commit = async (writes: [number, boolean][]) => {
      ts++;
      const docs = [];
      const idx = [];
      for (const [i, del] of writes) {
        const v = del ? null : JSON.stringify({ ts, i });
        docs.push({ table: 903, id: id(i), json: v });
        idx.push({ index: 903, key: keyOf(i), id: del ? null : id(i) });
        model.set(i, [...(model.get(i) ?? []), { ts, v }]);
      }
      st.apply(ts, docs, idx);
      await st.flush();
    };
    await commit(Array.from({ length: N }, (_, i) => [i, false]));
    // The first and last 15 keys are deleted (both ends of the range are dead), then the live middle
    // keys get dozens of versions each, interleaved with random churn.
    await commit(Array.from({ length: 15 }, (_, i) => [i, true]));
    await commit(Array.from({ length: 15 }, (_, i) => [N - 1 - i, true]));
    for (let c = 0; c < 300; c++) {
      const w: [number, boolean][] = [[15 + rnd(10), false]];
      if (Math.random() < 0.2) {
        const j = rnd(N);
        if (j !== w[0][0]) w.push([j, Math.random() < 0.7]);
      }
      await commit(w);
    }
    const at = (i: number, T: number) => {
      const vs = model.get(i)?.filter((x) => x.ts <= T) ?? [];
      return vs.length ? vs[vs.length - 1].v : null;
    };
    const scanDocs = (st as Persistence & Partial<ScanDocs>).scanDocs?.bind(st);
    let bad = 0;
    let probes = 0;
    for (const T of [T0 + 1, T0 + 3, T0 + 50, T0 + 150, ts, ...Array.from({ length: 10 }, () => T0 + 3 + rnd(300))])
      for (const limit of [0, 1, 2, 3, 5, 12, 100])
        for (const desc of [false, true]) {
          const a = rnd(N);
          const b = a + rnd(N - a + 1);
          const ranges: [number, number][] = [
            [0, N],
            [a, b],
          ];
          for (const [lo, hi] of ranges) {
            probes++;
            const live = Array.from({ length: hi - lo }, (_, k) => lo + k).filter((i) => at(i, T) !== null);
            const ordered = desc ? live.reverse() : live;
            const want = ordered.slice(0, limit);
            const loKey = lo === 0 ? FULL_LO : keyOf(lo);
            const hiKey = hi === N ? FULL_HI : keyOf(hi);
            const got = await st.scan(903, loKey, hiKey, T, limit, desc);
            if (JSON.stringify(got) !== JSON.stringify(want.map(id))) bad++;
            if (scanDocs) {
              const docs = await scanDocs(903, 903, loKey, hiKey, T, limit, desc);
              if (JSON.stringify(docs) !== JSON.stringify(want.map((i) => at(i, T)))) bad++;
            }
          }
        }
    check(bad === 0, `K8 exact limits over dead ranges and many versions: ${probes} probes, ${bad} mismatches`);
  }

  // K9 — long keys: keys far longer than a store's indexed-column limit (Postgres ~2.7 KB, MySQL 3072 B),
  // many sharing their first 2500+ bytes, keep PERSIST-01's byte order, ranges and limits.
  async function k9(st: Persistence) {
    const T0 = 700; // after K8's commits
    // Incompressible filler: Postgres compresses index entries, so repeated characters would hide its limit.
    const noise = (seed: number) => {
      let x = seed;
      return Array.from({ length: 7000 }, () => {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        return String.fromCharCode(33 + (x % 94));
      }).join("");
    };
    const fills: Record<string, string> = { x: noise(1), y: noise(2), z: noise(3) };
    const long = (fill: string, n: number, tail: string) => fills[fill].slice(0, n) + tail;
    const strings = [
      "a",
      "b",
      long("x", 2490, ""),
      long("x", 2496, ""),
      long("x", 2497, ""), // with the tag and terminator: exactly around the 2500-byte prefix
      ...["", "a", "b", "ba", "z", "\u0001", "zzzz"].map((t) => long("y", 3000, t)),
      ...["1", "2", "10"].map((t) => long("y", 2600, t)),
      long("y", 6000, "q"),
      long("z", 2600, ""),
    ];
    const entries = strings.map((v, i) => ({ key: encodeKey([v, `L${i}`]), id: `L${i}` }));
    const ordered = [...entries].sort((a, b) => compareKeys(a.key, b.key));
    const model = new Map<string, { ts: number; live: boolean }[]>();
    let ts = T0;
    const commit = async (ws: [number, boolean][]) => {
      ts++;
      st.apply(
        ts,
        ws.map(([i, del]) => ({ table: 904, id: entries[i].id, json: del ? null : JSON.stringify({ i, ts }) })),
        ws.map(([i, del]) => ({ index: 904, key: entries[i].key, id: del ? null : entries[i].id })),
      );
      for (const [i, del] of ws) model.set(entries[i].id, [...(model.get(entries[i].id) ?? []), { ts, live: !del }]);
      await st.flush();
    };
    await commit(entries.map((_, i) => [i, false]));
    for (let c = 0; c < 40; c++) await commit([[rnd(entries.length), Math.random() < 0.3]]);
    const liveAt = (id: string, T: number) => {
      const vs = model.get(id)?.filter((x) => x.ts <= T) ?? [];
      return vs.length > 0 && vs[vs.length - 1].live;
    };
    const scanDocs = (st as Persistence & Partial<ScanDocs>).scanDocs?.bind(st);
    let bad = 0;
    let probes = 0;
    for (const T of [T0 + 1, T0 + 10, ts])
      for (const limit of [1, 2, 3, 7, 100])
        for (const desc of [false, true])
          for (let r = 0; r < 4; r++) {
            const a = r === 0 ? 0 : rnd(ordered.length);
            const b = r === 0 ? ordered.length : a + rnd(ordered.length - a + 1);
            const lo = r === 0 ? FULL_LO : ordered[a].key;
            const hi = b === ordered.length ? FULL_HI : ordered[b].key;
            const live = ordered.slice(a, b).filter((e) => liveAt(e.id, T));
            const want = (desc ? live.reverse() : live).slice(0, limit).map((e) => e.id);
            probes++;
            const got = await st.scan(904, lo, hi, T, limit, desc);
            if (JSON.stringify(got) !== JSON.stringify(want)) {
              bad++;
              if (bad <= 3) log(`  K9 mismatch T=${T} limit=${limit} desc=${desc} [${a},${b}): ${got} vs ${want}`);
            }
            if (scanDocs) {
              const docs = await scanDocs(904, 904, lo, hi, T, limit, desc);
              if (docs.length !== want.length) bad++;
            }
          }
    check(bad === 0, `K9 long keys (up to 6 KB, shared 2500-byte prefixes): ${probes} probes, ${bad} mismatches`);
  }

  // K3–K5 — through the engine.
  async function k3to5(st: Persistence) {
    // K3 hunts lost updates, so it wants many commits under contention, not Convex's patient backoff
    // (100 ms – 2 s): a large budget with millisecond sleeps.
    const e = await newEngine(st, { maxRetries: 1000, occInitialBackoffMs: 1, occMaxBackoffMs: 20 });
    await e.mutation(seedCounters(4));
    let before = 0;
    for (const keys of [1, 4]) {
      let ok = 0;
      // Giving up after the retry budget is ALLOWED (a slow store under 64-way contention on one key
      // exhausts it); losing a committed increment is not. The property: counters grow by exactly the
      // number of increments that committed.
      let gaveUp = 0;
      await Promise.all(
        Array.from({ length: 64 }, async (_, w) => {
          for (let i = 0; i < 50; i++) {
            try {
              await e.mutation(increment(`k${(w + i) % keys}`));
              ok++;
            } catch (err) {
              if (!(err instanceof OccError)) throw err;
              gaveUp++;
            }
          }
        }),
      );
      let total = 0;
      for (let k = 0; k < 4; k++) total += (await e.query(counter(`k${k}`))) ?? 0;
      check(
        ok > 0 && total - before === ok,
        `K3 ${keys} key(s): ${ok} increments committed, counters grew ${total - before} (${gaveUp} gave up after retries)`,
      );
      before = total;
    }
    const first = await e.query(listTenant("t0"), "listCached");
    await e.query(listTenant("t0"), "listCached");
    const hits = e.stats.cacheHits;
    await e.mutation(insertItem("t999"));
    await e.query(listTenant("t0"), "listCached");
    check(e.stats.cacheHits === hits + 1, "K4 an insert outside the cached range keeps the entry");
    const id = await e.mutation(insertItem("t0"));
    const after = await e.query(listTenant("t0"), "listCached");
    check(after.some((d) => d._id === id) && first.every((d) => d._id !== id), "K4 an insert inside the range is seen");
    let odd = 0;
    let stop = false;
    const readers = Array.from({ length: 8 }, async () => {
      while (!stop) {
        const rows = await e.query(allOfTenant("tx"), `all\u0000${Math.random()}`);
        if (rows.length % 2 !== 0) odd++;
        await new Promise((r) => setImmediate(r));
      }
    });
    await Promise.all(
      Array.from({ length: 16 }, async (_, w) => {
        for (let i = 0; i < 60; i++) await e.mutation(pair("tx", `${w}-${i}`));
      }),
    );
    stop = true;
    await Promise.all(readers);
    const final = await e.query(allOfTenant("tx"));
    check(
      odd === 0 && final.length === 1920,
      `K5 no reader saw half a mutation (${odd} odd reads, ${final.length}/1920)`,
    );
    await e.close();
  }

  // K6 — crash atomicity: SIGKILL a committing child at random moments; reopen and audit.
  async function k6() {
    const kills = opts.kills ?? 8;
    const childPath = new URL("./child.ts", import.meta.url).pathname;
    let bad = 0;
    for (let k = 0; k < kills; k++) {
      const child = spawn(process.execPath, [childPath, opts.driverModule], {
        env: { ...process.env, LEASE_TTL_MS: String(CHILD_TTL_MS) },
        stdio: ["ignore", "pipe", "inherit"],
      });
      let lastAck = 0;
      let started = false;
      let buf = "";
      child.stdout.on("data", (d) => {
        buf += d;
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (const l of lines) {
          if (l.startsWith("start")) started = true;
          if (l.startsWith("ack ")) lastAck = Math.max(lastAck, Number(l.slice(4)));
        }
      });
      while (!started) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 150 + rnd(600)));
      child.kill("SIGKILL");
      await new Promise((r) => child.on("exit", r));

      const st = await mod.open(false);
      // Under a lease the engine first waits out the killed child's (K15), and maxTs is read after that.
      // Opening an engine on an existing store only reads the catalog (no commit), so M is maxTs.
      const e = await newEngine(st, { lease: { waitMs: 20 * CHILD_TTL_MS } });
      const M = Number((await st.maxTs?.()) ?? 0);
      const items = e.catalog.table("items");
      const ixIds = [...items.indexes.values()].map((ix) => ix.id);
      if (M < lastAck) {
        log(`  kill ${k}: maxTs ${M} < last acknowledged ${lastAck}`);
        bad++;
      }
      // Completeness at M: every index of `items` holds one live entry per live document, and every
      // indexed id resolves to a document.
      const counts: number[] = [];
      for (const ix of ixIds) {
        const ids = await st.scan(ix, FULL_LO, FULL_HI, M, 10_000_000, false);
        counts.push(ids.length);
        for (const id of ids.slice(-200)) if ((await st.get(items.id, id, M)) === null) bad++;
      }
      const live = st.auditLiveDocs ? Number(await st.auditLiveDocs(items.id, M)) : counts[0];
      if (new Set([...counts, live]).size !== 1) {
        log(`  kill ${k}: live docs ${live}, index entries ${JSON.stringify(counts)} (torn commit)`);
        bad++;
      }
      // Writing resumes at M + 1 and the result is readable.
      const id = await e.mutation(insertItem("resume"));
      if (e.committer.visibleTs !== M + 1 || (await st.get(items.id, id, M + 1)) === null) {
        log(`  kill ${k}: resume wrote ts ${e.committer.visibleTs}, expected ${M + 1}`);
        bad++;
      }
      await e.close();
    }
    check(
      bad === 0,
      `K6 ${kills} SIGKILLs mid-commit: no acknowledged commit lost, no torn commit, resume at maxTs+1 (${bad} violations)`,
    );
  }

  // K7 — a torn TAIL (what a power loss leaves in an append-only log; SIGKILL cannot produce it, because
  // a group is one write()): half a record must be cut off on open, and writing must resume.
  async function k7() {
    if (!mod.tearTail) return; // only log-based drivers
    const st = await mod.open(true);
    const e = await newEngine(st);
    for (let i = 0; i < 50; i++) await e.mutation(insertItem("k7"));
    const M = Number(await st.maxTs!());
    await e.close();
    await mod.tearTail(M + 1);
    const st2 = await mod.open(false);
    const e2 = await newEngine(st2);
    const M2 = Number(await st2.maxTs!());
    await e2.mutation(insertItem("k7"));
    await e2.close();
    const st3 = await mod.open(false); // the record written after recovery must survive a reopen
    const e3 = await newEngine(st3);
    const M3 = Number(await st3.maxTs!());
    const torn = await st3.get(e3.catalog.table("items").id, "torn", M3);
    await e3.close();
    check(
      M2 === M && M3 === M + 1 && torn === null,
      `K7 a torn log tail is cut off and writing resumes (maxTs ${M} → ${M2} → ${M3})`,
    );
  }

  // K10–K18 — single writer (PERSIST-01 C7): the lease, its fence, and the durable prefix.
  async function leaseChecks() {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const raw = async (fresh: boolean) => {
      const s = await mod.open(fresh);
      if (!hasLease(s)) throw new Error("driver lost its lease between opens");
      return s;
    };
    const TABLE = 950;
    const INDEX = 951;
    const row = (ts: number, id: string) =>
      [[{ table: TABLE, id, json: `{"ts":${ts}}` }], [{ index: INDEX, key: encodeKey([id]), id }]] as const;

    // K10 — exclusive, at the driver and through the engine.
    {
      const a = await raw(true);
      const b = await raw(false);
      const ra = await a.acquireLease({ holder: "k10-a", ttlMs: 30_000 });
      const rb = await b.acquireLease({ holder: "k10-b", ttlMs: 30_000 });
      await a.releaseLease();
      await a.close();
      await b.close();
      const e1 = await newEngine(await mod.open(false));
      const second = await newEngine(await mod.open(false)).catch((e) => e);
      await e1.close();
      check(
        "epoch" in ra &&
          "heldBy" in rb &&
          rb.heldBy === "k10-a" &&
          rb.expiresInMs > 0 &&
          second instanceof LeaseHeldError,
        "K10 a live lease is exclusive (driver: heldBy; engine: LeaseHeldError)",
      );
    }

    // K11 — a holder that stops renewing is replaced within TTL + ε, with a greater epoch.
    {
      const a = await raw(false);
      const b = await raw(false);
      const ttl = 400;
      const ra = await a.acquireLease({ holder: "k11-a", ttlMs: ttl });
      const t0 = Date.now();
      let rb = await b.acquireLease({ holder: "k11-b", ttlMs: 30_000 });
      while (!("epoch" in rb) && Date.now() - t0 < ttl + 3000) {
        await sleep(25);
        rb = await b.acquireLease({ holder: "k11-b", ttlMs: 30_000 });
      }
      const took = Date.now() - t0;
      await b.releaseLease();
      await a.close();
      await b.close();
      check(
        "epoch" in ra && "epoch" in rb && rb.epoch > ra.epoch && took <= ttl + 1000,
        `K11 an expired lease is taken over within TTL + ε (${took} ms for a ${ttl} ms TTL), with a greater epoch`,
      );
    }

    // K12 — after a takeover, the old holder's flush is refused and leaves nothing visible.
    {
      const a = await raw(false);
      const b = await raw(false);
      await a.acquireLease({ holder: "k12-a", ttlMs: 200 });
      const M0 = Number(await a.maxTs!());
      const [d1, i1] = row(M0 + 1, "k12-a1");
      a.apply(M0 + 1, [...d1], [...i1]);
      await a.flush(); // A is the holder: accepted
      await sleep(350);
      const rb = await b.acquireLease({ holder: "k12-b", ttlMs: 30_000 });
      const M = Number(await b.maxTs!());
      const [d2, i2] = row(M + 1, "k12-a2");
      a.apply(M + 1, [...d2], [...i2]);
      const err = await Promise.resolve(a.flush()).then(
        () => null,
        (e) => e,
      );
      const seen = await b.scan(INDEX, FULL_LO, FULL_HI, Number.MAX_SAFE_INTEGER, 100, false);
      const M2 = Number(await b.maxTs!());
      await b.releaseLease();
      await a.close();
      await b.close();
      check(
        "epoch" in rb &&
          M === M0 + 1 &&
          err instanceof LeaseLostError &&
          JSON.stringify(seen) === JSON.stringify(["k12-a1"]) &&
          M2 === M,
        `K12 a stale holder's flush throws LeaseLostError and lands nothing (${err?.constructor?.name ?? "no error"}; visible ${JSON.stringify(seen)})`,
      );
    }

    // K16 — maxTs counts a commit that wrote only index entries.
    {
      const s = await raw(false);
      await s.acquireLease({ holder: "k16", ttlMs: 30_000 });
      const M = Number(await s.maxTs!());
      s.apply(M + 1, [], [{ index: INDEX, key: encodeKey(["k16"]), id: "k16" }]);
      await s.flush();
      await s.releaseLease();
      await s.close();
      const s2 = await raw(false);
      const M2 = Number(await s2.maxTs!());
      await s2.close();
      check(M2 === M + 1, `K16 maxTs counts an index-only commit (${M} → ${M2}, expected ${M + 1})`);
    }

    // K18 — a released lease is taken at once, at the driver and through Engine.close().
    {
      const a = await raw(false);
      const b = await raw(false);
      const ra = await a.acquireLease({ holder: "k18-a", ttlMs: 60_000 });
      await a.releaseLease();
      const rb = await b.acquireLease({ holder: "k18-b", ttlMs: 60_000 });
      await b.releaseLease();
      await a.close();
      await b.close();
      const e1 = await newEngine(await mod.open(false), { lease: { ttlMs: 60_000 } });
      await e1.close();
      const e2 = await newEngine(await mod.open(false)).catch((e) => e);
      if (!(e2 instanceof Error)) await (e2 as Engine).close();
      check(
        "epoch" in ra && "epoch" in rb && rb.epoch > ra.epoch && !(e2 instanceof Error),
        "K18 a released lease (releaseLease, Engine.close) is taken at once",
      );
    }

    // K17 — two engines opened at once on an empty store: exactly one wins; one catalog, one secret.
    {
      await mod.open(true).then((s) => s.close());
      const opened = await Promise.allSettled([newEngine(await mod.open(false)), newEngine(await mod.open(false))]);
      const won = opened.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<Engine>[];
      const lost = opened.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      let catalogOk = false;
      if (won.length === 1) {
        const e = won[0].value;
        const at = e.committer.visibleTs;
        const tablesId = e.catalog.table("_tables").id;
        const instanceId = e.catalog.table("_instance").id;
        const tables = Number(await e.persistence.auditLiveDocs?.(tablesId, at));
        const secrets = Number(await e.persistence.auditLiveDocs?.(instanceId, at));
        // one `_tables` document per table (the two bootstrap tables, `_tables` and `_index`, have none);
        // one secret. A second catalog would double the `_tables` documents.
        catalogOk = secrets === 1 && tables === e.catalog.tables.size - 2;
        await e.close();
      }
      for (const r of lost) if (!(r.reason instanceof LeaseHeldError)) log(`  K17: loser failed with ${r.reason}`);
      check(
        won.length === 1 && lost.length === 1 && lost[0].reason instanceof LeaseHeldError && catalogOk,
        `K17 concurrent first boot: one engine opens, the other gets LeaseHeldError; one catalog, one secret (${won.length} won)`,
      );
    }

    // K13 (+ K14) — a paused writer resumes after a takeover: it must stop with a lost lease and land nothing.
    {
      const childPath = new URL("./lease-child.ts", import.meta.url).pathname;
      let bad = 0;
      let worst = 0;
      let insideFlush = 0;
      for (let round = 0; round < 3; round++) {
        await mod.open(true).then((s) => s.close());
        const child = spawn(process.execPath, [childPath, opts.driverModule], {
          env: { ...process.env, LEASE_TTL_MS: String(CHILD_TTL_MS) },
          stdio: ["ignore", "pipe", "inherit"],
        });
        let started = false;
        let stoppedBy = "";
        let buf = "";
        child.stdout.on("data", (d) => {
          buf += d;
          const lines = buf.split("\n");
          buf = lines.pop()!;
          for (const l of lines) {
            if (l.startsWith("start")) started = true;
            if (l === "lost" || l.startsWith("fatal ")) stoppedBy = l;
          }
        });
        const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
        while (!started) await sleep(20);
        await sleep(200 + rnd(500));
        // Round 0 pauses the writer INSIDE a flush (K14) when the driver can tell; the others anywhere.
        let inside = false;
        child.kill("SIGSTOP");
        if (round === 0 && mod.writerInsideFlush)
          for (let tries = 0; tries < 500; tries++) {
            inside = await mod.writerInsideFlush();
            if (inside) break;
            child.kill("SIGCONT");
            await sleep(rnd(4));
            child.kill("SIGSTOP");
          }
        if (inside) insideFlush++;
        const t0 = Date.now();
        const st = await mod.open(false);
        const e = await newEngine(st, { lease: { waitMs: 30_000, ttlMs: 30_000 } }).catch((err: Error) => err);
        const took = Date.now() - t0;
        if (e instanceof Error) {
          bad++;
          log(`  K13 round ${round}: the takeover failed after ${took} ms: ${e.message}`);
          child.kill("SIGKILL");
          await exited;
          await st.close();
          continue;
        }
        worst = Math.max(worst, took);
        const M = e.committer.visibleTs;
        const items = e.catalog.table("items");
        const childBefore = (await e.query(allOfTenant("child"))).length;
        for (let i = 0; i < 20; i++) await e.mutation(insertItem("parent"));
        child.kill("SIGCONT");
        const code = await Promise.race([exited, sleep(15_000).then(() => "timeout" as const)]);
        if (code === "timeout") child.kill("SIGKILL");
        const childAfter = (await e.query(allOfTenant("child"))).length;
        const parent = (await e.query(allOfTenant("parent"))).length;
        const at = e.committer.visibleTs;
        const counts: number[] = [];
        for (const ix of items.indexes.values())
          counts.push((await st.scan(ix.id, FULL_LO, FULL_HI, at, 1e7, false)).length);
        const live = st.auditLiveDocs ? Number(await st.auditLiveDocs(items.id, at)) : counts[0];
        // The child must stop (fail-stop) and land nothing. Paused between flushes it finds its lease lost
        // (exit 3); paused INSIDE a flush the store aborts its idle transaction (K14) and that flush fails
        // (exit 4). Either way no write of it may appear after the takeover.
        const ok =
          (code === 3 || code === 4) &&
          stoppedBy !== "" &&
          childAfter === childBefore &&
          parent === 20 &&
          at === M + 20 &&
          new Set([...counts, live]).size === 1 &&
          took <= CHILD_TTL_MS + IDLE_TX_BOUND_MS + 2000;
        if (!ok) {
          bad++;
          log(
            `  K13 round ${round}: exit ${code}, stopped by "${stoppedBy}", child rows ${childBefore} → ${childAfter}, parent ${parent}, ts ${M} → ${at}, counts ${JSON.stringify([...counts, live])}, takeover ${took} ms`,
          );
        }
        await e.close();
      }
      check(
        bad === 0,
        `K13 a paused stale writer stops with LeaseLostError and lands nothing; takeover ≤ ${CHILD_TTL_MS + IDLE_TX_BOUND_MS + 2000} ms (worst ${worst} ms)`,
      );
      if (mod.writerInsideFlush)
        check(insideFlush === 1, "K14 a writer paused inside its flush is taken over within the bound (K13 round 0)");
    }
  }

  // K1, K2, K8 and K9 drive the store directly: under C7 they hold its lease like a writer would.
  const st = await mod.open(true);
  const leased = hasLease(st);
  if (leased) await st.acquireLease({ holder: "conformance", ttlMs: 60_000 });
  if (want("K1")) await k1(st);
  if (want("K2")) await k2(st);
  if (want("K8")) await k8(st);
  if (want("K9")) await k9(st);
  if (leased) await st.releaseLease();
  await st.close();
  if (want("K3")) await k3to5(await mod.open(true));
  await mod.open(true).then((s) => s.close());
  if (want("K6")) await k6();
  if (want("K7")) await k7();
  if (want("K10")) {
    if (leased) await leaseChecks();
    else if (opts.requireLease) check(false, "K10–K18 the driver claims PERSIST-01 C7 but has no lease");
  }
  return { failures };
}

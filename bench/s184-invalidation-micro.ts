// STUDY-184 §5.6 (measurement 3), the parts measured in one process:
//   - match: one commit against N registered read-sets (the sync hub's ReadSetIndex), when the commit
//     invalidates about one of them, 1 % or 10 %; and the replacement of one read-set after its rerun;
//   - rerun: one subscription's query run again by the engine (`queryTracked` on the memory store), without the
//     sync session around it;
//   - apply: what a STUDY-24 follower does with one pushed commit before matching it: decode the frame
//     (`{ts, prevTs, writes}`, binary, as STUDY-24 §4.3 proposes) and append the entry to its write log.
// Subscription i reads one group's prefix on `by_g` (group i mod G), about what the end-to-end bench's `subs:watch`
// (the newest document of a group) records; a commit inserts one document into a group: one write on by_id and
// one on by_g.
//   bun bench/s184-invalidation-micro.ts     Env: NS (1000,10000,100000,1000000), COMMITS (2000), RUNS (20000)
import {
  defineSchema,
  defineTable,
  Engine,
  encodeKey,
  type Interval,
  type LogEntry,
  prefixEnd,
  ReadSetIndex,
} from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { tid } from "./ids.ts";

const NS = (process.env.NS ?? "1000,10000,100000,1000000").split(",").map(Number);
const COMMITS = Number(process.env.COMMITS ?? 2000);
const RUNS = Number(process.env.RUNS ?? 20_000);
const BY_ID = tid(1);
const BY_G = tid(2);

/** Fan-outs: how many groups the N subscriptions are spread over. */
const FANOUTS: { name: string; groups: (n: number) => number }[] = [
  { name: "one", groups: (n) => n },
  { name: "1%", groups: () => 100 },
  { name: "10%", groups: () => 10 },
];

const gKey = (g: number) => encodeKey([g]);
const readsOf = (g: number): Interval[] => [{ index: BY_G, lo: gKey(g), hi: prefixEnd(gKey(g)) }];
const commitOn = (g: number, ts: bigint): LogEntry => {
  const id = `doc${ts}`;
  return {
    ts,
    writes: [
      { index: BY_ID, key: encodeKey([id]), id },
      { index: BY_G, key: encodeKey([g, Number(ts), id]), id },
    ],
  };
};

const us = (ms: number, n: number) => Number(((ms * 1000) / n).toFixed(3));

// --- match ------------------------------------------------------------------------------------------------
const matchRows = [];
for (const n of NS)
  for (const f of FANOUTS) {
    const groups = f.groups(n);
    const index = new ReadSetIndex<number>();
    let t = performance.now();
    for (let i = 0; i < n; i++) index.set(i, readsOf(i % groups));
    const buildMs = performance.now() - t;
    const commits = Array.from({ length: COMMITS }, (_, c) => [
      commitOn(Math.floor(Math.random() * groups), BigInt(c + 1)),
    ]);
    // warm up, then measure
    for (let c = 0; c < Math.min(200, COMMITS); c++) index.matchingEntries(commits[c]!);
    // Wide fan-outs cost about the size of the answer: fewer commits keep the run short.
    const m = Math.max(20, Math.min(COMMITS, Math.floor(2e6 / Math.max(1, n / groups))));
    let hits = 0;
    t = performance.now();
    for (let c = 0; c < m; c++) hits += index.matchingEntries(commits[c]!).size;
    const matchMs = performance.now() - t;
    // A rerun registers its new read-set in place of the old one (the sync hub's `adopt`).
    const R = 20_000;
    t = performance.now();
    for (let r = 0; r < R; r++) {
      const o = Math.floor(Math.random() * n);
      index.set(o, readsOf(o % groups));
    }
    const replaceUs = us(performance.now() - t, R);
    const row = {
      part: "match",
      N: n,
      fanout: f.name,
      matchedPerCommit: Math.round(hits / m),
      usPerCommit: us(matchMs, m),
      nsPerMatched: Number(((matchMs * 1e6) / Math.max(1, hits)).toFixed(1)),
      replaceUsPerRerun: replaceUs,
      buildMs: Math.round(buildMs),
      heapMB: Math.round(process.memoryUsage().heapUsed / 2 ** 20),
    };
    matchRows.push(row);
    console.log(JSON.stringify(row));
  }

// --- apply (a STUDY-24 follower) -----------------------------------------------------------------------------
const enc = new TextEncoder();
const dec = new TextDecoder();
/** `{ts, prevTs, writes: [(index, key, id | null)]}` as length-prefixed fields. */
function encodeFrame(e: LogEntry, prevTs: bigint): Uint8Array {
  const parts: Uint8Array[] = [];
  let size = 8 + 8 + 4;
  for (const w of e.writes) {
    const ix = enc.encode(w.index);
    const id = w.id === null ? null : enc.encode(w.id);
    parts.push(ix, w.key, id ?? new Uint8Array());
    size += 2 + ix.length + 4 + w.key.length + 2 + (id?.length ?? 0);
  }
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setBigUint64(0, e.ts);
  dv.setBigUint64(8, prevTs);
  dv.setUint32(16, e.writes.length);
  let o = 20;
  e.writes.forEach((w, i) => {
    const [ix, key, id] = [parts[3 * i]!, parts[3 * i + 1]!, parts[3 * i + 2]!];
    dv.setUint16(o, ix.length);
    out.set(ix, o + 2);
    o += 2 + ix.length;
    dv.setUint32(o, key.length);
    out.set(key, o + 4);
    o += 4 + key.length;
    dv.setUint16(o, w.id === null ? 0xffff : id.length);
    out.set(id, o + 2);
    o += 2 + id.length;
  });
  return out;
}
function decodeFrame(b: Uint8Array): { entry: LogEntry; prevTs: bigint } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ts = dv.getBigUint64(0);
  const prevTs = dv.getBigUint64(8);
  const count = dv.getUint32(16);
  const writes: LogEntry["writes"] = [];
  let o = 20;
  for (let i = 0; i < count; i++) {
    const il = dv.getUint16(o);
    const index = dec.decode(b.subarray(o + 2, o + 2 + il));
    o += 2 + il;
    const kl = dv.getUint32(o);
    const key = b.slice(o + 4, o + 4 + kl);
    o += 4 + kl;
    const dl = dv.getUint16(o);
    const id = dl === 0xffff ? null : dec.decode(b.subarray(o + 2, o + 2 + dl));
    o += 2 + (dl === 0xffff ? 0 : dl);
    writes.push({ index, key, id });
  }
  return { entry: { ts, writes }, prevTs };
}
{
  const frames = Array.from({ length: COMMITS }, (_, c) => encodeFrame(commitOn(c, BigInt(c + 1)), BigInt(c)));
  const log: LogEntry[] = [];
  let last = 0n;
  for (let r = 0; r < 3; r++) {
    log.length = 0;
    last = 0n;
    const t = performance.now();
    for (const f of frames) {
      const { entry, prevTs } = decodeFrame(f);
      if (prevTs !== last) throw new Error("gap");
      log.push(entry);
      last = entry.ts;
    }
    if (r === 2)
      console.log(
        JSON.stringify({
          part: "apply",
          usPerCommit: us(performance.now() - t, frames.length),
          frameBytes: frames[0]!.length,
        }),
      );
  }
}

// --- rerun ------------------------------------------------------------------------------------------------
{
  const engine = await new Engine(
    defineSchema({ docs: defineTable(v.any()).index("by_g", ["g", "t"]) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const G = 1000;
  await engine.mutation(async (db) => {
    for (let g = 0; g < G; g++) await db.insert("docs", { g, t: g });
  });
  const watch = (g: number) => (db: any) =>
    db
      .query("docs")
      .withIndex("by_g", (q: any) => q.eq("g", g))
      .order("desc")
      .first();
  for (let i = 0; i < 2000; i++) await engine.queryTracked(watch(i % G));
  const t = performance.now();
  for (let i = 0; i < RUNS; i++) await engine.queryTracked(watch(i % G));
  console.log(JSON.stringify({ part: "rerun", usPerRun: us(performance.now() - t, RUNS) }));
}
process.exit(0);

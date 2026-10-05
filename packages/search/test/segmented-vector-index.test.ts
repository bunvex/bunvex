// The segmented vector index (STUDY-111 PR 2) against today's single in-memory index (every document in one map,
// every vector compared, all hits sorted): random writes, flushes, compactions and restarts, and at every step the
// same results, scores bit for bit and in the same order.
import { expect, test } from "bun:test";
import { encodeId } from "@bunvex/values";
import {
  compareVectorHits,
  type PreparedVectorCompaction,
  type PreparedVectorFlush,
  SegmentedVectorIndex,
  type VectorDoc,
  type VectorFilter,
  type VectorHit,
  type VectorSegmentPart,
} from "../src/index.ts";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Today's search (core's `VectorIndexes.search` before segments): one map, every vector, every hit sorted. */
function oracleSearch(docs: Map<string, VectorDoc>, q: Float32Array, limit: number, filter: VectorFilter | null) {
  const hits: VectorHit[] = [];
  for (const [id, d] of docs) {
    if (filter && ![...filter].some(([f, keys]) => keys.has(d.filters[f]!))) continue;
    let dot = 0;
    for (let i = 0; i < q.length; i++) dot = Math.fround(dot + Math.fround(q[i]! * d.vector[i]!));
    hits.push({ id, score: dot });
  }
  hits.sort(compareVectorHits);
  return hits.slice(0, limit);
}

const DIMS = 4;
const KEYS = ["00", "01", "02"];
type Stored = { segment: Uint8Array; deletes: Uint8Array | null };

async function run(seed: number, steps: number) {
  const r = rng(seed);
  const int = (n: number) => Math.floor(r() * n);
  const pick = <T>(xs: readonly T[]) => xs[int(xs.length)]!;
  const ids = Array.from({ length: 100 }, (_, i) => encodeId(10_001, new Uint8Array(16).fill(i + 1)));
  // Few distinct components: equal scores, which fall to the id.
  const component = () => pick([0, 0.5, 1, -1, 0.25]);
  const randomDoc = (): VectorDoc | null =>
    r() < 0.15
      ? null
      : {
          vector: Float32Array.from({ length: DIMS }, component),
          filters: r() < 0.9 ? { kind: pick(KEYS), other: pick(KEYS) } : { other: pick(KEYS) },
        };
  const randomFilter = (): VectorFilter | null => {
    if (r() < 0.5) return null;
    const f = new Map<string, Set<string>>();
    f.set("kind", new Set(Array.from({ length: 1 + int(2) }, () => pick([...KEYS, "09"]))));
    if (r() < 0.3) f.set("other", new Set([pick(KEYS)]));
    return f;
  };

  const oracle = new Map<string, VectorDoc>();
  let index = new SegmentedVectorIndex(DIMS, ["kind", "other"]);
  let storage = new Map<VectorSegmentPart, Stored>();
  let flush: PreparedVectorFlush | null = null;
  let compaction: PreparedVectorCompaction | null = null;
  const counts = { flushes: 0, compactions: 0, restarts: 0 };

  const write = () => {
    const id = pick(ids);
    const d = randomDoc();
    if (d) oracle.set(id, d);
    else oracle.delete(id);
    index.set(id, d);
  };
  const check = () => {
    expect(index.size).toBe(oracle.size);
    const id = pick(ids);
    const got = index.get(id);
    const want = oracle.get(id) ?? null;
    expect(got && { vector: [...got.vector], filters: got.filters }).toEqual(
      want && { vector: [...want.vector], filters: want.filters },
    );
    for (let k = 0; k < 3; k++) {
      const q = Float32Array.from({ length: DIMS }, component);
      const limit = pick([0, 1, 5, 10, 256]);
      const filter = randomFilter();
      expect(index.search(q, limit, filter)).toEqual(oracleSearch(oracle, q, limit, filter));
    }
  };

  for (let step = 0; step < steps; step++) {
    const x = r();
    if (x < 0.6) write();
    else if (x < 0.7) {
      if (!flush) flush = index.prepareFlush();
      else {
        const part = index.commitFlush(flush);
        for (const d of flush.deletes) storage.get(d.part)!.deletes = d.bytes;
        if (part) storage.set(part, { segment: flush.segment!, deletes: null });
        flush = null;
        counts.flushes++;
      }
    } else if (x < 0.78) {
      if (!compaction) {
        if (index.segments.length >= 2) {
          const parts = index.segments.filter(() => r() < 0.7);
          if (parts.length) compaction = await index.prepareCompaction(parts);
        }
      } else if (!flush) {
        const deletes = index.reconcileCompaction(compaction);
        if (r() < 0.5) write();
        const part = index.commitCompaction(compaction);
        for (const p of compaction.parts) storage.delete(p);
        if (part) storage.set(part, { segment: compaction.segment!, deletes });
        compaction = null;
        counts.compactions++;
      }
    } else if (x < 0.8) {
      const restarted = new SegmentedVectorIndex(DIMS, ["kind", "other"]);
      restarted.load(index.segments.map((p) => storage.get(p)!));
      const next = new Map<VectorSegmentPart, Stored>();
      restarted.segments.forEach((p, i) => {
        next.set(p, storage.get(index.segments[i]!)!);
      });
      for (const id of index.changed.keys()) restarted.set(id, oracle.get(id) ?? null);
      index = restarted;
      storage = next;
      flush = null;
      compaction = null;
      counts.restarts++;
    }
    check();
  }
  return counts;
}

test("random writes, flushes, compactions and restarts: the same results as one in-memory index", async () => {
  const total = { flushes: 0, compactions: 0, restarts: 0 };
  for (let seed = 1; seed <= 12; seed++) {
    const c = await run(seed, 500);
    for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += c[k];
  }
  expect(total.flushes).toBeGreaterThan(100);
  expect(total.compactions).toBeGreaterThan(50);
  expect(total.restarts).toBeGreaterThan(50);
});

test("equal scores order by internal id, descending, NaN scores first: wherever the documents are", () => {
  const id = (n: number) => encodeId(10_001, new Uint8Array(16).fill(n));
  const index = new SegmentedVectorIndex(2, []);
  const v = (x: number, y: number): VectorDoc => ({ vector: Float32Array.of(x, y), filters: {} });
  index.set(id(1), v(1, 0));
  index.set(id(2), v(Number.NaN, 0));
  index.commitFlush(index.prepareFlush());
  index.set(id(3), v(1, 0));
  index.set(id(4), v(Number.NaN, 0));
  index.set(id(5), v(0, 1));
  expect(index.search(Float32Array.of(1, 0), 10, null).map((h) => h.id)).toEqual([id(4), id(2), id(3), id(1), id(5)]);
  expect(index.search(Float32Array.of(1, 0), 3, null).map((h) => h.id)).toEqual([id(4), id(2), id(3)]);
});

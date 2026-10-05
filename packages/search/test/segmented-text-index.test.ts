// The segmented text index (STUDY-111 PR 2) against today's single in-memory index: random writes, flushes,
// compactions (interleaved with writes and flushes) and restarts from what was stored, and at every step the same
// answers — the same hits, scores bit for bit, order and ties — with and without an overlay.
import { expect, test } from "bun:test";
import { encodeId } from "@bunvex/values";
import {
  type IndexedDoc,
  type PreparedTextCompaction,
  type PreparedTextFlush,
  SegmentedTextIndex,
  TextIndex,
  type TextQuery,
  type TextSegmentPart,
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

// Shared prefixes (expansions), accents, and words some documents repeat.
const VOCAB = [
  "a",
  "ab",
  "abc",
  "abd",
  "b",
  "ba",
  "bab",
  "c",
  "ca",
  "cab",
  "café",
  "cafe",
  "zeta",
  "zebra",
  "zero",
  "東京",
  // A code point above U+FFFF (a surrogate pair) and one above U+E000: UTF-16 and UTF-8 order them differently.
  "𝒜b",
  "𝒜",
  "ｶ",
  "ｶz",
];
const KEYS = ["00", "01", "02"];

type Stored = { segment: Uint8Array; deletes: Uint8Array | null };

function run(seed: number, steps: number) {
  const r = rng(seed);
  const int = (n: number) => Math.floor(r() * n);
  const pick = <T>(xs: readonly T[]) => xs[int(xs.length)]!;
  const ids = Array.from({ length: 120 }, (_, i) => encodeId(10_001, new Uint8Array(16).fill(i + 1)));
  const randomDoc = (): IndexedDoc | null => {
    if (r() < 0.15) return null;
    const n = r() < 0.08 ? 25 + int(60) : int(10);
    return {
      tokens: Array.from({ length: n }, () => pick(VOCAB)),
      filters: r() < 0.9 ? { kind: pick(KEYS) } : {},
      // Few distinct times: ties fall to the id.
      creationTime: 1000 + int(5),
      bytes: int(100),
    };
  };
  const randomQuery = (): TextQuery => {
    const words = [...VOCAB, "abx", "q", "cafés"];
    const tokens = Array.from({ length: 1 + int(3) }, () => {
      const w = pick(words);
      return r() < 0.3 ? [...w].slice(0, 1 + int([...w].length)).join("") : w;
    });
    return { tokens, prefixLast: r() < 0.7, filters: r() < 0.4 ? [["kind", pick([...KEYS, "09"])]] : [] };
  };
  const randomOverlay = () => {
    const m = new Map<string, IndexedDoc | null>();
    if (r() < 0.5) for (let i = int(4); i > 0; i--) m.set(pick(ids), randomDoc());
    return m;
  };

  const oracle = new TextIndex();
  let index = new SegmentedTextIndex(["kind"]);
  let storage = new Map<TextSegmentPart, Stored>();
  let flush: PreparedTextFlush | null = null;
  let compaction: PreparedTextCompaction | null = null;
  const counts = { flushes: 0, compactions: 0, restarts: 0, queries: 0 };

  const write = () => {
    const id = pick(ids);
    const d = randomDoc();
    oracle.set(id, d);
    index.set(id, d);
  };
  const check = () => {
    expect(index.size).toBe(oracle.size);
    expect(index.indexedBytes).toBe(oracle.indexedBytes);
    const id = pick(ids);
    const got = index.get(id);
    const want = oracle.get(id);
    expect(got && { ...got, tokens: [...got.tokens].sort() }).toEqual(
      want && { ...want, tokens: [...want.tokens].sort() },
    );
    for (let k = 0; k < 3; k++) {
      const q = randomQuery();
      const overlay = randomOverlay();
      counts.queries++;
      expect(index.search(q, overlay)).toEqual(oracle.search(q, overlay));
    }
  };

  for (let step = 0; step < steps; step++) {
    const x = r();
    if (x < 0.6) write();
    else if (x < 0.7) {
      // A flush: prepared, or (prepared earlier, writes since) stored. Never inside a compaction's reconcile.
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
          if (parts.length) compaction = index.prepareCompaction(parts);
        }
      } else if (!flush) {
        // Reconciled and stored under the flushes' lock: writes may land before the commit.
        const deletes = index.reconcileCompaction(compaction);
        if (r() < 0.5) write();
        const part = index.commitCompaction(compaction);
        for (const p of compaction.parts) storage.delete(p);
        if (part) storage.set(part, { segment: compaction.segment!, deletes });
        compaction = null;
        counts.compactions++;
      }
    } else if (x < 0.8) {
      // A crash: what is stored, then every document changed since the last flush, at its current state.
      const restarted = new SegmentedTextIndex(["kind"]);
      restarted.load(index.segments.map((p) => storage.get(p)!));
      const next = new Map<TextSegmentPart, Stored>();
      restarted.segments.forEach((p, i) => {
        next.set(p, storage.get(index.segments[i]!)!);
      });
      for (const id of index.changed.keys()) restarted.set(id, oracle.get(id));
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

test("random writes, flushes, compactions and restarts: the same answers as one in-memory index", () => {
  const total = { flushes: 0, compactions: 0, restarts: 0, queries: 0 };
  for (let seed = 1; seed <= 12; seed++) {
    const c = run(seed, 500);
    for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += c[k];
  }
  // Every kind of step happened, many times.
  expect(total.flushes).toBeGreaterThan(100);
  expect(total.compactions).toBeGreaterThan(50);
  expect(total.restarts).toBeGreaterThan(50);
  expect(total.queries).toBe(12 * 500 * 3);
});

test("a flush keeps the changes made after its prepare in the memory part", () => {
  const id = (n: number) => encodeId(10_001, new Uint8Array(16).fill(n));
  const doc = (t: string): IndexedDoc => ({ tokens: [t], filters: {}, creationTime: 1 });
  const index = new SegmentedTextIndex([]);
  index.set(id(1), doc("old"));
  index.set(id(2), doc("two"));
  const f = index.prepareFlush();
  index.set(id(1), doc("new"));
  index.commitFlush(f);
  expect([...index.changed.keys()]).toEqual([id(1)]);
  expect(index.segments).toHaveLength(1);
  expect(index.segments[0]!.segment.numDocs).toBe(2);
  // The segment's stale copy is deleted; the memory part has the change.
  expect(index.segments[0]!.deletes.count).toBe(1);
  expect(index.get(id(1))).toEqual({ ...doc("new"), bytes: 0 });
  expect(index.search({ tokens: ["old"], prefixLast: false, filters: [] })).toEqual([]);
  expect(index.search({ tokens: ["new"], prefixLast: false, filters: [] }).map((h) => h.id)).toEqual([id(1)]);
  expect(index.memoryBytes).toBeGreaterThan(0);
  const g = index.prepareFlush();
  index.commitFlush(g);
  expect(index.changed.size).toBe(0);
  expect(index.memoryBytes).toBe(0);
});

test("segments loaded after changes arrived: their stale copies are deleted", () => {
  const id = (n: number) => encodeId(10_001, new Uint8Array(16).fill(n));
  const doc = (t: string): IndexedDoc => ({ tokens: [t], filters: {}, creationTime: 1, bytes: 0 });
  const first = new SegmentedTextIndex([]);
  first.set(id(1), doc("old"));
  first.set(id(2), doc("two"));
  const f = first.prepareFlush();
  first.commitFlush(f);
  // A start: a commit lands before the stored segments are loaded.
  const index = new SegmentedTextIndex([]);
  index.set(id(1), doc("new"));
  index.load([{ segment: f.segment!, deletes: null }]);
  expect(index.size).toBe(2);
  expect(index.get(id(1))).toEqual(doc("new"));
  expect(index.search({ tokens: ["old"], prefixLast: false, filters: [] })).toEqual([]);
});

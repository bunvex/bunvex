// Search segments, index level (STUDY-111): today's single in-memory text and vector indexes against the
// segmented ones — everything in the memory part (as the engine runs before any flush), everything flushed into
// one segment, and spread over several — for the time to put every document, a search's latency and the heap.
//   bun bench/search-segments-micro.ts [documents] [segments]

import { heapStats } from "bun:jsc";
import { SegmentedTextIndex, SegmentedVectorIndex, TextIndex, type TextQuery, tokenize } from "@bunvex/search";
import { encodeId } from "@bunvex/values";

const n = Number(process.argv[2] ?? 200_000);
const parts = Number(process.argv[3] ?? 8);
const words = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho".split(" ");
const ids = Array.from({ length: n }, (_, i) => {
  const b = new Uint8Array(16);
  new DataView(b.buffer).setUint32(0, i * 2654435761);
  new DataView(b.buffer).setUint32(4, i);
  return encodeId(10_001, b);
});
const textDoc = (i: number) => ({
  tokens: tokenize(`${Array.from({ length: 12 }, (_, k) => words[(i * 7 + k * 3) % words.length]).join(" ")} n${i}`),
  filters: { kind: `0${i % 10}` },
  creationTime: 1_700_000_000_000 + i,
  bytes: 90,
});
const vectorDoc = (i: number) => {
  const v = Float32Array.from({ length: 64 }, (_, k) => Math.sin(i + k));
  let s = 0;
  for (const x of v) s += x * x;
  return { vector: v.map((x) => x / Math.sqrt(s)), filters: { kind: `0${i % 10}` } };
};
const queries: TextQuery[] = [
  { tokens: ["gamma"], prefixLast: true, filters: [] },
  { tokens: ["alpha", "beta"], prefixLast: true, filters: [] },
  { tokens: ["n12"], prefixLast: true, filters: [] },
  { tokens: ["theta"], prefixLast: false, filters: [["kind", "03"]] },
];

const heap = () => {
  Bun.gc(true);
  return heapStats().heapSize / 2 ** 20;
};
function median(f: () => void, runs: number) {
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    f();
    t.push(performance.now() - s);
  }
  return t.sort((a, b) => a - b)[Math.floor(runs / 2)]!.toFixed(2);
}

function text(kind: "today" | "memory" | "segments") {
  const before = heap();
  let t = performance.now();
  const index = kind === "today" ? new TextIndex() : new SegmentedTextIndex(["kind"]);
  const per = Math.ceil(n / (kind === "segments" ? parts : 1));
  for (let i = 0; i < n; i++) {
    index.set(ids[i]!, textDoc(i));
    if (kind === "segments" && (i + 1) % per === 0) {
      const s = index as SegmentedTextIndex;
      s.commitFlush(s.prepareFlush());
    }
  }
  if (kind === "segments") {
    const s = index as SegmentedTextIndex;
    s.commitFlush(s.prepareFlush());
  }
  const put = performance.now() - t;
  const mib = heap() - before;
  t = performance.now();
  const lat = queries.map((q) => median(() => index.search(q), 5));
  console.log(
    `text ${kind}: put ${Math.round(put)} ms, heap +${mib.toFixed(0)} MiB, search ms (median) ${lat.join(" / ")}`,
  );
  return index;
}

function vector(kind: "today" | "memory" | "segments") {
  const before = heap();
  const t = performance.now();
  const index = new SegmentedVectorIndex(64, ["kind"]);
  const today = new Map<string, ReturnType<typeof vectorDoc>>();
  const per = Math.ceil(n / (kind === "segments" ? parts : 1));
  for (let i = 0; i < n; i++) {
    if (kind === "today") today.set(ids[i]!, vectorDoc(i));
    else index.set(ids[i]!, vectorDoc(i));
    if (kind === "segments" && (i + 1) % per === 0) index.commitFlush(index.prepareFlush());
  }
  if (kind === "segments") index.commitFlush(index.prepareFlush());
  const put = performance.now() - t;
  const mib = heap() - before;
  const q = vectorDoc(7).vector;
  const search =
    kind === "today"
      ? () => {
          // Today's search: every vector, every hit sorted.
          const hits: { id: string; score: number }[] = [];
          for (const [id, d] of today) {
            let dot = 0;
            for (let i = 0; i < q.length; i++) dot = Math.fround(dot + Math.fround(q[i]! * d.vector[i]!));
            hits.push({ id, score: dot });
          }
          hits.sort((a, b) => b.score - a.score);
          return hits.slice(0, 10);
        }
      : () => index.search(q, 10, null);
  console.log(
    `vector ${kind}: put ${Math.round(put)} ms, heap +${mib.toFixed(0)} MiB, search ms (median) ${median(search, 5)}`,
  );
  return [index, today];
}

const keep: unknown[] = [];
for (const kind of ["today", "memory", "segments"] as const) keep.push(text(kind));
for (const kind of ["today", "memory", "segments"] as const) keep.push(vector(kind));
console.log(`(${n} documents; "segments": ${parts} segments)`);

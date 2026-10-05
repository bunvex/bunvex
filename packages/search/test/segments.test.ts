// The segment formats (STUDY-111 PR 1): a text or vector segment gives back what it was built from, read in place
// from its bytes; its deletes keep the statistics of the documents left; a buffer that is not a segment is refused.
import { expect, test } from "bun:test";
import {
  fieldnormToId,
  type IndexedDoc,
  NO_FILTER_KEY,
  SegmentFileError,
  TextSegment,
  TextSegmentDeletes,
  tokenize,
  type VectorDoc,
  VectorSegment,
  VectorSegmentDeletes,
} from "../src/index.ts";

/** A small deterministic generator (mulberry32). */
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

// "𝒜" is above U+FFFF (a surrogate pair), "ｶ" above U+E000: UTF-16 and UTF-8 order them differently.
const WORDS = [
  "alpha",
  "beta",
  "gamma",
  "Ωmega",
  "東京",
  "café",
  "cafe",
  "a",
  "ab",
  "abc",
  "zz",
  "x".repeat(31),
  "𝒜",
  "ｶ",
];

function randomDocs(seed: number, n: number): [string, IndexedDoc][] {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  return Array.from({ length: n }, (_, i) => {
    // Mostly short texts; some long ones, whose fieldnorm codes are lossy (above 24 tokens).
    const words = Array.from({ length: Math.floor(r() * (r() < 0.1 ? 120 : 8)) }, () => pick(WORDS));
    const tokens = tokenize(words.join(" "));
    const filters: Record<string, string> = {};
    if (r() < 0.9) filters.kind = pick(["01", "02", "0a0b", "ff".repeat(20)]);
    filters.owner = pick(["10", "11"]);
    return [
      `id${(i * 7919) % 100_003}-${pick(["x", "é", "Z"])}`,
      { tokens, filters, creationTime: 1_700_000_000_000 + r() * 1e6, bytes: Math.floor(r() * 500) },
    ];
  });
}

/** Every term's documents, by direct count. */
function termDocs(docs: [string, IndexedDoc][]) {
  const out = new Map<string, Map<string, number>>();
  for (const [id, d] of docs)
    for (const t of d.tokens) {
      let m = out.get(t);
      if (!m) {
        m = new Map();
        out.set(t, m);
      }
      m.set(id, (m.get(id) ?? 0) + 1);
    }
  return out;
}

const sortedTokens = (d: IndexedDoc) => [...d.tokens].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

test("a text segment gives back its documents, terms, postings, filters and totals", () => {
  const docs = randomDocs(1, 300);
  const seg = TextSegment.open(TextSegment.build(docs, ["kind", "owner"]));
  expect(seg.numDocs).toBe(300);
  expect(seg.filterFields).toEqual(["kind", "owner"]);
  expect(seg.totalTokens).toBe(docs.reduce((s, [, d]) => s + d.tokens.length, 0));
  expect(seg.indexedBytes).toBe(docs.reduce((s, [, d]) => s + d.bytes!, 0));

  // Documents sorted by id bytes; each found by its id, given back whole.
  const ids = docs.map(([id]) => id).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  expect(Array.from({ length: seg.numDocs }, (_, d) => seg.id(d))).toEqual(ids);
  for (const [id, doc] of docs) {
    const d = seg.docOf(id);
    expect(d).toBe(ids.indexOf(id));
    const back = seg.get(d);
    expect(sortedTokens(back)).toEqual(sortedTokens(doc));
    expect(back.filters).toEqual(doc.filters);
    expect(back.creationTime).toBe(doc.creationTime);
    expect(back.bytes).toBe(doc.bytes!);
    expect(seg.length(d)).toBe(doc.tokens.length);
    expect(seg.fieldnormId(d)).toBe(fieldnormToId(doc.tokens.length));
  }
  expect(seg.docOf("missing")).toBe(-1);

  // Terms by bytes, with their postings (documents ascending) and frequencies.
  const byTerm = termDocs(docs);
  expect(seg.numTerms).toBe(byTerm.size);
  const terms = [...byTerm.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  terms.forEach((t, ord) => {
    expect(seg.term(ord)).toBe(t);
    expect(seg.termOrd(t)).toBe(ord);
    expect(seg.df(ord)).toBe(byTerm.get(t)!.size);
    const { docs: ps, tf } = seg.postings(ord);
    expect([...ps]).toEqual([...ps].sort((a, b) => a - b));
    expect(new Map([...ps].map((d, k) => [seg.id(d), tf[k]!]))).toEqual(byTerm.get(t)!);
  });
  expect(seg.termOrd("nothere")).toBe(-1);

  // Prefix ranges.
  const prefixes = new Set(["", "zzz", ...terms.flatMap((t) => [...t].map((_, i) => [...t].slice(0, i + 1).join("")))]);
  for (const prefix of prefixes) {
    const [from, to] = seg.termsWithPrefix(prefix);
    expect(terms.slice(from, to)).toEqual(terms.filter((t) => t.startsWith(prefix)));
  }

  // Filter keys: an ordinal per value in the table, NO_FILTER_KEY when missing; unknown keys are -1.
  for (const [id, doc] of docs) {
    const d = seg.docOf(id);
    if (doc.filters.kind === undefined) expect(seg.filterOrd(0, d)).toBe(NO_FILTER_KEY);
    else expect(seg.filterOrd(0, d)).toBe(seg.filterKeyOrd(0, doc.filters.kind));
    expect(seg.filterOrd(1, d)).toBe(seg.filterKeyOrd(1, doc.filters.owner!));
  }
  expect(seg.filterKeyOrd(0, "99")).toBe(-1);
});

test("an empty text segment, and documents with no tokens", () => {
  const empty = TextSegment.open(TextSegment.build([], ["f"]));
  expect([empty.numDocs, empty.numTerms, empty.totalTokens]).toEqual([0, 0, 0]);
  expect(empty.docOf("x")).toBe(-1);
  expect(empty.termsWithPrefix("a")).toEqual([0, 0]);
  const blank = TextSegment.open(
    TextSegment.build([["b", { tokens: [], filters: { f: "00" }, creationTime: 1 }]], ["f"]),
  );
  expect(blank.get(0)).toEqual({ tokens: [], filters: { f: "00" }, creationTime: 1, bytes: 0 });
});

test("deletes subtract each deleted document's count, tokens, bytes and terms; encoded and decoded", () => {
  const docs = randomDocs(2, 200);
  const seg = TextSegment.open(TextSegment.build(docs, ["kind", "owner"]));
  const del = TextSegmentDeletes.none(seg);
  const r = rng(3);
  const gone = docs.filter(() => r() < 0.3);
  for (const [id] of gone) expect(del.delete(seg.docOf(id))).toBe(true);
  expect(del.delete(seg.docOf(gone[0]![0]))).toBe(false);
  const check = (x: TextSegmentDeletes) => {
    expect(x.count).toBe(gone.length);
    expect(x.live).toBe(docs.length - gone.length);
    expect(x.tokens).toBe(gone.reduce((s, [, d]) => s + d.tokens.length, 0));
    expect(x.bytes).toBe(gone.reduce((s, [, d]) => s + d.bytes!, 0));
    const deletedTerms = termDocs(gone);
    for (let ord = 0; ord < seg.numTerms; ord++) expect(x.df(ord)).toBe(deletedTerms.get(seg.term(ord))?.size ?? 0);
    for (const [id] of docs) expect(x.has(seg.docOf(id))).toBe(gone.some(([g]) => g === id));
  };
  check(del);
  const back = TextSegmentDeletes.decode(seg, del.encode());
  check(back);
  // A copy is independent.
  const copy = back.clone();
  const alive = docs.find(([id]) => !back.has(seg.docOf(id)))!;
  copy.delete(seg.docOf(alive[0]));
  check(back);
  // Deletes name their segment.
  const other = TextSegment.open(TextSegment.build(docs, ["kind", "owner"]));
  expect(() => TextSegmentDeletes.decode(other, del.encode())).toThrow(SegmentFileError);
});

test("a vector segment gives back its ids, vectors bit for bit and filter keys; its deletes", () => {
  const r = rng(4);
  const docs: [string, VectorDoc][] = Array.from({ length: 100 }, (_, i) => [
    `v${(i * 37) % 101}`,
    {
      vector: Float32Array.from({ length: 5 }, () => r() * 2 - 1),
      filters: (i % 3 ? { a: (i % 4).toString(16).padStart(2, "0") } : {}) as Record<string, string>,
    },
  ]);
  docs[0]![1].vector[0] = Number.NaN;
  docs[1]![1].vector[1] = -0;
  const seg = VectorSegment.open(VectorSegment.build(docs, 5, ["a"]));
  expect([seg.numDocs, seg.dimensions]).toEqual([100, 5]);
  const ids = docs.map(([id]) => id).sort();
  expect(Array.from({ length: 100 }, (_, d) => seg.id(d))).toEqual(ids);
  for (const [id, doc] of docs) {
    const d = seg.docOf(id);
    const back = seg.get(d);
    expect(Buffer.from(back.vector.buffer, back.vector.byteOffset, 20)).toEqual(
      Buffer.from(doc.vector.buffer, doc.vector.byteOffset, 20),
    );
    expect(back.filters).toEqual(doc.filters);
    if (doc.filters.a) expect(seg.filterOrd(0, d)).toBe(seg.filterKeyOrd(0, doc.filters.a));
    else expect(seg.filterOrd(0, d)).toBe(NO_FILTER_KEY);
  }
  expect(() => VectorSegment.build([["x", { vector: new Float32Array(4), filters: {} }]], 5, [])).toThrow();

  const del = VectorSegmentDeletes.none(seg);
  del.delete(3);
  del.delete(7);
  expect(del.delete(7)).toBe(false);
  const back = VectorSegmentDeletes.decode(seg, del.encode());
  expect([back.count, back.live, back.has(3), back.has(7), back.has(4)]).toEqual([2, 98, true, true, false]);
});

test("a buffer that is not a segment of its kind is refused", () => {
  const text = TextSegment.build(randomDocs(5, 10), ["kind", "owner"]);
  const vector = VectorSegment.build([["v", { vector: new Float32Array(2), filters: {} }]], 2, []);
  expect(() => TextSegment.open(vector)).toThrow(/kind 3, expected 1/); // another kind
  expect(() => VectorSegment.open(text)).toThrow(/kind 1, expected 3/);
  expect(() => TextSegment.open(new Uint8Array(8))).toThrow(SegmentFileError); // too short
  const badMagic = text.slice();
  badMagic[0] = 0;
  expect(() => TextSegment.open(badMagic)).toThrow(SegmentFileError);
  const otherFormat = text.slice();
  new Uint32Array(otherFormat.buffer)[1] = 99;
  expect(() => TextSegment.open(otherFormat)).toThrow(/format 99/);
  expect(() => TextSegment.open(text.slice(0, text.length - 64))).toThrow(SegmentFileError); // truncated
});

test("opening reads the given bytes in place: no section is copied", () => {
  const bytes = TextSegment.build(randomDocs(6, 50), ["kind", "owner"]);
  const seg = TextSegment.open(bytes);
  expect(seg.bytes).toBe(bytes);
  // Every typed array the segment holds is a view over that buffer.
  const views = Object.values(seg).filter((x) => ArrayBuffer.isView(x));
  expect(views.length).toBeGreaterThan(5);
  for (const v of views) expect((v as Uint8Array).buffer).toBe(bytes.buffer);
  const tables = Object.values(seg).filter((x) => x && typeof x === "object" && "offsets" in x);
  for (const t of tables) expect((t as { data: Uint8Array }).data.buffer).toBe(bytes.buffer);
  const vbytes = VectorSegment.build([["v", { vector: Float32Array.of(1, 2), filters: {} }]], 2, []);
  expect(VectorSegment.open(vbytes).vectors.buffer).toBe(vbytes.buffer);
  // An unaligned buffer (a slice of a pooled one) is copied once, then read the same.
  const unaligned = new Uint8Array(bytes.length + 1);
  unaligned.set(bytes, 1);
  expect(TextSegment.open(unaligned.subarray(1)).get(0)).toEqual(seg.get(0));
});

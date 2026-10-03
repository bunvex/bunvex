// The search package (STUDY-45): the analyzer, tantivy's fieldnorm codes and BM25, and the index's term selection,
// matching, ranking, limits and overlay.
import { expect, test } from "bun:test";
import { encodeId } from "@bunvex/values";
import type { IndexedDoc } from "../src/index.ts";
import { Bm25Weight, FIELDNORMS, fieldnormToId, idf, MAX_CANDIDATE_REVISIONS, TextIndex, tokenize } from "../src/index.ts";

test("the analyzer: alphanumeric runs, long tokens dropped by bytes, lowercased per character", () => {
  expect(tokenize("Hello, happy tax-payer! café 3rd 1.5")).toEqual(["hello", "happy", "tax", "payer", "café", "3rd", "1", "5"]);
  expect(tokenize("")).toEqual([]);
  expect(tokenize("!!! ...")).toEqual([]);
  // 31 bytes kept, 32 dropped; "é" is two bytes.
  expect(tokenize(`${"a".repeat(31)} ${"b".repeat(32)} ${"é".repeat(16)}`)).toEqual(["a".repeat(31)]);
  // Unicode letters and digits; a final capital sigma lowers to σ, as Rust's per-character lowering.
  expect(tokenize("ΟΔΟΣ 東京 ٣")).toEqual(["οδοσ", "東京", "٣"]);
});

test("fieldnorm codes: exact up to 40, then lossy; a length maps to the largest code not above it", () => {
  expect(FIELDNORMS.slice(0, 42)).toEqual([...Array.from({ length: 41 }, (_, i) => i), 42]);
  expect(FIELDNORMS[255]).toBe(2_013_265_944);
  expect([0, 24, 40, 41, 42, 43, 100].map(fieldnormToId)).toEqual([0, 24, 40, 40, 41, 41, fieldnormToId(100)]);
  expect(FIELDNORMS[fieldnormToId(100)]).toBeLessThanOrEqual(100);
  expect(fieldnormToId(2 ** 32 - 1)).toBe(255);
});

test("BM25 as tantivy: idf, the length normalization, the boost", () => {
  expect(idf(1, 10)).toBeCloseTo(Math.log(1 + 9.5 / 1.5), 5);
  const w = new Bm25Weight(1, 10, 4);
  // weight = idf × 2.2; tf / (tf + 1.2 × (1 − 0.75 + 0.75 × len / avg))
  const expected = idf(1, 10) * 2.2 * (2 / (2 + 1.2 * (0.25 + 0.75 * (8 / 4))));
  expect(w.score(fieldnormToId(8), 2)).toBeCloseTo(expected, 5);
  expect(new Bm25Weight(1, 10, 4, 0.5).score(fieldnormToId(8), 2)).toBeCloseTo(expected / 2, 5);
});

const id = (n: number) => encodeId(10001, new Uint8Array(16).fill(n));
const doc = (text: string, creationTime: number, filters: Record<string, string> = {}): IndexedDoc => ({
  tokens: tokenize(text),
  filters,
  creationTime,
});
const q = (text: string, filters: [string, string][] = [], prefixLast = true) => ({
  tokens: tokenize(text),
  prefixLast,
  filters,
});

test("matching and ranking: any term, every filter; BM25; ties by _creationTime then id, newest first", () => {
  const ix = new TextIndex();
  ix.set(id(1), doc("the quick brown fox", 1, { c: "a" }));
  ix.set(id(2), doc("quick quick quick", 2, { c: "b" }));
  ix.set(id(3), doc("a slow brown dog", 3, { c: "a" }));
  ix.set(id(4), doc("nothing here", 4, { c: "a" }));
  const hits = ix.search(q("quick brown", [], false));
  // By hand: N = 4, df = 2 for both terms (idf = ln 2), average length 13/4. Two matched terms beat one term
  // three times.
  const part = (tf: number, len: number) => Math.log(2) * 2.2 * (tf / (tf + 1.2 * (0.25 + (0.75 * len) / 3.25)));
  expect(hits.map((h) => h.id)).toEqual([id(1), id(2), id(3)]);
  expect(hits[0]!.score).toBeCloseTo(2 * part(1, 4), 4);
  expect(hits[1]!.score).toBeCloseTo(part(3, 3), 4);
  expect(ix.search(q("quick brown", [["c", "a"]], false)).map((h) => h.id)).toEqual([id(1), id(3)]);
  // Equal scores: the newer document first.
  const tie = new TextIndex();
  tie.set(id(5), doc("same words", 5));
  tie.set(id(6), doc("same words", 6));
  expect(tie.search(q("same")).map((h) => h.id)).toEqual([id(6), id(5)]);
  // A filter alone matches nothing; neither does a query with no tokens.
  expect(ix.search(q("zzz", [["c", "a"]]))).toEqual([]);
  expect(ix.search(q("!!"))).toEqual([]);
});

test("the last term also matches as a prefix, at half weight; earlier terms only exactly", () => {
  const ix = new TextIndex();
  ix.set(id(1), doc("prefix", 1));
  ix.set(id(2), doc("prefixes", 2));
  ix.set(id(3), doc("pre", 3));
  expect(ix.search(q("pre")).map((h) => h.id)).toEqual([id(3), id(2), id(1)]);
  const exact = ix.search(q("pre")).find((h) => h.id === id(3))!.score;
  const expanded = ix.search(q("pre")).find((h) => h.id === id(1))!.score;
  expect(expanded).toBeLessThan(exact);
  expect(ix.search(q("pre", [], false)).map((h) => h.id)).toEqual([id(3)]);
  // Not the last term: exact only.
  expect(ix.search(q("pre zzz")).map((h) => h.id)).toEqual([id(3)]);
});

test("at most 16 query terms and 1024 hits", () => {
  const ix = new TextIndex();
  ix.set(id(1), doc("seventeenth", 1));
  const sixteen = Array.from({ length: 16 }, (_, i) => `w${i}`).join(" ");
  expect(ix.search(q(`${sixteen} seventeenth`, [], false))).toEqual([]);
  const big = new TextIndex();
  for (let i = 0; i < 1100; i++) big.set(encodeId(10001, new Uint8Array(16).fill(i % 256).map((b, j) => (j === 0 ? i >> 8 : b))), doc("word", i));
  expect(big.search(q("word")).length).toBe(MAX_CANDIDATE_REVISIONS);
});

test("an overlay replaces documents, statistics included", () => {
  const ix = new TextIndex();
  ix.set(id(1), doc("apple", 1));
  ix.set(id(2), doc("banana", 2));
  // Delete 1, change 2 to an apple, add 3.
  const overlay = new Map<string, IndexedDoc | null>([
    [id(1), null],
    [id(2), doc("apple pie", 2)],
    [id(3), doc("apple", 3)],
  ]);
  const hits = ix.search(q("apple", [], false), overlay);
  expect(hits.map((h) => h.id)).toEqual([id(3), id(2)]);
  // The same corpus built directly scores the same.
  const direct = new TextIndex();
  direct.set(id(2), doc("apple pie", 2));
  direct.set(id(3), doc("apple", 3));
  expect(direct.search(q("apple", [], false))).toEqual(hits);
  // The index itself is unchanged.
  expect(ix.search(q("apple", [], false)).map((h) => h.id)).toEqual([id(1)]);
});

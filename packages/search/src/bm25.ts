// BM25 as tantivy scores it (src/query/bm25.rs, src/fieldnorm/code.rs), in 32-bit floats as tantivy's `Score`
// (every step rounded with Math.fround), so that ranks — near-ties included — come out as Convex's (STUDY-45
// S3). A document's length is kept as tantivy's one-byte "fieldnorm" code, which is lossy above 24 tokens.

const f = Math.fround;
const K1 = f(1.2);
const B = f(0.75);

/** The length a fieldnorm code stands for: exact below 24, then 3-bit mantissa and exponent steps. */
function decodeFieldnorm(id: number): number {
  const IDENTITY = 24;
  if (id < IDENTITY) return id;
  const b = id - IDENTITY;
  const bits = b & 0b111;
  const shift = b >> 3;
  return IDENTITY + (shift === 0 ? bits : (bits | 8) * 2 ** (shift - 1));
}

/** Every code's length, ascending. */
export const FIELDNORMS: readonly number[] = Array.from({ length: 256 }, (_, i) => decodeFieldnorm(i));

/** The code of a length: the largest whose length does not exceed it (tantivy's `fieldnorm_to_id`). */
export function fieldnormToId(length: number): number {
  let lo = 0;
  let hi = 255;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (FIELDNORMS[mid]! <= length) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** tantivy's `idf`: ln(1 + (N − n + 0.5) / (n + 0.5)). */
export function idf(docFreq: number, docCount: number): number {
  const x = f(f(docCount - docFreq + 0.5) / f(docFreq + 0.5));
  return f(Math.log(f(1 + x)));
}

/** One query term's weight (tantivy's `Bm25Weight::for_one_term(…).boost_by(boost)`). */
export class Bm25Weight {
  private readonly weight: number;
  private readonly cache = new Float32Array(256);
  constructor(docFreq: number, docCount: number, averageFieldnorm: number, boost = 1) {
    this.weight = f(f(idf(docFreq, docCount) * f(1 + K1)) * f(boost));
    const avg = f(averageFieldnorm);
    for (let id = 0; id < 256; id++)
      this.cache[id] = f(K1 * f(f(1 - B) + f(f(B * FIELDNORMS[id]!) / avg)));
  }
  /** The score of a document with this fieldnorm code and this many occurrences of the term. */
  score(fieldnormId: number, termFreq: number): number {
    const tf = f(termFreq);
    return f(this.weight * f(tf / f(tf + this.cache[fieldnormId]!)));
  }
}

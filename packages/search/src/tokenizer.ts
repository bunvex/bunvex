// The analyzer of Convex's search (crates/search/src/constants.rs): tantivy's `SimpleTokenizer`, then
// `RemoveLongFilter::limit(32)`, then `LowerCaser`. One analyzer for documents, queries and read sets.

/** Convex's MAX_TEXT_TERM_LENGTH: a token of this many UTF-8 bytes or more is dropped (not truncated). */
export const MAX_TEXT_TERM_LENGTH = 32;

/** Runs of alphanumeric characters (Rust's `char::is_alphanumeric`: alphabetic or numeric). */
const WORD = /[\p{Alphabetic}\p{N}]+/gu;
const encoder = new TextEncoder();

/** The tokens of `text`, in order, duplicates kept. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(WORD)) {
    const word = m[0];
    // The length is checked before lowercasing, in bytes, as tantivy's filter (`len < limit`).
    if (encoder.encode(word).length >= MAX_TEXT_TERM_LENGTH) continue;
    // Character by character, as Rust's `char::to_lowercase` (no context: a final Σ is σ, not ς).
    let lower = "";
    for (const c of word) lower += c.toLowerCase();
    out.push(lower);
  }
  return out;
}

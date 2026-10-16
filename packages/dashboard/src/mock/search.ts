// The mock's text search (STUDY-163 §5): enough of a search index's behaviour for the filter bar on the demo data —
// the search field's words, lower-cased, the last query word a prefix (Convex's `prefix_last`), documents with at
// least one match ranked by how many query words they match, then newest first. A deployment ranks by BM25.
import type { Document, SearchIndexInfo } from "../data-source.ts";
import { fieldValue } from "../filters.ts";

/** Words, as a search index keeps them: letters and digits, lower-cased. */
export const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** The documents a search finds, best first; an empty search finds nothing, as a search query does. */
export function searchDocuments(docs: Document[], ix: SearchIndexInfo, search: string): Document[] {
  const terms = words(search);
  if (terms.length === 0) return [];
  const scored: { d: Document; score: number }[] = [];
  for (const d of docs) {
    const v = fieldValue(d, ix.searchField);
    if (typeof v !== "string") continue;
    const own = new Set(words(v));
    let score = 0;
    terms.forEach((t, i) => {
      const last = i === terms.length - 1;
      if (own.has(t) || (last && [...own].some((w) => w.startsWith(t)))) score++;
    });
    if (score > 0) scored.push({ d, score });
  }
  return scored.sort((a, b) => b.score - a.score || b.d._creationTime - a.d._creationTime).map((s) => s.d);
}

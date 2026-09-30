// The newest-version-per-key walk behind `Persistence.scan` for drivers that cannot express it in one query
// (PERSIST-01 C2). A driver fetches index rows in (key, ts desc) order — reversed key order when `desc` —
// and this decides each key by its first (newest) row. It pages until `limit` live ids are found or the
// range is exhausted: old versions and removed entries can never make a scan come back short.
import { compareKeys } from "../keyenc.ts";

/** One index row version as a driver reads it. `id === null` (or `deleted`) is a removed entry. */
export type IndexRow = { key: Uint8Array; deleted: boolean; id: string | null };
/** A page request: rows with lo ≤ key < hi and ts ≤ snapshot, in scan order, at most n. */
export type PageRequest = { lo: Uint8Array; hi: Uint8Array; n: number };
/**
 * A page: rows in scan order. `exhausted` says the range has no more rows. A plain array means
 * "exhausted iff it has fewer than n rows". A driver that filters rows after reading them (split long
 * keys) returns `exhausted` explicitly; it may then return an empty page that is not the end, and must
 * make progress on the next request.
 */
export type Page = IndexRow[] | { rows: IndexRow[]; exhausted: boolean };

const MAX_PAGE = 4096;

function* latestLive(
  lo: Uint8Array,
  hi: Uint8Array,
  limit: number,
  desc: boolean,
): Generator<PageRequest, string[], Page> {
  const out: string[] = [];
  if (limit <= 0) return out;
  let n = Math.min(Math.max(limit * 2, 8), MAX_PAGE);
  let last: Uint8Array | null = null;
  for (;;) {
    const page = yield { lo, hi, n };
    const rows = Array.isArray(page) ? page : page.rows;
    const exhausted = Array.isArray(page) ? page.length < n : page.exhausted;
    for (const r of rows) {
      if (last && compareKeys(last, r.key) === 0) continue; // an older version of a decided key
      last = r.key;
      if (!r.deleted && r.id !== null) {
        out.push(r.id);
        if (out.length >= limit) return out;
      }
    }
    if (exhausted) return out;
    // Continue strictly past the last key seen: its remaining rows are older versions. (With no row in
    // this page, the same request is repeated: the driver guarantees progress.)
    if (last) {
      if (desc) hi = last;
      else lo = successor(last);
    }
    n = Math.min(n * 2, MAX_PAGE);
  }
}

/** The smallest key greater than `k`. */
function successor(k: Uint8Array): Uint8Array {
  const s = new Uint8Array(k.length + 1);
  s.set(k);
  return s;
}

export function scanLatestSync(
  fetch: (p: PageRequest) => Page,
  lo: Uint8Array,
  hi: Uint8Array,
  limit: number,
  desc: boolean,
): string[] {
  const g = latestLive(lo, hi, limit, desc);
  let step = g.next();
  while (!step.done) step = g.next(fetch(step.value));
  return step.value;
}

export async function scanLatest(
  fetch: (p: PageRequest) => Promise<Page>,
  lo: Uint8Array,
  hi: Uint8Array,
  limit: number,
  desc: boolean,
): Promise<string[]> {
  const g = latestLive(lo, hi, limit, desc);
  let step = g.next();
  while (!step.done) step = g.next(await fetch(step.value));
  return step.value;
}

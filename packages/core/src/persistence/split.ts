// Long index keys in stores whose indexed columns have a size limit (Postgres btree ~2.7 KB, MySQL
// InnoDB 3072 bytes). As Convex does (crates/common/src/index.rs, crates/postgres/src/sql.rs), a key is
// stored as `key_prefix` (its first 2500 bytes), `key_suffix` (the rest, or null) and `key_suffix_hash`
// (sha256 of the suffix, empty without one), and the store orders rows by (key_prefix, key_suffix_hash).
// That order is the true key order except among keys that share a full-length prefix; `splitPages` reads
// such a group whole and sorts it by the full key, so scans still see PERSIST-01's byte order.
import { createHash } from "node:crypto";
import { compareKeys } from "../keyenc.ts";
import type { IndexRow, Page, PageRequest } from "./scan.ts";

export const MAX_KEY_PREFIX_LEN = 2500;

export function splitKey(key: Uint8Array): { prefix: Uint8Array; suffix: Uint8Array | null; suffixHash: Uint8Array } {
  if (key.length <= MAX_KEY_PREFIX_LEN) return { prefix: key, suffix: null, suffixHash: new Uint8Array(0) };
  const suffix = key.subarray(MAX_KEY_PREFIX_LEN);
  return {
    prefix: key.subarray(0, MAX_KEY_PREFIX_LEN),
    suffix,
    suffixHash: new Uint8Array(createHash("sha256").update(suffix).digest()),
  };
}

/** One stored index row version, as a split-key store returns it. */
export type SplitRow = {
  prefix: Uint8Array;
  suffix: Uint8Array | null;
  ts: number;
  deleted: boolean;
  id: string | null;
};

/** A split-key store's two queries, both at the scan's snapshot. */
export type SplitSource = {
  /**
   * Rows whose key_prefix is within the bounds, ordered by (key_prefix, key_suffix_hash) in the scan's
   * direction, then ts descending; at most n.
   */
  page(b: { lo: Uint8Array; loStrict: boolean; hi: Uint8Array; hiInclusive: boolean; n: number }): Promise<SplitRow[]>;
  /** Every row whose key_prefix equals `prefix` (a full-length prefix: its keys continue in suffixes). */
  group(prefix: Uint8Array): Promise<SplitRow[]>;
};

const fullKey = (r: SplitRow) => {
  if (!r.suffix) return r.prefix;
  const k = new Uint8Array(r.prefix.length + r.suffix.length);
  k.set(r.prefix);
  k.set(r.suffix, r.prefix.length);
  return k;
};
const hex = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("hex");

/**
 * Turn a split-key store into the page fetcher `scanLatest` drives: true key order, bounds applied to the
 * full key. Stateful for ONE scan: a full-length prefix group is read once, and later pages skip it.
 */
export function splitPages(src: SplitSource, desc: boolean): (p: PageRequest) => Promise<Page> {
  const consumed = new Set<string>();
  return async ({ lo, hi, n }) => {
    const loP = lo.subarray(0, MAX_KEY_PREFIX_LEN);
    const hiP = hi.subarray(0, MAX_KEY_PREFIX_LEN);
    const bounds = {
      lo: loP,
      // A group already read is never read again: its prefix becomes an exclusive bound.
      loStrict: !desc && consumed.has(hex(loP)),
      hi: hiP,
      // A longer upper bound can still be reached by keys with prefix == hiP.
      hiInclusive: hi.length > MAX_KEY_PREFIX_LEN && !(desc && consumed.has(hex(hiP))),
      n,
    };
    if (desc && consumed.has(hex(hiP))) bounds.hiInclusive = false;
    const raw = await src.page(bounds);
    const rows: IndexRow[] = [];
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i];
      if (r.prefix.length < MAX_KEY_PREFIX_LEN) {
        rows.push({ key: r.prefix, deleted: r.deleted, id: r.id });
        continue;
      }
      // A full-length prefix: read its whole group, sort by the full key (then newest first), and skip the
      // rest of this page's rows with the same prefix.
      const p = r.prefix;
      const tag = hex(p);
      while (i + 1 < raw.length && compareKeys(raw[i + 1].prefix, p) === 0) i++;
      if (consumed.has(tag)) continue;
      consumed.add(tag);
      const group = (await src.group(p)).map((g) => ({ key: fullKey(g), ts: g.ts, deleted: g.deleted, id: g.id }));
      group.sort((a, b) => (desc ? compareKeys(b.key, a.key) : compareKeys(a.key, b.key)) || b.ts - a.ts);
      for (const g of group) rows.push({ key: g.key, deleted: g.deleted, id: g.id });
    }
    // Prefix bounds are exact when both bounds fit in a prefix (a key compares to a short bound as its
    // prefix does). Longer bounds are coarse: apply the exact ones.
    const exact = lo.length <= MAX_KEY_PREFIX_LEN && hi.length <= MAX_KEY_PREFIX_LEN;
    const inRange = exact ? rows : rows.filter((r) => compareKeys(r.key, lo) >= 0 && compareKeys(r.key, hi) < 0);
    return { rows: inRange, exhausted: raw.length < n };
  };
}

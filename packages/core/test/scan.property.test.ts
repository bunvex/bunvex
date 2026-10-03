// The newest-version scan and the split-key store, against a brute-force oracle (TEST-01 §2). A model
// index holds row versions (key, ts, removed or a document id); for any range, direction and limit, the
// paged scan must return exactly the oracle's answer: each key decided by its newest version, live ids in
// key order, the first `limit`. The same model is then stored as a Postgres / MySQL driver stores long keys
// (key_prefix of 2500 bytes, the rest in key_suffix, ordered by the suffix's hash — persistence/split.ts, as
// Convex does in crates/common/src/index.rs and crates/postgres/src/sql.rs) and scanned through
// `splitPages`: the answer must not change. Convex's persistence suite checks such ranges on every driver
// (crates/common/src/testing/persistence_test_suite.rs `query_index_range_{prefix,short,long}`,
// convex-backend bea52bde0); bunvex's driver conformance does too (K9) — this checks the shared logic for
// every shape at once, without a database.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fc from "fast-check";
import { compareKeys } from "../src/keyenc.ts";
import { type IndexRow, type PageRequest, scanLatest, scanLatestSync } from "../src/persistence/scan.ts";
import { MAX_KEY_PREFIX_LEN, type SplitRow, type SplitSource, splitPages } from "../src/persistence/split.ts";
import { runs } from "./property-runs.ts";

type Version = { key: Uint8Array; ts: number; id: string | null };

const shortKey = fc.uint8Array({ minLength: 0, maxLength: 4, max: 3 });
// Long keys share one of two 2500-byte prefixes (so groups form) and differ in a short suffix.
const prefixes = [new Uint8Array(MAX_KEY_PREFIX_LEN).fill(1), new Uint8Array(MAX_KEY_PREFIX_LEN).fill(2)];
const longKey = fc
  .tuple(fc.constantFrom(0, 1), fc.uint8Array({ minLength: 0, maxLength: 3, max: 3 }))
  .map(([p, s]) => Uint8Array.from([...prefixes[p]!, ...s]));
const key = fc.oneof({ weight: 3, arbitrary: shortKey }, { weight: 2, arbitrary: longKey });

const versions = fc
  .array(fc.tuple(key, fc.option(fc.constantFrom("a", "b", "c", "d", "e"), { nil: null })), { maxLength: 40 })
  .map((rows) => rows.map(([k, id], ts): Version => ({ key: k, ts, id })));

/** For each key, its newest version; live ones in scan order, the first `limit`. */
function oracle(vs: Version[], lo: Uint8Array, hi: Uint8Array, limit: number, desc: boolean): string[] {
  const newest = new Map<string, Version>();
  for (const v of vs) {
    if (compareKeys(v.key, lo) < 0 || compareKeys(v.key, hi) >= 0) continue;
    const h = Buffer.from(v.key).toString("hex");
    const cur = newest.get(h);
    if (!cur || v.ts > cur.ts) newest.set(h, v);
  }
  return [...newest.values()]
    .sort((a, b) => (desc ? compareKeys(b.key, a.key) : compareKeys(a.key, b.key)))
    .filter((v) => v.id !== null)
    .slice(0, Math.max(0, limit))
    .map((v) => v.id!);
}

/** A driver that reads index rows in (key, ts desc) order — reversed key order when desc. */
function plainFetch(vs: Version[], desc: boolean) {
  const sorted = [...vs].sort((a, b) => (desc ? compareKeys(b.key, a.key) : compareKeys(a.key, b.key)) || b.ts - a.ts);
  return ({ lo, hi, n }: PageRequest): IndexRow[] =>
    sorted
      .filter((v) => compareKeys(v.key, lo) >= 0 && compareKeys(v.key, hi) < 0)
      .slice(0, n)
      .map((v) => ({ key: v.key, deleted: v.id === null, id: v.id }));
}

/** The same versions stored with split keys, queried as the SQL drivers query them. */
function splitSource(vs: Version[], desc: boolean): SplitSource {
  const rows: (SplitRow & { hash: Uint8Array })[] = vs.map((v) => {
    const long = v.key.length > MAX_KEY_PREFIX_LEN;
    const suffix = long ? v.key.subarray(MAX_KEY_PREFIX_LEN) : null;
    return {
      prefix: long ? v.key.subarray(0, MAX_KEY_PREFIX_LEN) : v.key,
      suffix,
      hash: suffix ? new Uint8Array(createHash("sha256").update(suffix).digest()) : new Uint8Array(0),
      ts: v.ts,
      deleted: v.id === null,
      id: v.id,
    };
  });
  const order = (a: (typeof rows)[0], b: (typeof rows)[0]) =>
    (desc
      ? compareKeys(b.prefix, a.prefix) || compareKeys(b.hash, a.hash)
      : compareKeys(a.prefix, b.prefix) || compareKeys(a.hash, b.hash)) || b.ts - a.ts;
  return {
    async page({ lo, loStrict, hi, hiInclusive, n }) {
      return rows
        .filter((r) => {
          const c = compareKeys(r.prefix, lo);
          const d = compareKeys(r.prefix, hi);
          return (loStrict ? c > 0 : c >= 0) && (hiInclusive ? d <= 0 : d < 0);
        })
        .sort(order)
        .slice(0, n);
    },
    async group(prefix) {
      return rows.filter((r) => compareKeys(r.prefix, prefix) === 0);
    },
  };
}

const bounds = fc.tuple(key, key).map(([a, b]): [Uint8Array, Uint8Array] => (compareKeys(a, b) <= 0 ? [a, b] : [b, a]));
const limit = fc.integer({ min: 0, max: 12 });

describe("scanning the newest versions, against a brute-force oracle", () => {
  test("a store that reads (key, ts desc) pages: scanLatest returns the oracle's ids", () => {
    fc.assert(
      fc.property(versions, bounds, limit, fc.boolean(), (vs, [lo, hi], n, desc) => {
        expect(scanLatestSync(plainFetch(vs, desc), lo, hi, n, desc)).toEqual(oracle(vs, lo, hi, n, desc));
      }),
      { numRuns: runs(400) },
    );
  });

  test("a split-key store (key_prefix, key_suffix_hash order): splitPages + scanLatest return the same ids", async () => {
    await fc.assert(
      fc.asyncProperty(versions, bounds, limit, fc.boolean(), async (vs, [lo, hi], n, desc) => {
        const got = await scanLatest(splitPages(splitSource(vs, desc), desc), lo, hi, n, desc);
        expect(got).toEqual(oracle(vs, lo, hi, n, desc));
      }),
      { numRuns: runs(300) },
    );
  });
});

// Long index keys split into key_prefix / key_suffix (persistence/split.ts, as Convex's SQL drivers store them):
// `splitKey` itself, and `splitPages` driven by hand. scan.property.test.ts checks splitPages' answers against an
// oracle; mutation testing (TEST-01 §7) found what it leaves untested: the long bounds' edges, a page that is
// full, the order of one key's versions inside a group, and that a group read once is never read again.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { compareKeys } from "../src/keyenc.ts";
import type { IndexRow, PageRequest } from "../src/persistence/scan.ts";
import { scanLatest } from "../src/persistence/scan.ts";
import { MAX_KEY_PREFIX_LEN, type SplitRow, type SplitSource, splitKey, splitPages } from "../src/persistence/split.ts";

const P = MAX_KEY_PREFIX_LEN;
/** A key of a full-length prefix (all `fill`) followed by `suffix`. */
const long = (fill: number, ...suffix: number[]) => Uint8Array.from([...new Uint8Array(P).fill(fill), ...suffix]);
const short = (...b: number[]) => Uint8Array.from(b);

type Version = { key: Uint8Array; ts: number; id: string | null };

/** A split-key store over `vs`, as the SQL drivers query it. It records its group queries, refuses one for a
 *  prefix that is not full-length (its contract), and fails a page that returns a group already read. `groupOrder` is the order `group` returns rows in. */
function store(vs: Version[], desc: boolean, groupOrder: "asc-ts" | "desc-ts" = "desc-ts") {
  const rows = vs.map((v) => {
    const s = splitKey(v.key);
    return {
      prefix: s.prefix,
      suffix: s.suffix,
      hash: s.suffixHash,
      ts: BigInt(v.ts),
      deleted: v.id === null,
      id: v.id,
    };
  });
  const order = (a: (typeof rows)[0], b: (typeof rows)[0]) =>
    (desc
      ? compareKeys(b.prefix, a.prefix) || compareKeys(b.hash, a.hash)
      : compareKeys(a.prefix, b.prefix) || compareKeys(a.hash, b.hash)) || Number(b.ts - a.ts);
  const calls = { group: [] as number[] };
  const read = new Set<number>(); // the groups read, by their fill byte
  const src: SplitSource = {
    async page({ lo, loStrict, hi, hiInclusive, n }) {
      const page = rows
        .filter((r) => {
          const c = compareKeys(r.prefix, lo);
          const d = compareKeys(r.prefix, hi);
          return (loStrict ? c > 0 : c >= 0) && (hiInclusive ? d <= 0 : d < 0);
        })
        .sort(order)
        .slice(0, n) as SplitRow[];
      for (const r of page) if (read.has(r.prefix[0]!) && r.prefix.length === P) throw new Error("a group read again");
      return page;
    },
    async group(prefix) {
      if (prefix.length < P) throw new Error("a group query for a short prefix");
      calls.group.push(prefix[0]!);
      read.add(prefix[0]!);
      const g = rows.filter((r) => compareKeys(r.prefix, prefix) === 0);
      return g.sort((a, b) => (groupOrder === "asc-ts" ? Number(a.ts - b.ts) : Number(b.ts - a.ts))) as SplitRow[];
    },
  };
  return { src, calls };
}

const ids = (es: { id: string }[]) => es.map((e) => e.id);
const ALL_LO = short();
const ALL_HI = short(0xff);

describe("splitKey", () => {
  test("a key that fits is its own prefix, with no suffix and an empty hash", () => {
    for (const key of [short(), short(1, 2, 3), new Uint8Array(P).fill(7)]) {
      const s = splitKey(key);
      expect(s.prefix).toEqual(key);
      expect(s.suffix).toBeNull();
      expect(s.suffixHash).toEqual(new Uint8Array(0));
    }
  });

  test("a longer key: its first 2500 bytes, the rest, and the rest's sha256", () => {
    const s = splitKey(long(7, 1, 2));
    expect(s.prefix).toEqual(new Uint8Array(P).fill(7));
    expect(s.suffix).toEqual(short(1, 2));
    expect(s.suffixHash).toEqual(new Uint8Array(createHash("sha256").update(short(1, 2)).digest()));
  });
});

describe("splitPages", () => {
  test("only a full-length prefix is read as a group, once per scan", async () => {
    const vs: Version[] = [
      { key: short(1), ts: 1, id: "s1" },
      { key: long(2, 1), ts: 1, id: "g1" },
      { key: long(2, 2), ts: 1, id: "g2" },
      { key: short(3), ts: 1, id: "s3" },
    ];
    const { src, calls } = store(vs, false);
    expect(ids(await scanLatest(splitPages(src, false), ALL_LO, ALL_HI, 10, false))).toEqual(["s1", "g1", "g2", "s3"]);
    expect(calls.group).toEqual([2]);
  });

  test("a group bigger than a page is not read again on the next page, ascending or descending", async () => {
    // 20 versions of one long key between two short keys; a limit of 3 asks for 8 rows, then 16: the second
    // page starts at the group's prefix and must exclude it.
    const vs: Version[] = [
      ...Array.from({ length: 20 }, (_, i): Version => ({ key: long(2, 1), ts: i + 1, id: i === 19 ? "g" : null })),
      { key: short(1), ts: 1, id: "before" },
      { key: short(3), ts: 1, id: "after" },
    ];
    for (const desc of [false, true]) {
      const { src, calls } = store(vs, desc);
      const got = ids(await scanLatest(splitPages(src, desc), ALL_LO, ALL_HI, 3, desc));
      expect(got).toEqual(desc ? ["after", "g", "before"] : ["before", "g", "after"]);
      expect(calls.group).toEqual([2]);
    }
  });

  test("a group's versions of one key: the newest decides, whatever order the store returns them in", async () => {
    const vs: Version[] = [
      { key: long(2, 1), ts: 1, id: "old" },
      { key: long(2, 1), ts: 2, id: "new" },
      { key: long(2, 2), ts: 2, id: null },
      { key: long(2, 2), ts: 1, id: "gone" },
    ];
    for (const desc of [false, true]) {
      const { src } = store(vs, desc, "asc-ts");
      const got = await scanLatest(splitPages(src, desc), ALL_LO, ALL_HI, 10, desc);
      expect(got.map((e) => [e.id, e.ts])).toEqual([["new", 2n]]);
    }
  });

  test("a long upper bound: keys of its prefix below it are in the range, the bound itself is not", async () => {
    const vs: Version[] = [
      { key: long(2, 1), ts: 1, id: "below" },
      { key: long(2, 5), ts: 1, id: "at" },
      { key: long(2, 9), ts: 1, id: "above" },
      { key: short(1), ts: 1, id: "short" },
    ];
    const { src } = store(vs, false);
    expect(ids(await scanLatest(splitPages(src, false), ALL_LO, long(2, 5), 10, false))).toEqual(["short", "below"]);
    const d = store(vs, true);
    expect(ids(await scanLatest(splitPages(d.src, true), ALL_LO, long(2, 5), 10, true))).toEqual(["below", "short"]);
  });

  test("a long lower bound: the bound itself is in the range, keys of its prefix below it are not", async () => {
    const vs: Version[] = [
      { key: long(2, 1), ts: 1, id: "below" },
      { key: long(2, 5), ts: 1, id: "at" },
      { key: short(3), ts: 1, id: "after" },
    ];
    const { src } = store(vs, false);
    expect(ids(await scanLatest(splitPages(src, false), long(2, 5), ALL_HI, 10, false))).toEqual(["at", "after"]);
  });

  test("a page whose store rows fill it is not the end, however many rows survive the bounds", async () => {
    const requests: PageRequest[] = [];
    const vs: Version[] = Array.from({ length: 8 }, (_, i): Version => ({ key: short(1, i), ts: 1, id: null }));
    vs.push({ key: short(2), ts: 1, id: "last" });
    const { src } = store(vs, false);
    const pages = splitPages(src, false);
    const got = await scanLatest(
      (p) => {
        requests.push(p);
        return pages(p);
      },
      ALL_LO,
      ALL_HI,
      1,
      false,
    );
    expect(ids(got)).toEqual(["last"]);
    expect(requests).toHaveLength(2);
    // And a page of exactly n rows says so as `exhausted: false`.
    const page = await splitPages(store(vs.slice(0, 8), false).src, false)({ lo: ALL_LO, hi: ALL_HI, n: 8 });
    expect(page).toMatchObject({ exhausted: false });
    expect((page as { rows: IndexRow[] }).rows).toHaveLength(8);
  });
});

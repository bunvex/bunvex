// The newest-version walk's paging (persistence/scan.ts, PERSIST-01 C2), driven by hand: the requests it makes,
// how it continues past a decided key, and when it stops. scan.property.test.ts checks its answers against an
// oracle, but its random keys rarely repeat, so a first page almost always ends the scan; mutation testing
// (TEST-01 §7) found the paging untested. Here every page is scripted.
import { describe, expect, test } from "bun:test";
import { type IndexRow, type Page, type PageRequest, scanLatest, scanLatestSync } from "../src/persistence/scan.ts";

const k = (...b: number[]) => Uint8Array.from(b);
const row = (key: Uint8Array, ts: number, id: string | null, deleted = id === null): IndexRow => ({
  key,
  ts: BigInt(ts),
  deleted,
  id,
});

/** A driver over fixed rows in scan order (key asc or desc, then ts desc): each request gets the rows in
 *  [lo, hi), at most n, and is recorded. */
function driver(rows: IndexRow[]) {
  const requests: PageRequest[] = [];
  const cmp = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b);
  const fetch = (p: PageRequest): IndexRow[] => {
    requests.push({ lo: p.lo, hi: p.hi, n: p.n });
    return rows.filter((r) => cmp(r.key, p.lo) >= 0 && cmp(r.key, p.hi) < 0).slice(0, p.n);
  };
  return { fetch, requests };
}

/** `count` versions of one key, newest first, all removed except possibly the newest. */
const versionsOf = (key: Uint8Array, count: number, newestId: string | null) =>
  Array.from({ length: count }, (_, i) => row(key, 1000 - i, i === 0 ? newestId : null));

const LO = k();
const HI = k(0xff);

describe("the page it asks for", () => {
  test("twice the limit, at least 8 and at most 4096; doubling each page up to 4096", () => {
    const sizes = (limit: number, rowCount: number) => {
      const d = driver(versionsOf(k(1), rowCount, null));
      scanLatestSync(d.fetch, LO, HI, limit, false);
      return d.requests.map((r) => r.n);
    };
    expect(sizes(1, 0)).toEqual([8]);
    expect(sizes(3, 0)).toEqual([8]);
    expect(sizes(10, 0)).toEqual([20]);
    expect(sizes(3000, 0)).toEqual([4096]);
    // One key's versions fill whole pages; the walk skips them and asks for more, doubling.
    const d = driver([...versionsOf(k(1), 8, null), row(k(2), 1, "a")]);
    expect(scanLatestSync(d.fetch, LO, HI, 1, false).map((e) => e.id)).toEqual(["a"]);
    expect(d.requests.map((r) => r.n)).toEqual([8, 16]);
    expect(sizes(1500, 6000).slice(0, 3)).toEqual([3000, 4096]);
  });

  test("a limit of 0 or less asks for nothing", () => {
    const d = driver([row(k(1), 1, "a")]);
    expect(scanLatestSync(d.fetch, LO, HI, 0, false)).toEqual([]);
    expect(scanLatestSync(d.fetch, LO, HI, -1, false)).toEqual([]);
    expect(d.requests).toEqual([]);
  });
});

describe("continuing past a decided key", () => {
  test("ascending: the next page starts just past the last key seen (its older versions are skipped)", () => {
    const d = driver([...versionsOf(k(1), 9, null), row(k(1, 0), 5, "next"), row(k(2), 5, "b")]);
    const got = scanLatestSync(d.fetch, LO, HI, 2, false);
    expect(got.map((e) => e.id)).toEqual(["next", "b"]);
    // The second request's lo is k(1) followed by a 0 byte: the smallest key after k(1), so k(1, 0) is kept.
    expect(d.requests[1]).toEqual({ lo: k(1, 0), hi: HI, n: 16 });
  });

  test("descending: the next page ends at the last key seen, exclusive", () => {
    const rows = [row(k(3), 5, "c"), ...versionsOf(k(2), 9, null), row(k(1), 5, "a")];
    const d = driver([]);
    const desc = (p: PageRequest): IndexRow[] => {
      d.requests.push(p);
      return rows.filter((r) => Buffer.compare(r.key, p.lo) >= 0 && Buffer.compare(r.key, p.hi) < 0).slice(0, p.n);
    };
    expect(scanLatestSync(desc, LO, HI, 2, true).map((e) => e.id)).toEqual(["c", "a"]);
    expect({ lo: d.requests[1]!.lo, hi: d.requests[1]!.hi }).toEqual({ lo: LO, hi: k(2) });
  });

  test("a page with no rows that is not the end repeats the same request", () => {
    const pages: Page[] = [
      { rows: [], exhausted: false },
      { rows: [row(k(1), 1, "a")], exhausted: true },
    ];
    const requests: PageRequest[] = [];
    const got = scanLatestSync(
      (p) => {
        requests.push({ ...p });
        return pages.shift()!;
      },
      LO,
      HI,
      5,
      false,
    );
    expect(got.map((e) => e.id)).toEqual(["a"]);
    expect(requests.map((r) => [r.lo, r.hi])).toEqual([
      [LO, HI],
      [LO, HI],
    ]);
  });
});

describe("when it stops", () => {
  test("a full page is not the end: a page of exactly n rows is followed by another request", () => {
    // Exactly 8 rows of one key in the first page, then the live key: with a short limit both pages are read.
    const d = driver([...versionsOf(k(1), 8, null), row(k(2), 1, "b")]);
    expect(scanLatestSync(d.fetch, LO, HI, 1, false).map((e) => e.id)).toEqual(["b"]);
    expect(d.requests).toHaveLength(2);
  });

  test("a short page is the end, even with fewer live ids than the limit", () => {
    const d = driver([row(k(1), 1, "a"), row(k(2), 1, null)]);
    expect(scanLatestSync(d.fetch, LO, HI, 5, false).map((e) => e.id)).toEqual(["a"]);
    expect(d.requests).toHaveLength(1);
  });

  test("a page marked exhausted is the end, however many rows it has; one marked not exhausted is not", () => {
    const full = Array.from({ length: 8 }, (_, i) => row(k(i + 1), 1, null));
    let calls = 0;
    const got = scanLatestSync(
      () => {
        calls++;
        return calls === 1 ? { rows: full, exhausted: true } : { rows: [], exhausted: true };
      },
      LO,
      HI,
      1,
      false,
    );
    expect(got).toEqual([]);
    expect(calls).toBe(1);
    calls = 0;
    scanLatestSync(
      () => (++calls === 1 ? { rows: [row(k(1), 1, null)], exhausted: false } : { rows: [], exhausted: true }),
      LO,
      HI,
      1,
      false,
    );
    expect(calls).toBe(2);
  });

  test("it stops reading as soon as the limit is reached", () => {
    const d = driver([row(k(1), 1, "a"), row(k(2), 1, "b"), row(k(3), 1, "c")]);
    expect(scanLatestSync(d.fetch, LO, HI, 2, false).map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("which rows are live", () => {
  test("a removed newest version hides the key, whether marked deleted or with no id", () => {
    const rows = [
      row(k(1), 9, "x", true), // deleted, though the driver kept an id
      row(k(1), 8, "old1"),
      row(k(2), 9, null, false), // no id, though not marked deleted
      row(k(2), 8, "old2"),
      row(k(3), 9, "c"),
      row(k(3), 8, "old3"),
    ];
    const got = scanLatestSync(driver(rows).fetch, LO, HI, 10, false);
    expect(got).toEqual([{ key: k(3), ts: 9n, id: "c" }]);
  });
});

test("scanLatest (a driver that answers asynchronously) pages the same way", async () => {
  const d = driver([...versionsOf(k(1), 9, null), row(k(2), 1, "b")]);
  const got = await scanLatest(async (p) => d.fetch(p), LO, HI, 1, false);
  expect(got.map((e) => e.id)).toEqual(["b"]);
  expect(d.requests.map((r) => r.n)).toEqual([8, 16]);
});

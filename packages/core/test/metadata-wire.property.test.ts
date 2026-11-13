// STUDY-194 §4.7, 2b commit 0d: the metadata a worker's transactions read. Any catalog and any text indexes' states
// come back from their text as they were; a worker's copy of the write log answers `changedBetween` as the log the
// main thread posted it; the epochs the main thread counts as sent are the ones the worker still has.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { Catalog, type CatalogIndex } from "../src/catalog.ts";
import type { Interval, LogEntry } from "../src/committer.ts";
import { compareKeys } from "../src/keyenc.ts";
import {
  type CommitKeys,
  decodeCatalog,
  decodeCommits,
  decodeMetadata,
  decodeSearchState,
  EpochWindow,
  encodeCatalog,
  encodeCommits,
  encodeMetadata,
  encodeSearchState,
  METADATA_EPOCHS_KEPT,
  MetadataCopies,
  WriteLogCopy,
} from "../src/metadata-wire.ts";
import type { IndexDef, TableDef } from "../src/schema.ts";
import { SearchIndexes } from "../src/search-indexes.ts";
import { runs } from "./property-runs.ts";

const name = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,10}$/);
const id = fc.string({ minLength: 1, maxLength: 12 });

/** An index as the catalog holds one: any of the optional fields present or not. */
const index = (table: string): fc.Arbitrary<IndexDef> =>
  fc
    .record(
      {
        id,
        name,
        fields: fc.array(fc.string({ maxLength: 8 }), { maxLength: 3 }),
        metaId: id,
        staged: fc.boolean(),
        readyTs: fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }),
      },
      { requiredKeys: ["id", "name", "fields"] },
    )
    .map((ix) => ({ ...ix, table }));

const table = (number: number): fc.Arbitrary<TableDef> =>
  name.chain((tableName) =>
    fc
      .record(
        {
          id,
          metaId: id,
          namespace: id,
          indexes: fc.uniqueArray(index(tableName), { selector: (ix) => ix.name, maxLength: 4 }),
          pending: fc.array(index(tableName), { maxLength: 2 }),
          // A table being deleted can be left with no enabled by_id (its indexes disabled or dropped).
          hasById: fc.boolean(),
        },
        { requiredKeys: ["id", "indexes", "pending", "hasById"] },
      )
      .map(({ indexes, hasById, ...t }) => {
        const byId: IndexDef = { id: `${t.id}/by_id`, table: tableName, name: "by_id", fields: ["_id"] };
        const others = indexes.filter((ix) => ix.name !== "by_id").map((ix) => [ix.name, ix] as const);
        const out: TableDef = {
          ...t,
          name: tableName,
          number,
          indexes: new Map(hasById ? [["by_id", byId], ...others] : others),
          byId: (hasById ? byId : undefined) as IndexDef,
        };
        return out;
      }),
  );

/** A catalog: active tables (unique names and numbers), hidden and deleting ones, and components, one level deep. */
const catalogOf = (depth: number): fc.Arbitrary<Catalog> =>
  fc
    .record({
      active: fc
        .uniqueArray(fc.nat({ max: 10_000 }), { maxLength: 5 })
        .chain((numbers) => fc.tuple(...numbers.map((n) => table(n)))),
      hidden: fc.array(fc.nat({ max: 10_000 }).chain(table), { maxLength: 2 }),
      deleting: fc.array(fc.nat({ max: 10_000 }).chain(table), { maxLength: 2 }),
      components: depth > 0 ? fc.array(fc.tuple(id, catalogOf(depth - 1)), { maxLength: 2 }) : fc.constant([]),
    })
    .map(({ active, hidden, deleting, components }) => {
      const c = new Catalog();
      for (const t of active) if (!c.tables.has(t.name)) c.tables.set(t.name, t);
      for (const t of hidden) c.hidden.set(t.id, t);
      for (const t of deleting) c.deleting.set(t.id, t);
      c.indexNumbers();
      for (const [k, v] of components) c.components.set(k, v);
      return c;
    });

describe("the catalog", () => {
  test("any catalog round-trips: its namespaces, tables and every index's state", () => {
    fc.assert(
      fc.property(catalogOf(1), (c) => {
        const back = decodeCatalog(encodeCatalog(c));
        expect(back).toEqual(c);
        // An id's number finds the same table after the trip.
        for (const t of c.tables.values()) expect(back.byNumber(t.number)?.name).toBe(c.byNumber(t.number)?.name);
      }),
      { numRuns: runs(200) },
    );
  });

  test("a table's by_id is the one among its enabled indexes; a staged false stays false, an absent one absent", () => {
    const c = new Catalog();
    const indexes: CatalogIndex[] = [
      { name: "by_id", fields: ["_id"], id: "i1" },
      { name: "by_n", fields: ["n"], id: "i2", state: "backfilled", staged: true },
      { name: "by_m", fields: ["m"], id: "i3", state: "backfilling" },
    ];
    c.add("items", "t1", 10001, indexes, "active", "meta");
    const t = c.tables.get("items")!;
    t.pending.push({ id: "i4", table: "items", name: "by_k", fields: ["k"], staged: false });
    const back = decodeCatalog(encodeCatalog(c)).tables.get("items")!;
    expect(back.byId).toBe(back.indexes.get("by_id")!);
    expect(back.pending.map((ix) => ix.staged)).toEqual([true, undefined, false]);
    expect("staged" in back.pending[1]!).toBe(false);
  });

  test("a message that does not parse is refused, naming where", () => {
    const c = new Catalog();
    c.add("items", "t1", 10001, [{ name: "by_id", fields: ["_id"], id: "i1" }]);
    const s = encodeCatalog(c);
    expect(() => decodeCatalog(`x${s.slice(1)}`)).toThrow('A malformed catalog: header: expected "k"');
    expect(() => decodeCatalog(s.slice(0, -2))).toThrow(
      "A malformed catalog: components: the message ends inside a field",
    );
    expect(() => decodeCatalog(`${s}0:`)).toThrow("A malformed catalog: end: 2 characters past the last field");
  });
});

describe("the text indexes' states", () => {
  const wanted = fc.uniqueArray(
    fc.record({
      table: name,
      name,
      searchField: name,
      filterFields: fc.uniqueArray(name, { maxLength: 3 }),
      staged: fc.boolean(),
      ready: fc.boolean(),
      pending: fc.boolean(),
    }),
    { selector: (w) => `${w.table}.${w.name}`, maxLength: 6 },
  );

  test("any set of indexes round-trips, active and pending, and answers lookups as the registry does", () => {
    fc.assert(
      fc.property(wanted, fc.boolean(), (ws, bootstrapping) => {
        const s = new SearchIndexes();
        const tableOf = (w: (typeof ws)[number]) =>
          ({ id: `tablet:${w.table}`, name: w.table, number: 1 }) as unknown as TableDef;
        const declared = (list: typeof ws) =>
          list.map((w) => ({
            table: tableOf(w),
            name: w.name,
            def: { searchField: w.searchField, filterFields: w.filterFields },
            staged: w.staged,
          }));
        for (const e of s.reconcile(declared(ws.filter((w) => !w.pending)), 1n, bootstrapping))
          if (ws.find((w) => w.table === e.table && w.name === e.name)?.ready) s.done(e);
        s.reconcilePending(declared(ws.filter((w) => w.pending)), 1n);
        const back = decodeSearchState(encodeSearchState(s));
        const strip = ({
          index: _i,
          log: _l,
          retainedFrom: _r,
          touched: _t,
          ...rest
        }: ReturnType<SearchIndexes["all"]>[number]) => rest;
        expect(back.all()).toEqual(s.all().map(strip));
        expect(back.pendingAll()).toEqual(s.pendingAll().map(strip));
        for (const w of ws) {
          const t = tableOf(w);
          const theirs = s.get(t, w.name);
          expect(back.get(t, w.name)).toEqual(theirs && strip(theirs));
          expect(back.forTablet(t.id).map((e) => e.name)).toEqual(s.forTablet(t.id).map((e) => e.name));
        }
      }),
      { numRuns: runs(200) },
    );
  });

  test("every change of an index's state is a new generation: what a worker's copy is checked by", () => {
    const s = new SearchIndexes();
    const t = { id: "tablet:a", name: "a", number: 1 } as unknown as TableDef;
    const def = { searchField: "body", filterFields: [] };
    const seen = [s.generation];
    const [e] = s.reconcile([{ table: t, name: "s", def, staged: false }], 1n, true);
    seen.push(s.generation);
    s.resumed(e!);
    seen.push(s.generation);
    s.done(e!);
    seen.push(s.generation);
    s.reconcile([{ table: t, name: "s", def, staged: true }], 1n);
    seen.push(s.generation);
    s.reconcilePending([{ table: t, name: "p", def, staged: false }], 1n);
    seen.push(s.generation);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("one epoch's metadata, and the window", () => {
  test("the metadata message carries its epoch, the catalog and the text indexes' states", () => {
    const c = new Catalog();
    c.add("items", "t1", 10001, [{ name: "by_id", fields: ["_id"], id: "i1" }]);
    const back = decodeMetadata(encodeMetadata(7, c, new SearchIndexes()));
    expect(back.epoch).toBe(7);
    expect(back.catalog).toEqual(c);
    expect(back.search.all()).toEqual([]);
  });

  test("an epoch the main thread counts as sent is one the worker still has, whatever the order they come in", () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 9 }), { maxLength: 60 }), (asked) => {
        const sent = new EpochWindow();
        const worker = new MetadataCopies();
        const catalog = new Catalog();
        const search = decodeSearchState(encodeSearchState(new SearchIndexes()));
        for (const epoch of asked) {
          if (!sent.has(epoch)) {
            sent.add(epoch);
            worker.hear({ epoch, catalog, search, schema: null });
          }
          expect(worker.get(epoch).epoch).toBe(epoch);
        }
      }),
      { numRuns: runs(300) },
    );
  });

  test(`a worker keeps the last ${METADATA_EPOCHS_KEPT} epochs, and refuses one it does not have`, () => {
    const worker = new MetadataCopies();
    const catalog = new Catalog();
    const search = decodeSearchState(encodeSearchState(new SearchIndexes()));
    for (let epoch = 1; epoch <= METADATA_EPOCHS_KEPT + 1; epoch++)
      worker.hear({ epoch, catalog, search, schema: null });
    expect(() => worker.get(1)).toThrow("metadata epoch 1 was not sent, or no longer kept");
    expect(worker.get(METADATA_EPOCHS_KEPT + 1).epoch).toBe(METADATA_EPOCHS_KEPT + 1);
  });
});

describe("the commits", () => {
  const key = fc.uint8Array({ maxLength: 3 });
  const indexes = ["a", "b", "c"];
  const commit = fc.array(fc.record({ index: fc.constantFrom(...indexes), key }), { maxLength: 4 });
  const interval: fc.Arbitrary<Interval> = fc
    .record({ index: fc.constantFrom(...indexes), x: key, y: key })
    .map(({ index, x, y }) => (compareKeys(x, y) <= 0 ? { index, lo: x, hi: y } : { index, lo: y, hi: x }));

  /** The answer from the whole log, by looking at every write. */
  const naive = (log: CommitKeys[], purgedTs: bigint, reads: Interval[], from: bigint, to: bigint) => {
    if (from >= to) return false;
    if (from < purgedTs) return true;
    return log.some(
      (e) =>
        e.ts > from &&
        e.ts <= to &&
        e.writes.some((w) =>
          reads.some((r) => r.index === w.index && compareKeys(r.lo, w.key) <= 0 && compareKeys(w.key, r.hi) < 0),
        ),
    );
  };

  test("a worker's copy of the write log answers changedBetween as the log it was posted", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(commit, fc.nat({ max: 3 })), { minLength: 1, maxLength: 20 }),
        fc.nat({ max: 5 }),
        fc.nat({ max: 25 }),
        fc.array(interval, { maxLength: 3 }),
        fc.nat({ max: 25 }),
        fc.nat({ max: 25 }),
        (commits, batch, purgeAt, reads, a, b) => {
          const start = 5n;
          const log: LogEntry[] = commits.map(([writes], i) => ({
            ts: start + BigInt(i + 1),
            writes: writes.map((w) => ({ ...w, id: null })),
          }));
          const copy = new WriteLogCopy(start);
          const purgedTs = start + BigInt(Math.min(purgeAt, log.length));
          // Posted in batches of `batch + 1`, the purge point with the last one.
          for (let i = 0; i < log.length; i += batch + 1) {
            const entries = log.slice(i, i + batch + 1);
            const last = i + batch + 1 >= log.length;
            copy.hear(
              encodeCommits({
                visibleTs: entries[entries.length - 1]!.ts,
                purgedTs: last ? purgedTs : start,
                entries,
              }),
            );
          }
          expect(copy.visibleTs).toBe(log[log.length - 1]!.ts);
          const from = start + BigInt(Math.min(a, b) % (log.length + 1));
          const to = start + BigInt(Math.max(a, b) % (log.length + 1));
          const [lo, hi] = from <= to ? [from, to] : [to, from];
          expect(copy.changedBetween(reads, lo, hi)).toBe(naive(log, purgedTs, reads, lo, hi));
        },
      ),
      { numRuns: runs(500) },
    );
  });

  test("a copy keeps only its window of the log: an older ts is not proven, a newer one is; the main thread's purge still counts", () => {
    const reads: Interval[] = [{ index: "b", lo: new Uint8Array([0]), hi: new Uint8Array([9]) }];
    const write = (ts: bigint) => ({ ts, writes: [{ index: "a", key: new Uint8Array([1]), id: null }] });
    const copy = new WriteLogCopy(0n, 10n);
    const entries = Array.from({ length: 30 }, (_, i) => write(BigInt(i + 1)));
    copy.hear(encodeCommits({ visibleTs: 30n, purgedTs: 0n, entries }));
    // Kept: the commits above 30 - 10. Index "b" was never written, so only the window decides.
    expect(copy.changedBetween(reads, 20n, 30n)).toBe(false);
    expect(copy.changedBetween(reads, 19n, 30n)).toBe(true);
    // The main thread's purge past the window wins.
    copy.hear(encodeCommits({ visibleTs: 31n, purgedTs: 25n, entries: [write(31n)] }));
    expect(copy.changedBetween(reads, 24n, 31n)).toBe(true);
    expect(copy.changedBetween(reads, 25n, 31n)).toBe(false);
    // By default the window is the write log's minimum retention, 30 s of nanosecond timestamps.
    const s = 1_000_000_000n;
    const byDefault = new WriteLogCopy(0n);
    byDefault.hear(encodeCommits({ visibleTs: 40n * s, purgedTs: 0n, entries: [write(40n * s)] }));
    expect(byDefault.changedBetween(reads, 10n * s, 40n * s)).toBe(false);
    expect(byDefault.changedBetween(reads, 10n * s - 1n, 40n * s)).toBe(true);
  });

  test("before the worker started nothing is proven; past what it heard is an error; a commit heard twice counts once", () => {
    const copy = new WriteLogCopy(10n);
    const reads: Interval[] = [{ index: "a", lo: new Uint8Array([0]), hi: new Uint8Array([9]) }];
    expect(copy.changedBetween(reads, 9n, 10n)).toBe(true);
    expect(() => copy.changedBetween(reads, 10n, 11n)).toThrow("changedBetween: 11 is past the visible ts 10");
    const one = {
      visibleTs: 11n,
      purgedTs: 10n,
      entries: [{ ts: 11n, writes: [{ index: "a", key: new Uint8Array([1]), id: null }] }],
    };
    copy.hear(encodeCommits(one));
    copy.hear(encodeCommits(one));
    expect(copy.changedBetween(reads, 10n, 11n)).toBe(true);
    // A commit that wrote nothing still moves the visible ts.
    copy.hear(encodeCommits({ visibleTs: 12n, purgedTs: 10n, entries: [] }));
    expect(copy.changedBetween(reads, 11n, 12n)).toBe(false);
  });

  test("the commits message round-trips, and refuses what it would not have written", () => {
    const m = {
      visibleTs: 2n ** 63n,
      purgedTs: 3n,
      entries: [{ ts: 4n, writes: [{ index: "i", key: new Uint8Array([0, 255, 7]), id: null }] }],
    };
    expect(decodeCommits(encodeCommits(m))).toEqual(m);
    expect(() => decodeCommits(encodeCommits(m).slice(0, -2))).toThrow(
      /A malformed commits: entries\[0\]\.writes\[0\]/,
    );
  });
});

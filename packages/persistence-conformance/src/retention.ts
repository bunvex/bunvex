// K27–K29 — what retention needs from a store (PERSIST-01 C12–C14, STUDY-33):
//   K27 the document log by timestamp (`readDocumentLog`), against a reference model;
//   K28 pruning: deleting what retention computes for a window from the document log's revision pairs
//       (`prevTs`, as Convex's retention) leaves every snapshot at or above it answering exactly as before,
//       removes exactly the superseded rows, and is idempotent;
//   K29 persistence globals (durable across a reopen), and the fence: a writer without the lease can
//       neither prune nor set a global.
import {
  type DocPrune,
  encodeKey,
  hasLease,
  hasRetention,
  type IndexPrune,
  type IndexWrite,
  LeaseLostError,
  type Persistence,
  type RetentionStore,
} from "@bunvex/core";
import { did, tid } from "./ids.ts";
import type { DriverModule } from "./index.ts";

type Check = (ok: boolean, what: string) => void;
type Store = Persistence & RetentionStore;

const rnd = (n: number) => Math.floor(Math.random() * n);
const MAX = (1n << 63n) - 1n;
const cmp = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
/** Deep equality by JSON, timestamps (`bigint`) as decimal strings. */
const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? String(v) : v));
const same = (a: unknown, b: unknown) => json(a) === json(b);
const TABLE = tid(970);
const BY_ID = tid(970);
const BY_VAL = tid(971);
const BACKFILL = tid(972);
// Document ids: valid internal ids (`did`), as a store in the reference layout keeps them as bytes.
const M0 = did("m0");
const B0 = did("b0");
const AFTER = did("after");
const FULL_LO = new Uint8Array(0);
const FULL_HI = Uint8Array.from([0xff, 0xff, 0xff, 0xff]);

type DocRow = { ts: bigint; id: string; deleted: boolean; prevTs: bigint | null };
type IdxRow = { ts: bigint; index: string; key: Uint8Array; deleted: boolean };

const kId = (id: string) => encodeKey([id]);
const kVal = (v: number, id: string) => encodeKey([v, id]);
/** The table's indexes and each one's key for a document `{v}` (BACKFILL is keyed as BY_ID). */
const keysOf = (id: string, v: number) => [
  { index: BY_ID, key: kId(id) },
  { index: BY_VAL, key: kVal(v, id) },
  { index: BACKFILL, key: kId(id) },
];

/**
 * The index rows retention deletes for document log rows at or below the window, as the engine derives them
 * (Convex's `expired_index_entries`): for each version that replaced one (`prevTs`), the replaced version's key
 * on every index of the table at or below `prevTs`, and at or below the new version's ts when the key changed
 * or the document was deleted (the tombstone the new version wrote). `valueAt` is a version's `v`, null when
 * there is no live version at exactly that ts.
 */
async function indexPrunes(
  rows: { ts: bigint; id: string; deleted: boolean; prevTs: bigint | null }[],
  valueAt: (id: string, ts: bigint) => number | null | Promise<number | null>,
): Promise<IndexPrune[]> {
  const out: IndexPrune[] = [];
  for (const r of rows) {
    if (r.prevTs === null) continue;
    const before = await valueAt(r.id, r.prevTs);
    if (before === null) continue;
    const after = r.deleted ? null : await valueAt(r.id, r.ts);
    const now = after === null ? null : keysOf(r.id, after);
    for (const [i, { index, key }] of keysOf(r.id, before).entries()) {
      out.push({ index, key, ts: r.prevTs });
      if (!now || hex(now[i].key) !== hex(key)) out.push({ index, key, ts: r.ts });
    }
  }
  return out;
}
/** The document versions retention deletes (Convex's `expired_documents`): the version each row replaced, and
 *  a delete's own tombstone. */
const docPrunes = (rows: { ts: bigint; table: string; id: string; deleted: boolean; prevTs: bigint | null }[]) =>
  rows.flatMap((r): DocPrune[] => [
    ...(r.prevTs === null ? [] : [{ table: r.table, id: r.id, ts: r.prevTs }]),
    ...(r.deleted ? [{ table: r.table, id: r.id, ts: r.ts }] : []),
  ]);
const canonPrunes = (p: IndexPrune[]) => p.map((e) => `${e.index}:${hex(e.key)}:${e.ts}`).sort();

/** Rows that must remain after pruning at `w`: everything above it, and each key's newest row at or below
 *  it when that row is live. */
function survivors<T extends { ts: bigint; deleted: boolean }>(rows: T[], keyOf: (r: T) => string, w: bigint) {
  const newest = new Map<string, T>();
  let n = 0;
  for (const r of rows) {
    if (r.ts > w) n++;
    else {
      const k = keyOf(r);
      const cur = newest.get(k);
      if (!cur || cur.ts < r.ts) newest.set(k, r);
    }
  }
  for (const r of newest.values()) if (!r.deleted) n++;
  return n;
}

export async function retentionChecks(mod: DriverModule, check: Check, log: (l: string) => void, required: boolean) {
  const opened = await mod.open(true);
  if (!hasRetention(opened)) {
    await opened.close();
    if (required) check(false, "K27–K29 the driver claims PERSIST-01 C12–C14 but has no retention methods");
    else log("skip K27–K29: the driver has no retention methods (PERSIST-01 C12–C14 are optional)");
    return;
  }
  let st: Store = opened;
  const lease = async (s: Persistence, holder: string, ttlMs = 60_000) => {
    if (hasLease(s)) await s.acquireLease({ holder, ttlMs });
  };
  await lease(st, "k26");

  // A workload over one table with three indexes: by id, by a value (keys move: a tombstone at the old
  // key), and one only ever written by a backfill (`writeIndexEntries` at a document version's own ts, C17).
  // Inserts, rewrites at the same key, moves, deletes, and tombstones of documents that never lived (created
  // and deleted in one transaction).
  const docRows: DocRow[] = [];
  const idxRows: IdxRow[] = [];
  const docCommits: { ts: bigint; rows: DocRow[] }[] = [];
  const live = new Map<string, number>();
  const ids = Array.from({ length: 40 }, (_, i) => did(`d${i}`));
  // Each live document's newest version's ts: the next version's `prevTs` (none after a delete: a new document).
  const lastTs = new Map<string, bigint>();
  // Each live version's `v`, by `id@ts`: the model's `valueAt`.
  const values = new Map<string, number>();
  const commitTs: bigint[] = [];
  const commit = (
    at: bigint,
    docs: { table: string; id: string; json: string | null; prevTs: bigint | null }[],
    idx: IndexWrite[],
  ) => {
    st.apply(at, docs, idx);
    commitTs.push(at);
    const drs = docs.map((d) => ({ ts: at, id: d.id, deleted: d.json === null, prevTs: d.prevTs }));
    for (const d of docs) {
      if (d.json === null) lastTs.delete(d.id);
      else {
        lastTs.set(d.id, at);
        values.set(`${d.id}@${at}`, JSON.parse(d.json).v);
      }
    }
    docRows.push(...drs);
    if (drs.length) docCommits.push({ ts: at, rows: drs });
    for (const e of idx) idxRows.push({ ts: at, index: e.index, key: e.key, deleted: e.id === null });
  };
  const backfilled = new Set<string>();
  const backfill = async (of: string[]) => {
    const entries = of
      .filter((id) => lastTs.has(id) && !backfilled.has(`${id}@${lastTs.get(id)}`))
      .map((id) => ({ index: BACKFILL, key: kId(id), table: TABLE, id, ts: lastTs.get(id)! }));
    if (!entries.length) return;
    await st.writeIndexEntries(entries);
    for (const e of entries) {
      backfilled.add(`${e.id}@${e.ts}`);
      idxRows.push({ ts: e.ts, index: BACKFILL, key: e.key, deleted: false });
    }
  };

  // Two fixed cases below the first window: m0 moves from v 1 to v 2 (its entry at 1000 and the tombstone at
  // its old key at 1001 go); b0's backfill entry at 1002 is superseded by its version at 1003 (it goes too).
  const put = (id: string, key: Uint8Array, index = BY_ID): IndexWrite => ({ index, key, table: TABLE, id });
  commit(
    1000n,
    [{ table: TABLE, id: M0, json: `{"v":1}`, prevTs: null }],
    [put(M0, kId(M0)), put(M0, kVal(1, M0), BY_VAL)],
  );
  commit(
    1001n,
    [{ table: TABLE, id: M0, json: `{"v":2}`, prevTs: 1000n }],
    [put(M0, kId(M0)), { index: BY_VAL, key: kVal(1, M0), table: null, id: null }, put(M0, kVal(2, M0), BY_VAL)],
  );
  commit(
    1002n,
    [{ table: TABLE, id: B0, json: `{"v":3}`, prevTs: null }],
    [put(B0, kId(B0)), put(B0, kVal(3, B0), BY_VAL)],
  );
  await st.flush();
  await backfill([B0]);
  commit(
    1003n,
    [{ table: TABLE, id: B0, json: `{"v":3,"c":1}`, prevTs: 1002n }],
    [put(B0, kId(B0)), put(B0, kVal(3, B0), BY_VAL)],
  );
  await st.flush();

  let ts = 5000n;
  for (let c = 0; c < 400; ) {
    const group = 1 + rnd(6);
    for (let g = 0; g < group && c < 400; g++, c++) {
      ts += BigInt(1 + (Math.random() < 0.3 ? 0 : rnd(3000)));
      const docs: { table: string; id: string; json: string | null; prevTs: bigint | null }[] = [];
      const idx: IndexWrite[] = [];
      const doc = (id: string, json: string | null) =>
        docs.push({ table: TABLE, id, json, prevTs: lastTs.get(id) ?? null });
      const entry = (index: string, key: Uint8Array, id: string | null) =>
        idx.push({ index, key, table: id === null ? null : TABLE, id });
      {
        const touched = new Set<string>();
        for (let w = 0; w < 1 + rnd(4); w++) {
          const id = ids[rnd(ids.length)];
          if (touched.has(id)) continue;
          touched.add(id);
          const cur = live.get(id);
          if (cur === undefined) {
            if (Math.random() < 0.1) {
              doc(id, null);
              entry(BY_ID, kId(id), null);
              continue;
            }
            const v = rnd(10);
            live.set(id, v);
            doc(id, `{"v":${v}}`);
            entry(BY_ID, kId(id), id);
            entry(BY_VAL, kVal(v, id), id);
          } else if (Math.random() < 0.25) {
            live.delete(id);
            doc(id, null);
            entry(BY_ID, kId(id), null);
            entry(BY_VAL, kVal(cur, id), null);
          } else {
            const v = Math.random() < 0.5 ? cur : rnd(10);
            live.set(id, v);
            doc(id, `{"v":${v},"c":${c}}`);
            entry(BY_ID, kId(id), id);
            if (v !== cur) entry(BY_VAL, kVal(cur, id), null);
            entry(BY_VAL, kVal(v, id), id);
          }
        }
      }
      if (!docs.length && !idx.length) continue;
      commit(ts, docs, idx);
    }
    await st.flush();
    // A backfill of some live documents at their newest version's ts (no scan reads BACKFILL: pruning only).
    if (Math.random() < 0.3) await backfill(ids.filter(() => Math.random() < 0.2));
  }
  const last = commitTs[commitTs.length - 1];

  // K27: the document log, whole and in random windows.
  const docLog = async (s: Store, a: bigint, b: bigint, n: number) =>
    (await s.readDocumentLog(a, b, n)).map((r) => ({
      ts: r.ts,
      id: r.id,
      deleted: r.deleted,
      t: r.table,
      prevTs: r.prevTs,
    }));
  const expectDocLog = (a: bigint, b: bigint, n: number) => {
    const out: { ts: bigint; id: string; deleted: boolean; t: string; prevTs: bigint | null }[] = [];
    if (n <= 0) return out;
    let k = 0;
    for (const c of docCommits) {
      if (c.ts <= a) continue;
      if (c.ts > b || k >= n) break;
      k++;
      for (const r of c.rows) out.push({ ts: r.ts, id: r.id, deleted: r.deleted, t: TABLE, prevTs: r.prevTs });
    }
    return out;
  };
  const canon = (rows: { ts: bigint; id: string; deleted: boolean; t: string; prevTs: bigint | null }[]) =>
    rows.map((r) => `${r.ts}:${r.t}:${r.id}:${r.deleted ? 1 : 0}:${r.prevTs ?? "-"}`).sort();
  {
    let bad = 0;
    const all = await docLog(st, 0n, MAX, 1_000_000);
    const ordered = all.every((r, i) => i === 0 || all[i - 1].ts <= r.ts);
    if (!ordered || !same(canon(all), canon(expectDocLog(0n, MAX, 1_000_000)))) bad++;
    const point = (): bigint => {
      const r = Math.random();
      if (r < 0.05) return 0n;
      if (r < 0.1) return last + 1n + BigInt(rnd(100));
      const c = commitTs[rnd(commitTs.length)];
      return r < 0.6 ? c : c - 1n - BigInt(rnd(3));
    };
    for (let i = 0; i < 200; i++) {
      const [a, b] = [point(), point()].sort(cmp);
      const n = [0, -1, 1, 2, 5, 40, 1000][rnd(7)];
      const got = await docLog(st, a, b, n);
      if (!same(canon(got), canon(expectDocLog(a, b, n)))) {
        if (bad++ < 3)
          log(`  K27 readDocumentLog(${a}, ${b}, ${n}): ${got.length} rows, want ${expectDocLog(a, b, n).length}`);
      }
    }
    check(
      bad === 0,
      `K27 readDocumentLog returns the document versions of whole commits in ts order, each with its prevTs (${all.length} rows; 200 random windows)`,
    );
  }

  // K28: prune at two successive windows, as retention does (the second continues from the first).
  const snapshotAnswers = async (s: Store, at: bigint[]) => {
    const out: unknown[] = [];
    for (const t of at) {
      for (const index of [BY_ID, BY_VAL])
        for (const [limit, desc] of [
          [100_000, false],
          [100_000, true],
          [3, false],
        ] as const)
          out.push(await s.scan(TABLE, index, FULL_LO, FULL_HI, t, limit, desc));
      for (const id of ids) out.push(await s.get(TABLE, id, t));
    }
    return out;
  };
  const rowCount = async (s: Store) => (s.auditRowCount ? await s.auditRowCount() : null);
  const pruneInChunks = async (s: Store, ip: IndexPrune[], dp: DocPrune[], through: bigint) => {
    let n = 0;
    for (let i = 0; i < ip.length; ) {
      const k = 1 + rnd(60);
      n += await s.pruneIndexes(ip.slice(i, i + k), through);
      i += k;
    }
    for (let i = 0; i < dp.length; ) {
      const k = 1 + rnd(60);
      n += await s.pruneDocuments(dp.slice(i, i + k), through);
      i += k;
    }
    return n;
  };
  const windows = [commitTs[Math.floor(commitTs.length * 0.4)], commitTs[Math.floor(commitTs.length * 0.75)] + 1n];
  let cursor = 0n;
  for (const w of windows) {
    const at = [
      w,
      w + 1n,
      ...Array.from({ length: 4 }, () => commitTs.filter((t) => t >= w)[rnd(10)] ?? last),
      last,
      MAX,
    ];
    const before = await snapshotAnswers(st, at);
    const rowsBefore = await rowCount(st);
    const docLogAbove = await docLog(st, w, MAX, 1_000_000);
    // The prunes as the engine computes them: the document log's revision pairs, each version read back with
    // `get` (only a live version at exactly that ts counts) and its keys re-derived.
    const dLog = await st.readDocumentLog(cursor, w, 1_000_000);
    const ip = await indexPrunes(dLog, async (id, t) => {
      const v = await st.get(TABLE, id, t);
      return v && v.ts === t ? JSON.parse(v.json).v : null;
    });
    const valueAt = (id: string, t: bigint) => values.get(`${id}@${t}`) ?? null;
    check(
      same(
        canonPrunes(ip),
        canonPrunes(
          await indexPrunes(
            docRows.filter((r) => r.ts > cursor && r.ts <= w),
            valueAt,
          ),
        ),
      ),
      `K28 the index prunes re-derived at ${w} from the document log (prevTs pairs, versions read with get) match the model (${ip.length} entries)`,
    );
    const deleted = await pruneInChunks(st, ip, docPrunes(dLog), w);
    const after = await snapshotAnswers(st, at);
    const rowsAfter = await rowCount(st);
    // Every index row the model's prunes (every window so far) cover is gone.
    const prunedTo = new Map<string, bigint>();
    for (const p of await indexPrunes(
      docRows.filter((r) => r.ts <= w),
      valueAt,
    )) {
      const k = `${p.index}:${hex(p.key)}`;
      if ((prunedTo.get(k) ?? -1n) < p.ts) prunedTo.set(k, p.ts);
    }
    const wantRows = {
      docs: survivors(docRows, (r) => r.id, w),
      idx: idxRows.filter((r) => r.ts > (prunedTo.get(`${r.index}:${hex(r.key)}`) ?? -1n)).length,
    };
    check(
      same(before, after),
      `K28 after pruning at ${w}, ${at.length} snapshots at or above it answer exactly as before (scans asc/desc/limited, gets)`,
    );
    if (rowsBefore && rowsAfter)
      check(
        same(rowsAfter, wantRows) && deleted === rowsBefore.docs + rowsBefore.idx - rowsAfter.docs - rowsAfter.idx,
        `K28 exactly the superseded rows are gone (${JSON.stringify(rowsBefore)} → ${JSON.stringify(rowsAfter)}, want ${JSON.stringify(wantRows)}; ${deleted} reported)`,
      );
    else log("  K28 row counts not checked: the driver has no auditRowCount");
    if (cursor === 0n) {
      // The fixed cases: nothing is left at m0's old key nor of b0's superseded backfill entry (a stale entry
      // joins no document version: the scan would throw or return it).
      const scanAt = async (index: string, t: bigint) => {
        try {
          return (await st.scan(TABLE, index, FULL_LO, FULL_HI, t, 100, false)).map((d) => `${d.id}@${d.ts}`);
        } catch (e) {
          return `threw ${(e as Error)?.name}`;
        }
      };
      const got = [await scanAt(BY_VAL, 1000n), await scanAt(BACKFILL, 1002n), await scanAt(BY_VAL, 1001n)];
      check(
        same(got, [[], [], [`${M0}@1001`]]),
        `K28 a key whose document moved keeps no entry at the replaced version's ts, and a backfill entry superseded by a later version is pruned (${json(got)})`,
      );
    }
    const again = await pruneInChunks(st, ip, docPrunes(dLog), w);
    check(
      again === 0 && same(await snapshotAnswers(st, at), before),
      `K28 pruning the same window again deletes nothing`,
    );
    check(same(await docLog(st, w, MAX, 1_000_000), docLogAbove), `K28 the document log above the window is untouched`);
    cursor = w;
  }

  // A write after pruning lands and reads back (the store is still a store).
  {
    const t = last + 10n;
    st.apply(
      t,
      [{ table: TABLE, id: AFTER, json: `{"v":1}`, prevTs: null }],
      [{ index: BY_ID, key: kId(AFTER), table: TABLE, id: AFTER }],
    );
    await st.flush();
    check(
      (await st.get(TABLE, AFTER, t))?.json === `{"v":1}` &&
        (await st.scan(TABLE, BY_ID, FULL_LO, FULL_HI, t, 100_000, false)).some((d) => d.id === AFTER),
      `K28 a commit after pruning reads back`,
    );
  }

  // K29: globals.
  const g0 = await st.getGlobal("k28_missing");
  await st.setGlobal("k29", { x: 1, s: "é", n: [1, 2] });
  const g1 = await st.getGlobal("k29");
  await st.setGlobal("k29", 42);
  const g2 = await st.getGlobal("k29");
  check(
    g0 === null && same(g1, { x: 1, s: "é", n: [1, 2] }) && g2 === 42,
    "K29 a global reads back as set; an unset one is null",
  );
  // An integer above 2^53 (`max_repeatable_ts`, nanoseconds) is stored as a plain JSON integer and reads back
  // exactly, as a bigint.
  const big = 1_791_309_835_128_171_123n;
  await st.setGlobal("k29_big", big);
  const g3 = await st.getGlobal("k29_big");
  check(g3 === big, `K29 an integer global above 2^53 reads back exactly (${String(g3)})`);
  if (hasLease(st)) await st.releaseLease();
  await st.close();
  st = (await mod.open(false)) as Store;
  await lease(st, "k29");
  check((await st.getGlobal("k29")) === 42, "K29 a global survives a reopen");

  // The fence: once the lease is released, pruning and setting a global are refused.
  if (hasLease(st)) {
    const refused = async (f: () => unknown) => {
      try {
        await f();
        return false;
      } catch (e) {
        return e instanceof LeaseLostError || (e as Error)?.name === "LeaseLostError";
      }
    };
    const untouched = async (s: Store) =>
      (await s.get(TABLE, AFTER, MAX))?.json === `{"v":1}` && (await s.getGlobal("k29")) === 42;
    await st.releaseLease();
    const r1 = await refused(() => st.pruneIndexes([{ index: BY_ID, key: kId(AFTER), ts: MAX }], MAX));
    const r2 = await refused(() => st.pruneDocuments([{ table: TABLE, id: AFTER, ts: MAX }], MAX));
    const r3 = await refused(() => st.setGlobal("k29", 7));
    await st.close();
    st = (await mod.open(false)) as Store;
    await lease(st, "k28-again");
    check(
      r1 && r2 && r3 && (await untouched(st)),
      "K29 without the lease, pruneIndexes, pruneDocuments and setGlobal throw LeaseLostError and change nothing",
    );
    // A TTL lease taken over by another holder: the old one is refused too.
    if ((st as { leaseScope?: string }).leaseScope !== "process") {
      await (st as unknown as { releaseLease: () => Promise<void> }).releaseLease();
      await lease(st, "k28-old", 500);
      const other = (await mod.open(false)) as Store;
      let got = false;
      for (let i = 0; i < 40 && !got; i++) {
        const r = await (other as unknown as { acquireLease: (o: object) => Promise<object> }).acquireLease({
          holder: "k28-new",
          ttlMs: 60_000,
        });
        got = "epoch" in r;
        if (!got) await Bun.sleep(100);
      }
      const r4 = await refused(() => st.pruneIndexes([{ index: BY_ID, key: kId(AFTER), ts: MAX }], MAX));
      const r5 = await refused(() => st.setGlobal("k29", 8));
      check(
        got && r4 && r5 && (await untouched(other)),
        "K29 a holder whose TTL lease was taken over cannot prune or set a global",
      );
      if (hasLease(other)) await other.releaseLease();
      await other.close();
    }
  }
  if (hasLease(st)) await st.releaseLease().catch(() => {});
  await st.close();
}

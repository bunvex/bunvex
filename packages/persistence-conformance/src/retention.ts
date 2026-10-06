// K27–K29 — what retention needs from a store (PERSIST-01 C12–C14, STUDY-33):
//   K27 the document log by timestamp (`readDocumentLog`), against a reference model;
//   K28 pruning: deleting what retention computes for a window leaves every snapshot at or above it
//       answering exactly as before, removes exactly the superseded rows, and is idempotent;
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
import { tid } from "./ids.ts";
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
const FULL_LO = new Uint8Array(0);
const FULL_HI = Uint8Array.from([0xff, 0xff, 0xff, 0xff]);

type DocRow = { ts: bigint; id: string; deleted: boolean; prevTs: bigint | null };
type IdxRow = { ts: bigint; index: string; key: Uint8Array; deleted: boolean };

/** What retention deletes for the rows of the log at or below the window: a live row supersedes the
 *  versions below it; a tombstone takes itself too. */
const indexPrunes = (rows: { ts: bigint; index: string; key: Uint8Array; deleted: boolean }[]): IndexPrune[] =>
  rows.map((r) => ({ index: r.index, key: r.key, ts: r.deleted ? r.ts : r.ts - 1n }));
const docPrunes = (rows: { ts: bigint; table: string; id: string; deleted: boolean }[]): DocPrune[] =>
  rows.map((r) => ({ table: r.table, id: r.id, ts: r.deleted ? r.ts : r.ts - 1n }));

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
  // key), and one written by index-only commits (a backfill). Inserts, rewrites at the same key, moves,
  // deletes, and tombstones of documents that never lived (created and deleted in one transaction).
  const docRows: DocRow[] = [];
  const idxRows: IdxRow[] = [];
  const docCommits: { ts: bigint; rows: DocRow[] }[] = [];
  const live = new Map<string, number>();
  const ids = Array.from({ length: 40 }, (_, i) => `d${i}`);
  const kId = (id: string) => encodeKey([id]);
  const kVal = (v: number, id: string) => encodeKey([v, id]);
  // Each document's newest version's ts: the next version's `prevTs`.
  const lastTs = new Map<string, bigint>();
  let ts = 5000n;
  const commitTs: bigint[] = [];
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
      if (Math.random() < 0.1) {
        // Index-only commits (log and pruning only: these entries have no document at their ts, so no check
        // scans this index).
        for (const id of ids.filter(() => Math.random() < 0.2)) entry(BACKFILL, kId(id), id);
      } else {
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
      st.apply(ts, docs, idx);
      commitTs.push(ts);
      const drs = docs.map((d) => ({ ts, id: d.id, deleted: d.json === null, prevTs: d.prevTs }));
      for (const d of docs) lastTs.set(d.id, ts);
      docRows.push(...drs);
      if (drs.length) docCommits.push({ ts, rows: drs });
      for (const e of idx) idxRows.push({ ts, index: e.index, key: e.key, deleted: e.id === null });
    }
    await st.flush();
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
    // Below the window the log holds what retention left, so the first commit's prevTs may change.
    const above = async (s: Store) =>
      (await s.readLog?.(w, MAX, 1_000_000))?.map((c, i) => ({
        ts: String(c.ts),
        prevTs: i === 0 ? "0" : String(c.prevTs),
        writes: c.writes,
      }));
    const logAbove = await above(st);
    const docLogAbove = await docLog(st, w, MAX, 1_000_000);
    const ixLog = (await st.readLog!(cursor, w, 1_000_000)).flatMap((c) =>
      c.writes.map((e) => ({ ts: c.ts, index: e.index, key: e.key, deleted: e.id === null })),
    );
    const dLog = await st.readDocumentLog(cursor, w, 1_000_000);
    const deleted = await pruneInChunks(st, indexPrunes(ixLog), docPrunes(dLog), w);
    const after = await snapshotAnswers(st, at);
    const rowsAfter = await rowCount(st);
    const wantRows = {
      docs: survivors(docRows, (r) => r.id, w),
      idx: survivors(idxRows, (r) => `${r.index}:${hex(r.key)}`, w),
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
    const again = await pruneInChunks(st, indexPrunes(ixLog), docPrunes(dLog), w);
    check(
      again === 0 && same(await snapshotAnswers(st, at), before),
      `K28 pruning the same window again deletes nothing`,
    );
    check(
      same(await above(st), logAbove) && same(await docLog(st, w, MAX, 1_000_000), docLogAbove),
      `K28 the logs above the window are untouched`,
    );
    cursor = w;
  }

  // A write after pruning lands and reads back (the store is still a store).
  {
    const t = last + 10n;
    st.apply(
      t,
      [{ table: TABLE, id: "after", json: `{"v":1}`, prevTs: null }],
      [{ index: BY_ID, key: kId("after"), table: TABLE, id: "after" }],
    );
    await st.flush();
    check(
      (await st.get(TABLE, "after", t))?.json === `{"v":1}` &&
        (await st.scan(TABLE, BY_ID, FULL_LO, FULL_HI, t, 100_000, false)).some((d) => d.id === "after"),
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
      (await s.get(TABLE, "after", MAX))?.json === `{"v":1}` && (await s.getGlobal("k29")) === 42;
    await st.releaseLease();
    const r1 = await refused(() => st.pruneIndexes([{ index: BY_ID, key: kId("after"), ts: MAX }], MAX));
    const r2 = await refused(() => st.pruneDocuments([{ table: TABLE, id: "after", ts: MAX }], MAX));
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
      const r4 = await refused(() => st.pruneIndexes([{ index: BY_ID, key: kId("after"), ts: MAX }], MAX));
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

// K34 — `prev_ts` (PERSIST-01 C12, DV-66): every document version keeps the ts of the version it replaced, as
// written, through a reopen; through the engine, the committer sets it to the replaced version's ts (Convex's
// `committer.rs`), so each document's versions in the log form a chain.
// K36 — index entries at past timestamps (PERSIST-01 C17, an index backfill's write, Convex's
// `write_index_backfill`): an entry written at an older document version's ts is seen by scans at or above that
// ts and joins that version; one at the same (index, key, ts) replaces it; none is in the log or moves `maxTs`;
// they survive a reopen; a writer without the lease is refused.
import { encodeKey, hasLease, hasRetention, type Persistence } from "@bunvex/core";
import { tid } from "./ids.ts";
import type { DriverModule } from "./index.ts";
import { insertItem, newEngine } from "./workload.ts";

type Check = (ok: boolean, what: string) => void;

const TABLE = tid(990);
const BY_ID = tid(990);
const LATE = tid(991);
const MAX = (1n << 63n) - 1n;
const FULL_LO = new Uint8Array(0);
const FULL_HI = Uint8Array.from([0xff, 0xff, 0xff, 0xff]);
const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? String(v) : v));

export async function prevTsChecks(mod: DriverModule, check: Check) {
  let st = (await mod.open(true)) as Persistence;
  if (!hasRetention(st)) {
    await st.close();
    return;
  }
  if (hasLease(st)) await st.acquireLease({ holder: "k34", ttlMs: 60_000 });
  const k = encodeKey(["x"]);
  st.apply(
    10n,
    [{ table: TABLE, id: "x", json: `{"v":1}`, prevTs: null }],
    [{ index: BY_ID, key: k, table: TABLE, id: "x" }],
  );
  st.apply(
    20n,
    [{ table: TABLE, id: "x", json: `{"v":2}`, prevTs: 10n }],
    [{ index: BY_ID, key: k, table: TABLE, id: "x" }],
  );
  st.apply(
    30n,
    [{ table: TABLE, id: "x", json: null, prevTs: 20n }],
    [{ index: BY_ID, key: k, table: null, id: null }],
  );
  await st.flush();
  if (hasLease(st)) await st.releaseLease();
  await st.close();
  st = (await mod.open(false)) as Persistence;
  const rows = hasRetention(st) ? await st.readDocumentLog(0n, MAX, 100) : [];
  await st.close();
  check(
    json(rows.map((r) => [r.ts, r.prevTs, r.deleted])) ===
      json([
        [10n, null, false],
        [20n, 10n, false],
        [30n, 20n, true],
      ]),
    `K34 readDocumentLog returns each version's prevTs as written, through a reopen (${json(rows.map((r) => r.prevTs))})`,
  );

  // Through the engine: insert, patch, patch, delete; each version's prevTs is the one before it.
  const e = await newEngine(await mod.open(true));
  const from = e.committer.visibleTs;
  const id = await e.mutation(insertItem("k34"));
  await e.mutation((db) => db.patch("items", id as never, { amount: 2 }));
  await e.mutation((db) => db.patch("items", id as never, { amount: 3 }));
  await e.mutation((db) => db.delete("items", id as never));
  const items = e.catalog.table("items");
  const log = hasRetention(e.persistence)
    ? (await e.persistence.readDocumentLog(from, e.committer.visibleTs, 1000)).filter((r) => r.table === items.id)
    : [];
  await e.close();
  const chain = log.length === 4 && log.every((r, i) => r.prevTs === (i === 0 ? null : log[i - 1]!.ts));
  check(
    chain,
    `K34 through the engine, each version's prevTs is the replaced version's ts (${json(log.map((r) => [r.ts, r.prevTs]))})`,
  );
}

export async function indexEntryChecks(mod: DriverModule, check: Check) {
  let st = (await mod.open(true)) as Persistence;
  const leased = hasLease(st);
  if (hasLease(st)) await st.acquireLease({ holder: "k36", ttlMs: 60_000 });
  const kid = (id: string) => encodeKey([id]);
  const late = (id: string) => encodeKey(["late", id]);
  // ts 100: a; ts 200: b; ts 300: a's second version. Only `by_id` is maintained by these commits.
  st.apply(
    100n,
    [{ table: TABLE, id: "a", json: `{"a":1}`, prevTs: null }],
    [{ index: BY_ID, key: kid("a"), table: TABLE, id: "a" }],
  );
  st.apply(
    200n,
    [{ table: TABLE, id: "b", json: `{"b":1}`, prevTs: null }],
    [{ index: BY_ID, key: kid("b"), table: TABLE, id: "b" }],
  );
  st.apply(
    300n,
    [{ table: TABLE, id: "a", json: `{"a":2}`, prevTs: 100n }],
    [{ index: BY_ID, key: kid("a"), table: TABLE, id: "a" }],
  );
  await st.flush();
  // The backfill of `LATE`: each document's entry at its version's own ts.
  await st.writeIndexEntries([
    { index: LATE, key: late("a"), table: TABLE, id: "a", ts: 300n },
    { index: LATE, key: late("b"), table: TABLE, id: "b", ts: 200n },
  ]);
  const view = async (s: Persistence, ts: bigint) =>
    (await s.scan(TABLE, LATE, FULL_LO, FULL_HI, ts, 100, false)).map((d) => `${d.id}@${d.ts}:${d.json}`);
  const at250 = await view(st, 250n);
  const at400 = await view(st, 400n);
  check(
    json(at250) === json(['b@200:{"b":1}']) && json(at400) === json(['a@300:{"a":2}', 'b@200:{"b":1}']),
    `K36 entries written at past timestamps are seen at and above their ts, each joined to its version (${json(at250)}, ${json(at400)})`,
  );
  // The same (index, key, ts) again replaces the entry: here with its removal.
  await st.writeIndexEntries([{ index: LATE, key: late("b"), table: null, id: null, ts: 200n }]);
  const replaced = await view(st, 400n);
  // They are not a commit: maxTs stays.
  const top = await st.maxTs?.();
  check(
    json(replaced) === json(['a@300:{"a":2}']) && (top === undefined || top === 300n),
    `K36 an entry at the same index, key and ts replaces it; the entries move no maxTs (${json(replaced)}, maxTs ${top})`,
  );
  if (leased && hasLease(st)) await st.releaseLease();
  await st.close();
  st = (await mod.open(false)) as Persistence;
  const reopened = await view(st, MAX);
  check(json(reopened) === json(['a@300:{"a":2}']), `K36 the entries survive a reopen (${json(reopened)})`);
  if (hasLease(st)) {
    // Another handle holds the lease: this one is refused, and nothing changes.
    await st.acquireLease({ holder: "k36-holder", ttlMs: 60_000 });
    const other = (await mod.open(false)) as Persistence;
    let refused = false;
    try {
      await other.writeIndexEntries([{ index: LATE, key: late("c"), table: TABLE, id: "a", ts: 100n }]);
    } catch (e) {
      refused = (e as Error)?.name === "LeaseLostError";
    }
    await other.close();
    const after = await view(st, MAX);
    await st.releaseLease();
    check(
      refused && json(after) === json(reopened),
      `K36 a writer without the lease is refused (LeaseLostError) and writes nothing (${refused}, ${json(after)})`,
    );
  }
  await st.close();
}

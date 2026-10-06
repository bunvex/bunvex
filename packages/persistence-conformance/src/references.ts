// K30, K31, K35 — index references, document identity and the exact-ts join (PERSIST-01 C15, C6). Modelled on
// Convex's persistence test suite (crates/common/src/testing/persistence_test_suite.rs: query_dangling_reference,
// query_reference_deleted_doc, same_internal_id_multiple_tables); written from scratch for bunvex's contract.
//   K30 an index entry whose document is not there at the entry's ts (never written, or a delete there) is not
//       hidden: `scan` rejects with `DanglingReferenceError` instead of returning fewer documents than the range
//       holds (Convex: "Dangling index reference", "Index reference to deleted document"); `get` is null for
//       such a document. A range without such an entry still reads normally.
//   K31 one id in two tables is two documents: `get` and `scan` each answer with their own table's document.
//   K35 the exact-ts join (DV-67 reversed): an entry joins the document version written at the entry's own ts,
//       never another one: one whose document has only an older version rejects, and one whose document was
//       replaced later without the entry being rewritten still reads the version of its own ts.
import { encodeKey, hasLease, type IndexedDoc, type Persistence } from "@bunvex/core";
import { tid } from "./ids.ts";
import type { DriverModule } from "./index.ts";

type Check = (ok: boolean, what: string) => void;

const TABLE = tid(980);
const INDEX = tid(980);
const TABLE_A = tid(981);
const TABLE_B = tid(982);
const INDEX_A = tid(981);
const INDEX_B = tid(982);
const TABLE_X = tid(983);
const INDEX_X = tid(983);
const FULL_LO = new Uint8Array(0);
const FULL_HI = Uint8Array.from([0xff, 0xff, 0xff, 0xff]);
const MAX = (1n << 63n) - 1n;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const key = (id: string) => encodeKey([id]);
/** [key(id), key(id) + 0x00): the singleton range of one entry. */
const only = (id: string) => [key(id), Uint8Array.from([...key(id), 0])] as const;
const jsons = (docs: IndexedDoc[]) => docs.map((d) => d.json);
const json = (d: { json: string } | null) => d?.json ?? null;

export async function referenceChecks(mod: DriverModule, check: Check) {
  const st = (await mod.open(true)) as Persistence;
  if (hasLease(st)) await st.acquireLease({ holder: "k30", ttlMs: 60_000 });
  try {
    await k30(st, check);
    await k31(st, check);
    await k35(st, check);
  } finally {
    if (hasLease(st)) await st.releaseLease().catch(() => {});
    await st.close();
  }
}

/** The rejection of `scan`, or what it returned instead. */
async function outcome(
  st: Persistence,
  table: string,
  index: string,
  lo: Uint8Array,
  hi: Uint8Array,
  ts: bigint,
  desc = false,
) {
  try {
    return { rejected: false, docs: await st.scan(table, index, lo, hi, ts, 100, desc) };
  } catch (e) {
    // By name: a third-party driver may carry its own copy of @bunvex/core.
    const dangling = e instanceof Error && e.name === "DanglingReferenceError";
    return {
      rejected: dangling,
      error: String(e),
      deleted: (e as { deleted?: unknown }).deleted,
      ts: (e as { ts?: unknown }).ts,
    };
  }
}

async function k30(st: Persistence, check: Check) {
  // ts 10: live documents a, c, e; an entry for `dangling` whose document was never written; `gone` live.
  // ts 20: `gone` is deleted, its index entry rewritten at 20 as if still live (the index no longer agrees
  // with the table).
  const doc = (id: string) => `{"id":"${id}"}`;
  st.apply(
    10n,
    ["a", "c", "e", "gone"].map((id) => ({ table: TABLE, id, json: doc(id), prevTs: null })),
    ["a", "c", "dangling", "e", "gone"].map((id) => ({ index: INDEX, key: key(id), table: TABLE, id })),
  );
  st.apply(
    20n,
    [{ table: TABLE, id: "gone", json: null, prevTs: 10n }],
    [{ index: INDEX, key: key("gone"), table: TABLE, id: "gone" }],
  );
  await st.flush();

  const gets = [
    await st.get(TABLE, "dangling", 20n),
    await st.get(TABLE, "gone", 20n),
    await st.get(TABLE, "gone", 10n),
  ];
  check(
    gets[0] === null && gets[1] === null && json(gets[2]) === doc("gone") && gets[2]?.ts === 10n,
    `K30 get is null for a document never written and for one deleted, and the deleted one still reads below its delete, with its ts (${JSON.stringify(gets.map(json))})`,
  );

  // [what, lo, hi, ts, desc, the `deleted` flag the error must carry (undefined: either, several entries)]
  const cases: [string, Uint8Array, Uint8Array, bigint, boolean, boolean | undefined][] = [
    ["the whole index", FULL_LO, FULL_HI, 20n, false, undefined],
    ["the whole index, descending", FULL_LO, FULL_HI, 20n, true, undefined],
    ["the dangling entry alone", ...only("dangling"), 20n, false, false],
    ["the entry of the deleted document alone", ...only("gone"), 20n, false, true],
    ["the whole index below the delete (the dangling entry only)", FULL_LO, FULL_HI, 10n, false, false],
  ];
  for (const [what, lo, hi, ts, desc, deleted] of cases) {
    const r = await outcome(st, TABLE, INDEX, lo, hi, ts, desc);
    check(
      r.rejected && (deleted === undefined || r.deleted === deleted),
      `K30 scan over ${what} rejects with DanglingReferenceError${deleted === undefined ? "" : ` (deleted: ${deleted})`} instead of dropping the reference (${r.docs ? `returned ${JSON.stringify(jsons(r.docs))}` : r.error})`,
    );
  }
  // Ranges without a broken reference still read: [a, c] at ts 20, and `gone` alone below its delete.
  const clean = await outcome(st, TABLE, INDEX, key("a"), Uint8Array.from([...key("c"), 0]), 20n);
  const before = await outcome(st, TABLE, INDEX, ...only("gone"), 10n);
  check(
    !clean.rejected &&
      same(jsons(clean.docs!), [doc("a"), doc("c")]) &&
      same(
        clean.docs!.map((d) => [d.id, String(d.ts)]),
        [
          ["a", "10"],
          ["c", "10"],
        ],
      ) &&
      !before.rejected &&
      same(jsons(before.docs!), [doc("gone")]),
    `K30 scan over ranges with no broken reference reads them, each entry with its document and ts (${JSON.stringify(clean.docs ? jsons(clean.docs) : clean.error)}, ${JSON.stringify(before.docs ? jsons(before.docs) : before.error)})`,
  );
}

async function k31(st: Persistence, check: Check) {
  // One id, two tables, two different documents, one commit; each table has its own index.
  const id = "shared";
  const jsonA = `{"t":"a"}`;
  const jsonB = `{"t":"b","more":[1,2,3]}`;
  st.apply(
    30n,
    [
      { table: TABLE_A, id, json: jsonA, prevTs: null },
      { table: TABLE_B, id, json: jsonB, prevTs: null },
    ],
    [
      { index: INDEX_A, key: key(id), table: TABLE_A, id },
      { index: INDEX_B, key: key(id), table: TABLE_B, id },
    ],
  );
  // Then the copy in table A is replaced (its entry rewritten) and the one in B deleted; each must stay apart.
  const jsonA2 = `{"t":"a","v":2}`;
  st.apply(
    40n,
    [
      { table: TABLE_A, id, json: jsonA2, prevTs: 30n },
      { table: TABLE_B, id, json: null, prevTs: 30n },
    ],
    [
      { index: INDEX_A, key: key(id), table: TABLE_A, id },
      { index: INDEX_B, key: key(id), table: null, id: null },
    ],
  );
  await st.flush();

  const gets = [
    await st.get(TABLE_A, id, 30n),
    await st.get(TABLE_B, id, 30n),
    await st.get(TABLE_A, id, 40n),
    await st.get(TABLE_B, id, 40n),
    await st.get(TABLE_A, id, MAX),
  ].map(json);
  check(
    same(gets, [jsonA, jsonB, jsonA2, null, jsonA2]),
    `K31 the same id in two tables: get answers each table's own document at every snapshot (${JSON.stringify(gets)})`,
  );
  const docs = [
    await st.scan(TABLE_A, INDEX_A, FULL_LO, FULL_HI, 30n, 10, false),
    await st.scan(TABLE_B, INDEX_B, FULL_LO, FULL_HI, 30n, 10, false),
    await st.scan(TABLE_A, INDEX_A, FULL_LO, FULL_HI, 40n, 10, false),
    await st.scan(TABLE_B, INDEX_B, FULL_LO, FULL_HI, 40n, 10, false),
  ].map(jsons);
  check(
    same(docs, [[jsonA], [jsonB], [jsonA2], []]),
    `K31 each table's index scan reads its own document (${JSON.stringify(docs)})`,
  );
}

async function k35(st: Persistence, check: Check) {
  // ts 50: documents `stale` and `kept`, only `kept` with an entry. ts 60: an entry for `stale`, whose only
  // version is at 50. ts 70: `kept` gets a new version without its entry being rewritten.
  st.apply(
    50n,
    [
      { table: TABLE_X, id: "stale", json: `{"v":50}`, prevTs: null },
      { table: TABLE_X, id: "kept", json: `{"v":50}`, prevTs: null },
    ],
    [{ index: INDEX_X, key: key("kept"), table: TABLE_X, id: "kept" }],
  );
  st.apply(60n, [], [{ index: INDEX_X, key: key("stale"), table: TABLE_X, id: "stale" }]);
  st.apply(70n, [{ table: TABLE_X, id: "kept", json: `{"v":70}`, prevTs: 50n }], []);
  await st.flush();
  const stale = await outcome(st, TABLE_X, INDEX_X, ...only("stale"), 80n);
  check(
    stale.rejected && stale.deleted === false && stale.ts === 60n,
    `K35 an entry at ts 60 whose document has only an older version (50) rejects as dangling at the entry's ts, instead of joining the older version (${stale.docs ? `returned ${JSON.stringify(jsons(stale.docs))}` : stale.error})`,
  );
  const kept = await outcome(st, TABLE_X, INDEX_X, ...only("kept"), 80n);
  check(
    !kept.rejected && same(jsons(kept.docs!), [`{"v":50}`]) && kept.docs![0]!.ts === 50n,
    `K35 an entry at ts 50 joins the version written at 50, not the document's newer version at 70 (${kept.docs ? JSON.stringify(jsons(kept.docs)) : kept.error})`,
  );
}

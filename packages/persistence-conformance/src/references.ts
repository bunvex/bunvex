// K30–K31 — index references and document identity (PERSIST-01 C15). Modelled on Convex's persistence test
// suite (crates/common/src/testing/persistence_test_suite.rs: query_dangling_reference,
// query_reference_deleted_doc, same_internal_id_multiple_tables); written from scratch for bunvex's contract.
//   K30 an index entry whose document does not exist at the snapshot (never written, or deleted while the
//       entry stayed) is not hidden: `scan` returns its id, `get` returns null, and `scanDocs` rejects
//       instead of returning fewer documents than the range holds (Convex: "Dangling index reference",
//       "Index reference to deleted document"). A range without such an entry still reads normally.
//   K31 one id in two tables is two documents: `get`, `scan` and `scanDocs` each answer with their own
//       table's document.
import { encodeKey, hasLease, type Persistence, type ScanDocs } from "@bunvex/core";
import type { DriverModule } from "./index.ts";

type Check = (ok: boolean, what: string) => void;

const TABLE = 980;
const INDEX = 980;
const TABLE_A = 981;
const TABLE_B = 982;
const INDEX_A = 981;
const INDEX_B = 982;
const FULL_LO = new Uint8Array(0);
const FULL_HI = Uint8Array.from([0xff, 0xff, 0xff, 0xff]);
const MAX = (1n << 63n) - 1n;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const key = (id: string) => encodeKey([id]);
/** [key(id), key(id) + 0x00): the singleton range of one entry. */
const only = (id: string) => [key(id), Uint8Array.from([...key(id), 0])] as const;

export async function referenceChecks(mod: DriverModule, check: Check) {
  const st = (await mod.open(true)) as Persistence & Partial<ScanDocs>;
  if (hasLease(st)) await st.acquireLease({ holder: "k30", ttlMs: 60_000 });
  try {
    await k30(st, check);
    await k31(st, check);
  } finally {
    if (hasLease(st)) await st.releaseLease().catch(() => {});
    await st.close();
  }
}

/** The rejection of `scanDocs`, or what it returned instead. */
async function outcome(st: Persistence & Partial<ScanDocs>, lo: Uint8Array, hi: Uint8Array, ts: bigint, desc = false) {
  try {
    return { rejected: false, docs: await st.scanDocs!(TABLE, INDEX, lo, hi, ts, 100, desc) };
  } catch (e) {
    // By name: a third-party driver may carry its own copy of @bunvex/core.
    const dangling = e instanceof Error && e.name === "DanglingReferenceError";
    return { rejected: dangling, error: String(e), deleted: (e as { deleted?: unknown }).deleted };
  }
}

async function k30(st: Persistence & Partial<ScanDocs>, check: Check) {
  // ts 10: live documents a, c, e; an entry for `dangling` whose document was never written; `gone` live.
  // ts 20: `gone` is deleted, its index entry left in place (the index no longer agrees with the table).
  const json = (id: string) => `{"id":"${id}"}`;
  st.apply(
    10n,
    ["a", "c", "e", "gone"].map((id) => ({ table: TABLE, id, json: json(id) })),
    ["a", "c", "dangling", "e", "gone"].map((id) => ({ index: INDEX, key: key(id), id })),
  );
  st.apply(20n, [{ table: TABLE, id: "gone", json: null }], []);
  await st.flush();

  const ids = ["a", "c", "dangling", "e", "gone"];
  const scanned = await st.scan(INDEX, FULL_LO, FULL_HI, 20n, 100, false);
  const scannedDesc = await st.scan(INDEX, FULL_LO, FULL_HI, 20n, 100, true);
  check(
    same(scanned, ids) && same(scannedDesc, [...ids].reverse()),
    `K30 scan returns index entries whatever their documents: one never written, one deleted (${JSON.stringify(scanned)})`,
  );
  const gets = [
    await st.get(TABLE, "dangling", 20n),
    await st.get(TABLE, "gone", 20n),
    await st.get(TABLE, "gone", 10n),
  ];
  check(
    gets[0] === null && gets[1] === null && gets[2] === json("gone"),
    `K30 get is null for a document never written and for one deleted, and the deleted one still reads below its delete (${JSON.stringify(gets)})`,
  );

  if (!st.scanDocs) return;
  // [what, lo, hi, ts, desc, the `deleted` flag the error must carry (undefined: either, several entries)]
  const cases: [string, Uint8Array, Uint8Array, bigint, boolean, boolean | undefined][] = [
    ["the whole index", FULL_LO, FULL_HI, 20n, false, undefined],
    ["the whole index, descending", FULL_LO, FULL_HI, 20n, true, undefined],
    ["the dangling entry alone", ...only("dangling"), 20n, false, false],
    ["the entry of the deleted document alone", ...only("gone"), 20n, false, true],
    ["the whole index below the delete (the dangling entry only)", FULL_LO, FULL_HI, 10n, false, false],
  ];
  for (const [what, lo, hi, ts, desc, deleted] of cases) {
    const r = await outcome(st, lo, hi, ts, desc);
    check(
      r.rejected && (deleted === undefined || r.deleted === deleted),
      `K30 scanDocs over ${what} rejects with DanglingReferenceError${deleted === undefined ? "" : ` (deleted: ${deleted})`} instead of dropping the reference (${r.docs ? `returned ${JSON.stringify(r.docs)}` : r.error})`,
    );
  }
  // Ranges without a broken reference still read: [a, c] at ts 20, and `gone` alone below its delete.
  const clean = await outcome(st, key("a"), Uint8Array.from([...key("c"), 0]), 20n);
  const before = await outcome(st, ...only("gone"), 10n);
  check(
    !clean.rejected &&
      same(clean.docs, [json("a"), json("c")]) &&
      !before.rejected &&
      same(before.docs, [json("gone")]),
    `K30 scanDocs over ranges with no broken reference reads them (${JSON.stringify(clean.docs ?? clean.error)}, ${JSON.stringify(before.docs ?? before.error)})`,
  );
}

async function k31(st: Persistence & Partial<ScanDocs>, check: Check) {
  // One id, two tables, two different documents, one commit; each table has its own index.
  const id = "shared";
  const jsonA = `{"t":"a"}`;
  const jsonB = `{"t":"b","more":[1,2,3]}`;
  st.apply(
    30n,
    [
      { table: TABLE_A, id, json: jsonA },
      { table: TABLE_B, id, json: jsonB },
    ],
    [
      { index: INDEX_A, key: key(id), id },
      { index: INDEX_B, key: key(id), id },
    ],
  );
  // Then the copy in table A is replaced and the one in B deleted; each must stay apart from the other.
  const jsonA2 = `{"t":"a","v":2}`;
  st.apply(
    40n,
    [
      { table: TABLE_A, id, json: jsonA2 },
      { table: TABLE_B, id, json: null },
    ],
    [{ index: INDEX_B, key: key(id), id: null }],
  );
  await st.flush();

  const gets = [
    await st.get(TABLE_A, id, 30n),
    await st.get(TABLE_B, id, 30n),
    await st.get(TABLE_A, id, 40n),
    await st.get(TABLE_B, id, 40n),
    await st.get(TABLE_A, id, MAX),
  ];
  check(
    same(gets, [jsonA, jsonB, jsonA2, null, jsonA2]),
    `K31 the same id in two tables: get answers each table's own document at every snapshot (${JSON.stringify(gets)})`,
  );
  const scans = [
    await st.scan(INDEX_A, FULL_LO, FULL_HI, 30n, 10, false),
    await st.scan(INDEX_B, FULL_LO, FULL_HI, 30n, 10, false),
    await st.scan(INDEX_B, FULL_LO, FULL_HI, 40n, 10, false),
  ];
  check(same(scans, [[id], [id], []]), `K31 each table's index scan sees its own entry (${JSON.stringify(scans)})`);
  if (!st.scanDocs) return;
  const docs = [
    await st.scanDocs(TABLE_A, INDEX_A, FULL_LO, FULL_HI, 30n, 10, false),
    await st.scanDocs(TABLE_B, INDEX_B, FULL_LO, FULL_HI, 30n, 10, false),
    await st.scanDocs(TABLE_A, INDEX_A, FULL_LO, FULL_HI, 40n, 10, false),
  ];
  check(
    same(docs, [[jsonA], [jsonB], [jsonA2]]),
    `K31 scanDocs reads each table's own document (${JSON.stringify(docs)})`,
  );
}

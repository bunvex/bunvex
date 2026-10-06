// K33 — nanosecond timestamps (PERSIST-01 C1, STUDY-133 §5.3): a commit ts is a 64-bit integer of nanoseconds,
// above 2^53, stored and read back exactly. Two commits one nanosecond apart (inside one microsecond, as a
// Linux-written Convex store has them) stay two distinct, ordered commits through a reopen: `maxTs`, `get`,
// `getVersions`, `scan`, `readLog` and `readDocumentLog` all see the exact values.
import { encodeKey, hasLease, hasRetention, type Persistence } from "@bunvex/core";
import { tid } from "./ids.ts";
import type { DriverModule } from "./index.ts";

type Check = (ok: boolean, what: string) => void;

const FULL_LO = new Uint8Array(0);
const FULL_HI = Uint8Array.from([0xff, 0xff, 0xff, 0xff]);
const TABLE = tid(995);
const INDEX = tid(996);
/** Real nanoseconds (2026-10-06), far above 2^53, with a sub-microsecond part. */
const T1 = 1_791_292_886_001_695_123n;
const T2 = T1 + 1n;

export async function nanosecondChecks(mod: DriverModule, check: Check) {
  const write = (await mod.open(true)) as Persistence;
  if (hasLease(write)) await write.acquireLease({ holder: "k33", ttlMs: 60_000 });
  write.apply(
    T1,
    [{ table: TABLE, id: "a", json: `{"v":1}`, prevTs: null }],
    [{ index: INDEX, key: encodeKey(["a"]), table: TABLE, id: "a" }],
  );
  write.apply(
    T2,
    [{ table: TABLE, id: "a", json: `{"v":2}`, prevTs: T1 }],
    [{ index: INDEX, key: encodeKey(["b"]), table: TABLE, id: "a" }],
  );
  await write.flush();
  if (hasLease(write)) await write.releaseLease();
  await write.close();

  const st = (await mod.open(false)) as Persistence;
  try {
    check((await st.maxTs?.()) === T2, `K33 maxTs is the last commit's exact ns (${T2})`);
    check(
      (await st.get(TABLE, "a", T1))?.json === `{"v":1}` &&
        (await st.get(TABLE, "a", T2))?.json === `{"v":2}` &&
        (await st.get(TABLE, "a", T2))?.ts === T2 &&
        (await st.get(TABLE, "a", T1 - 1n)) === null,
      "K33 get at T1, T1 + 1ns and T1 - 1ns sees three different states",
    );
    if (st.getVersions) {
      const [v1] = await st.getVersions(TABLE, ["a"], T1);
      const [v2] = await st.getVersions(TABLE, ["a"], T2);
      check(v1?.ts === T1 && v2?.ts === T2, "K33 getVersions returns each version's exact ns");
    }
    const at1 = await st.scan(TABLE, INDEX, FULL_LO, FULL_HI, T1, 10, false);
    const at2 = await st.scan(TABLE, INDEX, FULL_LO, FULL_HI, T2, 10, false);
    // The exact-ts join: entry `a` (written at T1) joins the version at T1, entry `b` the version at T2.
    check(
      at1.length === 1 &&
        at2.length === 2 &&
        at2[0]!.ts === T1 &&
        at2[0]!.json === `{"v":1}` &&
        at2[1]!.ts === T2 &&
        at2[1]!.json === `{"v":2}`,
      "K33 scan at T1 and T1 + 1ns sees one and two entries, each joined at its own exact ns",
    );
    if (st.readLog) {
      const log = await st.readLog(T1 - 1n, T2, 10);
      check(
        log.length === 2 && log[0]!.ts === T1 && log[1]!.ts === T2 && log[1]!.prevTs === T1,
        "K33 readLog returns both commits at their exact ns, the second's prevTs the first's",
      );
    }
    if (hasRetention(st)) {
      const docs = await st.readDocumentLog(T1 - 1n, T2, 10);
      check(
        docs.length === 2 && docs[0]!.ts === T1 && docs[1]!.ts === T2,
        "K33 readDocumentLog returns both versions at their exact ns",
      );
    }
  } finally {
    await st.close();
  }
}

// K32 — document versions (PERSIST-01 C16): `getVersions(table, ids, ts)` answers, for each id in order, the
// version visible at `ts` and the ts it was written at, or null when the document is missing or deleted
// there. A random history (inserts, rewrites, deletes, re-inserts, another table with the same ids) is
// checked against a reference model at random snapshots, with unknown and repeated ids, and against `get`.
import { hasLease, type Persistence } from "@bunvex/core";
import type { DriverModule } from "./index.ts";

type Check = (ok: boolean, what: string) => void;

const TABLE = 990;
const OTHER = 991;
const rnd = (n: number) => Math.floor(Math.random() * n);

/** JSON with timestamps (`bigint`) as decimal strings. */
const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? String(v) : v));

export async function versionChecks(mod: DriverModule, check: Check, log: (l: string) => void, required: boolean) {
  const st = (await mod.open(true)) as Persistence;
  if (typeof st.getVersions !== "function") {
    await st.close();
    if (required) check(false, "K32 the driver claims PERSIST-01 C16 but has no getVersions");
    else log("skip K32: the driver has no getVersions (PERSIST-01 C16 is optional)");
    return;
  }
  if (hasLease(st)) await st.acquireLease({ holder: "k32", ttlMs: 60_000 });
  try {
    // The reference: per (table, id), its versions in ts order (json null = deleted).
    const history = new Map<string, { ts: bigint; json: string | null }[]>();
    const ids = Array.from({ length: 30 }, (_, i) => `v${i}`);
    let ts = 9000n;
    const commits: bigint[] = [];
    for (let c = 0; c < 200; c++) {
      ts += BigInt(1 + rnd(50));
      const docs: { table: number; id: string; json: string | null }[] = [];
      const touched = new Set<string>();
      for (let w = 0; w < 1 + rnd(5); w++) {
        const table = Math.random() < 0.2 ? OTHER : TABLE;
        const id = ids[rnd(ids.length)]!;
        if (touched.has(`${table}:${id}`)) continue;
        touched.add(`${table}:${id}`);
        const vs = history.get(`${table}:${id}`) ?? [];
        const alive = vs.length > 0 && vs[vs.length - 1]!.json !== null;
        const json = alive && Math.random() < 0.3 ? null : `{"t":${table},"c":${c}}`;
        vs.push({ ts, json });
        history.set(`${table}:${id}`, vs);
        docs.push({ table, id, json });
      }
      st.apply(ts, docs, []);
      commits.push(ts);
      if (Math.random() < 0.3) await st.flush();
    }
    await st.flush();
    const want = (table: number, id: string, at: bigint) => {
      const vs = (history.get(`${table}:${id}`) ?? []).filter((v) => v.ts <= at);
      const v = vs[vs.length - 1];
      return v && v.json !== null ? { json: v.json, ts: v.ts } : null;
    };
    let mismatches = 0;
    let agreeWithGet = true;
    for (let r = 0; r < 120; r++) {
      const at = Math.random() < 0.2 ? commits[rnd(commits.length)]! : 8990n + BigInt(rnd(Number(ts - 8980n)));
      const table = Math.random() < 0.25 ? OTHER : TABLE;
      const asked = Array.from({ length: 1 + rnd(12) }, () =>
        Math.random() < 0.1 ? `unknown${rnd(3)}` : ids[rnd(ids.length)]!,
      );
      if (asked.length > 1 && Math.random() < 0.5) asked.push(asked[0]!); // a duplicate
      const got = await st.getVersions!(table, asked, at);
      const expected = asked.map((id) => want(table, id, at));
      if (json(got) !== json(expected)) {
        mismatches++;
        if (mismatches <= 3) log(`  K32 getVersions(${table}, ${asked.join(",")}, ${at}) → ${json(got)}`);
      }
      for (const [i, id] of asked.entries())
        if ((await st.get(table, id, at)) !== (got[i]?.json ?? null)) agreeWithGet = false;
    }
    check(
      mismatches === 0,
      "K32 getVersions answers each id's visible version and its ts, in order (120 random reads)",
    );
    check(agreeWithGet, "K32 getVersions agrees with get at every snapshot");
    // An empty request.
    check(JSON.stringify(await st.getVersions!(TABLE, [], ts)) === "[]", "K32 getVersions of no ids is empty");
  } finally {
    if (hasLease(st)) await st.releaseLease().catch(() => {});
    await st.close();
  }
}

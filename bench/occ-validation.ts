// The cost of validating one commit against the write log (STUDY-06 D11, DV-61), by log size.
//   bun bench/occ-validation.ts
// The log is filled with N commits of a typical insert (three index entries: by_id, a two-field index,
// by_creation_time; indexes 1–3), then one commit whose snapshot is older than all of them is validated
// against the whole log, in four shapes:
//   other-index   a point read on an index no commit in the log wrote (index 9)
//   by-id         a point read on by_id (index 1), which every commit wrote (miss)
//   range-10      ten ranges on the two-field index (index 2), none containing a written key (miss)
//   hit-oldest    a point read on the key the OLDEST commit wrote: a conflict found at the far end
//   recent-100    by-id, but at a snapshot only 100 commits old: what a mutation that ran while 100 others
//                 committed pays (the cost now follows the window's writes, not the log's size)
// Env: SIZES (comma list, default 1000,10000,50000,200000), REPS (max validations per shape, default 2000),
// COMMITTER (module exporting `Committer`, default @bunvex/core: point it at another build to compare).
import { encodeKey, type IndexWrite, type Interval, type Persistence } from "@bunvex/core";

const SIZES = (process.env.SIZES ?? "1000,10000,50000,200000").split(",").map(Number);
const REPS = Number(process.env.REPS ?? 2000);
const { Committer } = (await import(process.env.COMMITTER ?? "@bunvex/core")) as typeof import("@bunvex/core");
const nullPersistence = { apply() {}, async flush() {} } as unknown as Persistence;

function itemWrite(i: number) {
  const id = `doc${i.toString().padStart(9, "0")}`;
  const tenant = `t${i % 64}`;
  const createdAt = 1.79e12 + i;
  const idx: IndexWrite[] = [
    { index: 1, key: encodeKey([id]), id },
    { index: 2, key: encodeKey([tenant, createdAt, id]), id },
    { index: 3, key: encodeKey([createdAt, id]), id },
  ];
  return { docs: [], idx };
}

type Validate = { validate(p: { snapshot: number; reads: Interval[] }): unknown };

for (const n of SIZES) {
  // Retention far beyond the fill time and size: every commit stays in the log.
  const c = new Committer(nullPersistence, { minRetentionUs: 3.6e9, maxRetentionUs: 3.6e9, softMaxBytes: 2 ** 40 });
  const snapshot = c.visibleTs;
  const tss: number[] = [];
  for (let i = 0; i < n; i += 1000) {
    const batch: Promise<number>[] = [];
    for (let j = i; j < Math.min(n, i + 1000); j++)
      batch.push(c.commit({ snapshot: c.visibleTs, reads: [], ...itemWrite(j) }));
    tss.push(...(await Promise.all(batch)));
  }
  if (c.logLength !== n) throw new Error(`log holds ${c.logLength}, expected ${n}`);
  const point = (index: number, key: Uint8Array): Interval => ({ index, lo: key, hi: new Uint8Array([...key, 0]) });
  const shapes: Record<string, Interval[]> = {
    "other-index": [point(9, encodeKey(["x"]))],
    "by-id": [point(1, encodeKey(["nope"]))],
    "range-10": Array.from({ length: 10 }, (_, k) => ({
      index: 2,
      lo: encodeKey([`u${k}`]),
      hi: encodeKey([`u${k}`, 9e15]),
    })),
    "hit-oldest": [point(1, itemWrite(0).idx[0].key)],
  };
  const out: Record<string, number | string> = { bench: "occ-validation", log_entries: n };
  shapes["recent-100"] = shapes["by-id"];
  for (const [name, reads] of Object.entries(shapes)) {
    const v = c as unknown as Validate;
    const p = { snapshot: name === "recent-100" ? tss[n - 101] : snapshot, reads };
    const expectConflict = name === "hit-oldest";
    const r = v.validate(p);
    if ((r !== null) !== expectConflict) throw new Error(`${name}: unexpected result ${JSON.stringify(r)}`);
    // Up to REPS validations, stopping after ~300 ms (the linear validator takes milliseconds at 200k).
    let reps = 0;
    const t0 = performance.now();
    while (reps < REPS && (reps < 3 || performance.now() - t0 < 300)) {
      v.validate(p);
      reps++;
    }
    out[`${name}_us`] = Number((((performance.now() - t0) * 1000) / reps).toFixed(2));
  }
  console.log(JSON.stringify(out));
}

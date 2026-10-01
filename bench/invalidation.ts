// DV-64 micro-benchmark: the cost of matching one commit against N registered read-sets, before (today's
// linear scan: owners × writes × intervals) and after (ReadSetIndex). Each owner reads like a subscription to
// "the items of owner i": a prefix range on by_owner and a point on by_id. A commit patches one item: four
// index writes (old and new key in both indexes).
//   bun bench/invalidation.ts            Env: NS (comma list, default 1000,10000,100000), COMMITS (default 2000)
import { encodeKey, type Interval, type LogEntry, overlaps, prefixEnd, ReadSetIndex } from "@bunvex/core";

const NS = (process.env.NS ?? "1000,10000,100000").split(",").map(Number);
const COMMITS = Number(process.env.COMMITS ?? 2000);
const BY_ID = 1;
const BY_OWNER = 2;

const idKey = (i: number) => encodeKey([`id${i}`]);
const ownerKey = (o: number, i: number) => encodeKey([o, `id${i}`]);
const readsOf = (o: number): Interval[] => {
  const p = encodeKey([o]);
  return [
    { index: BY_OWNER, lo: p, hi: prefixEnd(p) },
    { index: BY_ID, lo: idKey(o), hi: prefixEnd(idKey(o)) },
  ];
};
const commitOn = (o: number, ts: number): LogEntry[] => [
  {
    ts,
    writes: [
      { index: BY_ID, key: idKey(o), id: `id${o}` },
      { index: BY_ID, key: idKey(o), id: `id${o}` },
      { index: BY_OWNER, key: ownerKey(o, o), id: null },
      { index: BY_OWNER, key: ownerKey(o, o), id: `id${o}` },
    ],
  },
];

const us = (ms: number, n: number) => Number(((ms * 1000) / n).toFixed(3));
for (const N of NS) {
  const owners = new Map<number, Interval[]>();
  for (let o = 0; o < N; o++) owners.set(o, readsOf(o));
  const commits = Array.from({ length: COMMITS }, (_, i) => commitOn(Math.floor(Math.random() * N), i + 1));

  // Before: every owner, every entry, every write × interval (what onCommit did).
  const linearCommits = Math.max(20, Math.min(COMMITS, Math.floor(2e7 / N / 8)));
  let hits = 0;
  let t = performance.now();
  for (let c = 0; c < linearCommits; c++)
    for (const [, reads] of owners)
      for (const e of commits[c])
        if (overlaps(e.writes, reads)) {
          hits++;
          break;
        }
  const linear = us(performance.now() - t, linearCommits);

  // After.
  const index = new ReadSetIndex<number>();
  t = performance.now();
  for (const [o, reads] of owners) index.set(o, reads);
  const build = performance.now() - t;
  let hits2 = 0;
  t = performance.now();
  for (const e of commits) hits2 += index.matchingEntries(e).size;
  const indexed = us(performance.now() - t, COMMITS);
  // A re-run replaces its owner's read-set: the maintenance cost per re-run.
  t = performance.now();
  for (let i = 0; i < COMMITS; i++) {
    const o = Math.floor(Math.random() * N);
    index.set(o, readsOf(o));
  }
  const replace = us(performance.now() - t, COMMITS);
  console.log(
    JSON.stringify({
      N,
      linearUsPerCommit: linear,
      indexedUsPerCommit: indexed,
      speedup: Math.round(linear / indexed),
      replaceUsPerOwner: replace,
      buildMs: Math.round(build),
      matchedPerCommit: [hits / linearCommits, hits2 / COMMITS],
    }),
  );
}

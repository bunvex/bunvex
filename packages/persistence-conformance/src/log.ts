// K25 — the by-ts log read (PERSIST-01 C11, STUDY-24 §4.3 / H11): `readLog(afterTs, upToTs, limit)` returns
// exactly the durable commits in (afterTs, min(upToTs, maxTs)], in ts order, whole, each with its index
// write set and the ts of the commit before it (`prevTs`), so a reader can detect a gap even though
// timestamps are sparse.
import { Engine, encodeKey, hasLease, type IndexWrite, type LogCommit, type Persistence } from "@bunvex/core";
import type { DriverModule } from "./index.ts";
import { insertItem, newEngine, schemaWithAmount } from "./workload.ts";

type Check = (ok: boolean, what: string) => void;
type ModelCommit = { ts: bigint; writes: IndexWrite[] };

const rnd = (n: number) => Math.floor(Math.random() * n);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const MAX = (1n << 63n) - 1n;
const cmp = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/** A commit's write set in a canonical order (C11 leaves the order inside a commit unspecified). */
const canon = (ws: IndexWrite[]) =>
  ws
    .map((w) => `${w.index}:${hex(w.key)}:${w.id ?? "-"}`)
    .sort()
    .join(",");

/** What `readLog(after, upTo, limit)` must return over `model` (every commit durable). */
function expected(model: ModelCommit[], after: bigint, upTo: bigint, limit: number) {
  const out: { ts: string; prevTs: string; writes: string }[] = [];
  if (limit <= 0) return out;
  let prev = 0n;
  for (const c of model) {
    if (c.ts <= after) {
      prev = c.ts;
      continue;
    }
    if (c.ts > upTo || out.length >= limit) break;
    out.push({ ts: String(c.ts), prevTs: String(prev), writes: canon(c.writes) });
    prev = c.ts;
  }
  return out;
}

const shape = (got: LogCommit[]) =>
  got.map((c) => ({ ts: String(c.ts), prevTs: String(c.prevTs), writes: canon(c.writes) }));
/** Deep equality by JSON, timestamps (`bigint`) as decimal strings. */
const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? String(v) : v));
const same = (a: unknown, b: unknown) => json(a) === json(b);

export async function logChecks(mod: DriverModule, check: Check, log: (l: string) => void, required: boolean) {
  let st: Persistence = await mod.open(true);
  if (typeof st.readLog !== "function") {
    await st.close();
    if (required) check(false, "K25 the driver claims PERSIST-01 C11 but has no readLog");
    else log(`skip K25: the driver has no readLog (PERSIST-01 C11 is optional for third-party drivers)`);
    return;
  }
  const read = (s: Persistence, after: bigint, upTo: bigint, limit: number) =>
    Promise.resolve(s.readLog!(after, upTo, limit));
  const lease = async (s: Persistence, holder: string) => {
    if (hasLease(s)) await s.acquireLease({ holder, ttlMs: 60_000 });
  };
  await lease(st, "k25");

  // An empty store has an empty log.
  const empty = await read(st, 0n, MAX, 100);

  // Random commits over two indexes: sparse timestamps, deletes (id null), index-only commits (no
  // documents: a backfill), keys longer than the 2500-byte prefix SQL stores split off, flushed in groups.
  const longBase = Buffer.alloc(2600, 7);
  const keyPool = Array.from({ length: 60 }, (_, i) =>
    i % 10 === 0
      ? encodeKey([longBase.toString("latin1") + String.fromCharCode(97 + (i % 26)), `k${i}`])
      : encodeKey([`k${i}`]),
  );
  const model: ModelCommit[] = [];
  let ts = 1000n;
  let indexOnly = 0;
  let deletes = 0;
  for (let c = 0; c < 300; ) {
    const group = 1 + rnd(8);
    for (let g = 0; g < group && c < 300; g++, c++) {
      ts += BigInt(1 + (Math.random() < 0.3 ? 0 : rnd(5000))); // sometimes ts + 1, mostly a gap
      const writes: IndexWrite[] = [];
      const used = new Set<string>();
      for (let w = 0; w < 1 + rnd(5); w++) {
        const index = 960 + rnd(2);
        const key = keyPool[rnd(keyPool.length)];
        const u = `${index}:${hex(key)}`;
        if (used.has(u)) continue;
        used.add(u);
        const del = Math.random() < 0.25;
        if (del) deletes++;
        writes.push({ index, key, id: del ? null : `doc${c}-${w}` }); // one document per write: no duplicate version
      }
      const docsToo = Math.random() < 0.7;
      if (!docsToo) indexOnly++;
      const docs = docsToo
        ? writes.map((w, i) => ({ table: 960, id: w.id ?? `gone${c}-${i}`, json: w.id ? `{"c":${c}}` : null }))
        : [];
      st.apply(ts, docs, writes);
      model.push({ ts, writes });
    }
    await st.flush();
  }
  const last = model[model.length - 1].ts;

  const all = await read(st, 0n, MAX, 1_000_000);
  check(
    empty.length === 0 && same(shape(all), expected(model, 0n, MAX, 1_000_000)),
    `K25 readLog returns every commit in ts order with its write set and prevTs chain (${all.length}/${model.length} commits, ${indexOnly} index-only, ${deletes} removed entries)`,
  );

  // Random windows: `after` on a commit, inside a gap, before the first or past the last; `upTo` likewise
  // (sometimes below `after`: an empty window); limits from 0 up.
  const point = (): bigint => {
    const r = Math.random();
    if (r < 0.05) return 0n;
    if (r < 0.1) return last + 1n + BigInt(rnd(1000));
    const c = model[rnd(model.length)].ts;
    return r < 0.6 ? c : c - 1n - BigInt(rnd(3));
  };
  let bad = 0;
  let emptyWindows = 0;
  for (let i = 0; i < 300; i++) {
    // Mostly after <= upTo; sometimes the other way round (empty by definition).
    const [a, b] = [point(), point()].sort(cmp);
    const r = Math.random();
    const [after, upTo] = r < 0.1 ? [a, MAX] : r < 0.25 ? [b, a] : [a, b];
    const limit = [0, -1, 1, 2, 3, 7, 50, 1000][rnd(8)];
    const want = expected(model, after, upTo, limit);
    if (!want.length) emptyWindows++;
    const got = shape(await read(st, after, upTo, limit));
    if (!same(got, want)) {
      if (bad++ < 3)
        log(
          `  K25 readLog(${after}, ${upTo}, ${limit}): got ${JSON.stringify(got).slice(0, 300)}, want ${JSON.stringify(want).slice(0, 300)}`,
        );
    }
  }
  check(
    bad === 0,
    `K25 300 random windows (after, upTo] with limits equal the reference model (${bad} mismatches, ${emptyWindows} empty)`,
  );

  // Catch-up in pages: each page starts where the last one ended, and its first prevTs names that end.
  {
    let after = 0n;
    const pages: LogCommit[] = [];
    let chain = true;
    // Bounded: a driver that ignores afterTs returns the same page forever.
    for (let i = 0; i <= model.length; i++) {
      const page = await read(st, after, MAX, 7);
      if (!page.length) break;
      if (page[0].prevTs !== after) chain = false;
      pages.push(...page);
      after = page[page.length - 1].ts;
    }
    check(
      chain && same(shape(pages), expected(model, 0n, MAX, 1_000_000)),
      "K25 paging by 7 from 0 rebuilds the whole log; each page's first prevTs is the previous page's last ts",
    );
  }

  // The durable prefix: commits applied but not flushed are never returned, whatever upTo says.
  {
    const pending: ModelCommit[] = [];
    let t = last;
    for (let i = 0; i < 3; i++) {
      t += 10n;
      const writes = [{ index: 960, key: encodeKey([`pending${i}`]), id: `p${i}` }];
      st.apply(t, [{ table: 960, id: `p${i}`, json: "{}" }], writes);
      pending.push({ ts: t, writes });
    }
    const before = await read(st, last, MAX, 100);
    const beforeAll = await read(st, 0n, MAX, 1_000_000);
    await st.flush();
    model.push(...pending);
    const after = await read(st, last, MAX, 100);
    const maxTs = (await st.maxTs?.()) ?? t;
    check(
      before.length === 0 &&
        beforeAll.length === model.length - 3 &&
        same(shape(after), expected(model, last, MAX, 100)) &&
        maxTs === t,
      `K25 nothing above the durable prefix: an applied, unflushed group is not returned (${before.length} before the flush, ${after.length} after)`,
    );
  }

  // A row above the durable prefix (the remains of a flush interrupted before its commit marker, or written
  // around the fence) is not part of the log. Only stores whose rows can be written behind the driver's back.
  if (mod.strayLogRow) {
    const durable = await st.maxTs!();
    await mod.strayLogRow(durable + 1000n);
    const above = await read(st, durable, MAX, 100);
    check(above.length === 0, `K25 a stray row above the durable prefix is not returned (${above.length} commits)`);
  }

  // The log survives a reopen (a memory store rebuilds its by-ts structure from its log). With the driver's
  // hooks, the store is first made one written before C11 (no ts index): it still reads the same log, and
  // has its ts index once the lease is held.
  if (hasLease(st)) await st.releaseLease();
  await st.close();
  if (mod.dropLogIndex) await mod.dropLogIndex();
  st = await mod.open(false);
  {
    const again = await read(st, 0n, MAX, 1_000_000);
    const tail = await read(st, model[100].ts - 1n, model[110].ts, 5);
    check(
      same(shape(again), expected(model, 0n, MAX, 1_000_000)) &&
        same(shape(tail), expected(model, model[100].ts - 1n, model[110].ts, 5)),
      `K25 after a reopen${mod.dropLogIndex ? " of a store without the ts index" : ""}, readLog returns the same log`,
    );
    if (mod.hasLogIndex) {
      await lease(st, "k25-upgrade");
      const built = await mod.hasLogIndex();
      const still = await read(st, 0n, MAX, 1_000_000);
      if (hasLease(st)) await st.releaseLease();
      check(
        built && same(shape(still), expected(model, 0n, MAX, 1_000_000)),
        "K25 a store written before C11 has its ts index once the lease is held",
      );
    }
  }
  await st.close();

  // Through the engine: every commit the committer made durable is in the log, with LogEntry.writes as its
  // write set — what a follower needs to invalidate its caches (STUDY-24 §4.3).
  {
    const e: Engine = await newEngine(await mod.open(true), {
      maxRetries: 1000,
      occInitialBackoffMs: 1,
      occMaxBackoffMs: 20,
    });
    const from = e.committer.visibleTs;
    const seen: ModelCommit[] = [];
    e.committer.onCommit((entries) => {
      for (const x of entries) seen.push({ ts: x.ts, writes: x.writes });
    });
    const ids = await Promise.all(Array.from({ length: 64 }, (_, i) => e.mutation(insertItem(`t${i % 4}`))));
    await Promise.all(
      ids.slice(0, 16).map((id, i) =>
        e.mutation(async (db) => {
          if (i % 2) await db.delete("items", id as never);
          else await db.patch("items", id as never, { status: "closed" });
        }),
      ),
    );
    const to = e.committer.visibleTs;
    const persistence = e.persistence;
    const got = await read(persistence, from, to, 1_000_000);
    await e.close();
    seen.sort((a, b) => cmp(a.ts, b.ts));
    const want = seen.map((c, i) => ({
      ts: String(c.ts),
      prevTs: String(i ? seen[i - 1].ts : from),
      writes: canon(c.writes),
    }));
    check(
      seen.length === 80 && same(shape(got), want),
      `K25 through the engine: the log between two snapshots is exactly the committer's commits and write sets (${got.length}/${seen.length})`,
    );
  }

  // A background index backfill (STUDY-29, K24) commits chunks that write index entries only: they are
  // commits like any other, so the log has them, and their entries cover every document.
  {
    let e: Engine = await newEngine(await mod.open(true));
    const ids = new Set<string>();
    for (let i = 0; i < 600; i += 200)
      await e.mutation(async (db) => {
        for (let j = 0; j < 200; j++) ids.add(String(await insertItem(`t${j % 4}`)(db)));
      });
    const from = e.committer.visibleTs;
    await e.close();
    e = await new Engine(schemaWithAmount, await mod.open(false), {
      indexBackfill: { chunkSize: 100, chunkRate: 1000, readSize: 100 },
    }).init();
    await e.indexesReady();
    const ix = e.catalog.table("items").indexes.get("by_amount")!.id;
    const got = await read(e.persistence, from, e.committer.visibleTs, 1_000_000);
    await e.close();
    const backfilled = new Set<string>();
    let chunks = 0;
    let chain = true;
    let prev = from;
    for (const c of got) {
      if (c.prevTs !== prev) chain = false;
      prev = c.ts;
      if (c.writes.length && c.writes.every((w) => w.index === ix)) chunks++;
      for (const w of c.writes) if (w.index === ix && w.id) backfilled.add(w.id);
    }
    check(
      chunks >= 6 && chain && backfilled.size === ids.size && [...ids].every((id) => backfilled.has(id)),
      `K25 a background index backfill's index-only chunks are in the log (${chunks} chunk commits, ${backfilled.size}/${ids.size} documents, prevTs chain ${chain ? "unbroken" : "broken"})`,
    );
  }
}

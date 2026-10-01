// K26 — bounded flushes (DV-62, STUDY-06 §10): the committer writes a group of commits as Convex's write batcher
// does, in batches of whole commits each closed at 64 document versions or 64 KiB, one fenced flush per batch, in
// ts order. On every driver, through the engine:
//   - a group over the caps is split, every flush obeys the batch rule (an injected limit fails any flush that
//     carries more than the rule allows, as a store's packet limit would), and a commit above the caps is
//     flushed whole and becomes visible at once;
//   - a split group whose flushes fail transiently (before reaching the store, or with the answer lost after
//     it) is retried batch by batch: every commit is acknowledged once and stored once;
//   - SIGKILL in the middle of a split group leaves a prefix of whole commits: maxTs ≥ the last acknowledged
//     commit, no torn commit, and every commit a flush carried at or below maxTs is in the store's log.
import { spawn } from "node:child_process";
import {
  commitWriteBytes,
  type DocWrite,
  type Engine,
  type IndexWrite,
  type Persistence,
  WRITE_BATCH_MAX_BYTES,
  WRITE_BATCH_MAX_DOCUMENTS,
} from "@bunvex/core";
import type { DriverModule } from "./index.ts";
import { insertPadded, newEngine } from "./workload.ts";

type Check = (ok: boolean, what: string) => void;

const FULL_LO = new Uint8Array(0);
const FULL_HI = Uint8Array.from([0xff, 0xff, 0xff, 0xff]);
const rnd = (n: number) => Math.floor(Math.random() * n);

/** The documents of K26's large commit. */
const HUGE = 1100;

class InjectedTransient extends Error {
  override name = "InjectedTransient";
}

type Flush = { commits: { ts: number; docs: number; bytes: number }[] };

/**
 * The driver's store, seen through a proxy that records what each flush carries and refuses one that breaks the
 * batch rule (everything before its last commit under both caps), as a store's packet limit refuses an oversized
 * write. `inject(n)` decides, for the n-th flush, whether to fail it transiently before it reaches the store
 * ("before") or after it was written ("after": the answer lost).
 */
function recording(inner: Persistence, inject: (n: number) => "before" | "after" | null = () => null) {
  const flushes: Flush[] = [];
  let cur: Flush = { commits: [] };
  let n = 0;
  let violations = 0;
  const store = new Proxy(inner, {
    get(t, k) {
      if (k === "apply")
        return (ts: number, docs: DocWrite[], idx: IndexWrite[]) => {
          cur.commits.push({ ts, docs: docs.length, bytes: commitWriteBytes(docs, idx) });
          return t.apply(ts, docs, idx);
        };
      if (k === "flush")
        return async () => {
          const f = cur;
          if (f.commits.length) {
            const head = f.commits.slice(0, -1);
            const docs = head.reduce((s, c) => s + c.docs, 0);
            const bytes = head.reduce((s, c) => s + c.bytes, 0);
            if (docs >= WRITE_BATCH_MAX_DOCUMENTS || bytes >= WRITE_BATCH_MAX_BYTES) {
              violations++;
              throw new Error(
                `injected limit: a flush of ${f.commits.length} commits carries ${docs} documents / ${bytes} bytes before its last commit`,
              );
            }
          }
          const fault = inject(++n);
          if (fault === "before") throw new InjectedTransient("connection reset (before the store)");
          await t.flush();
          if (f.commits.length) flushes.push(f);
          cur = { commits: [] };
          if (fault === "after") throw new InjectedTransient("answer lost (after the store)");
        };
      if (k === "isTransient") return (e: unknown) => e instanceof InjectedTransient || !!t.isTransient?.(e);
      const v = Reflect.get(t, k, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { store, flushes, violations: () => violations };
}

/** The `items` documents an engine's store holds at `ts`, by its tenant index. */
async function itemsAt(e: Engine, ts: number) {
  const items = e.catalog.table("items");
  const ix = [...items.indexes.values()][0].id;
  return (await e.persistence.scan(ix, FULL_LO, FULL_HI, ts, 10_000_000, false)).length;
}

export async function batchChecks(
  mod: DriverModule,
  driverModule: string,
  check: Check,
  log: (l: string) => void,
  kills: number,
  childTtlMs: number,
) {
  // 1. A split group and a commit above the caps, under the injected limit.
  {
    const r = recording(await mod.open(true));
    const e = await newEngine(r.store);
    const writers = 64;
    const each = 6;
    let failed = 0;
    const work = Array.from({ length: writers }, async (_, w) => {
      for (let n = 0; n < each; n++) await e.mutation(insertPadded(`t${w}`, 1, 2000, n)).catch(() => failed++);
    });
    // 1 100 documents of ~500 bytes in ONE mutation (~600 KiB, over both caps; more rows than one Postgres
    // statement takes, so the driver splits it into several statements of one transaction).
    const huge = e.mutation(insertPadded("huge", HUGE, 500)).catch(() => failed++);
    await Promise.all([...work, huge]);
    const hugeFlush = r.flushes.find((f) => f.commits.some((c) => c.docs === HUGE));
    const hugeTs = hugeFlush?.commits.find((c) => c.docs === HUGE)?.ts ?? 0;
    const visible = e.committer.visibleTs;
    const total = await itemsAt(e, visible);
    const atHuge = hugeTs ? (await itemsAt(e, hugeTs)) - (await itemsAt(e, hugeTs - 1)) : 0;
    const maxTs = Number((await e.persistence.maxTs?.()) ?? visible);
    const { batches, groups } = e.committer;
    check(
      failed === 0 &&
        r.violations() === 0 &&
        batches > groups &&
        total === writers * each + HUGE &&
        atHuge === HUGE &&
        maxTs === visible,
      `K26 a group over the write-batch caps (64 documents / 64 KiB) is flushed in batches of whole commits: ${groups} groups in ${batches} flushes, every flush within the batch rule (${r.violations()} over it), a ${HUGE}-document commit flushed whole and visible at once (${atHuge}), ${total} of ${writers * each + HUGE} documents stored, maxTs at the last commit (${failed} failed)`,
    );
    await e.close();
  }

  // 2. Transient failures of a split group's flushes, before the store and after it (the answer lost).
  {
    const r = recording(await mod.open(true), (n) => (n % 5 === 0 ? "before" : n % 7 === 0 ? "after" : null));
    const e = await newEngine(r.store, { flushRetry: { initialBackoffMs: 1, maxBackoffMs: 4, onRetry: () => {} } });
    const writers = 64;
    const each = 4;
    let failed = 0;
    await Promise.all(
      Array.from({ length: writers }, async (_, w) => {
        for (let n = 0; n < each; n++) await e.mutation(insertPadded(`t${w}`, 1, 2000, n)).catch(() => failed++);
      }),
    );
    const total = await itemsAt(e, e.committer.visibleTs);
    // Every commit flushed exactly once (none written twice by a retry), in increasing ts order.
    const flushed = r.flushes.flatMap((f) => f.commits.map((c) => c.ts));
    const once = new Set(flushed).size === flushed.length && flushed.every((t, i) => i === 0 || t > flushed[i - 1]);
    let dup = 0;
    if (e.persistence.auditRowsAt)
      for (const f of r.flushes.slice(-20))
        for (const c of f.commits) {
          const rows = await e.persistence.auditRowsAt(c.ts);
          if (rows.docs !== c.docs) dup++;
        }
    const { batches, groups, flushFailures, stopped } = e.committer;
    check(
      failed === 0 &&
        stopped === null &&
        flushFailures > 0 &&
        batches > groups &&
        total === writers * each &&
        once &&
        dup === 0,
      `K26 transient failures of a split group's flushes are retried batch by batch: ${flushFailures} failed attempts over ${batches} flushes of ${groups} groups, every commit acknowledged once and stored once (${total} of ${writers * each}; ${dup} commits with other row counts)${stopped ? `: ${stopped.message}` : ""}`,
    );
    await e.close();
  }

  // 3. SIGKILL in the middle of split groups: a prefix of whole commits survives.
  await mod.open(true).then((st) => st.close());
  const childPath = new URL("./batch-child.ts", import.meta.url).pathname;
  let bad = 0;
  let splitRuns = 0;
  let announcedTotal = 0;
  for (let k = 0; k < kills; k++) {
    const child = spawn(process.execPath, [childPath, driverModule], {
      env: { ...process.env, LEASE_TTL_MS: String(childTtlMs) },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let lastAck = 0;
    let started = false;
    let split = false;
    const announced: number[] = [];
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const l of lines) {
        if (l.startsWith("start")) started = true;
        if (l.startsWith("flush ")) for (const t of l.slice(6).split(",")) announced.push(Number(t));
        if (l.startsWith("ack ")) {
          const [ts, batches, groups] = l.slice(4).split(" ").map(Number);
          lastAck = Math.max(lastAck, ts);
          if (batches > groups) split = true;
        }
      }
    });
    while (!started) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 300 + rnd(700)));
    child.kill("SIGKILL");
    await new Promise((r) => child.on("exit", r));
    if (split) splitRuns++;
    announcedTotal += announced.length;

    const st = await mod.open(false);
    const e = await newEngine(st, { lease: { waitMs: 20 * childTtlMs } });
    const M = Number((await st.maxTs?.()) ?? 0);
    if (M < lastAck) {
      log(`  K26 kill ${k}: maxTs ${M} < last acknowledged ${lastAck}`);
      bad++;
    }
    // Whole commits at M: every index of `items` holds one live entry per live document.
    const items = e.catalog.table("items");
    const counts: number[] = [];
    for (const ix of items.indexes.values())
      counts.push((await st.scan(ix.id, FULL_LO, FULL_HI, M, 10_000_000, false)).length);
    const live = st.auditLiveDocs ? Number(await st.auditLiveDocs(items.id, M)) : counts[0];
    if (new Set([...counts, live]).size !== 1) {
      log(`  K26 kill ${k}: live docs ${live}, index entries ${JSON.stringify(counts)} (torn commit)`);
      bad++;
    }
    // A prefix: every commit a flush carried at or below M is in the store's log (no batch lost under a later
    // one that landed).
    if (st.readLog) {
      const below = announced.filter((t) => t <= M);
      if (below.length) {
        const from = Math.min(...below) - 1;
        const got = new Set((await st.readLog(from, M, 10_000_000)).map((c) => c.ts));
        const missing = below.filter((t) => !got.has(t));
        if (missing.length) {
          log(
            `  K26 kill ${k}: ${missing.length} flushed commits at or below maxTs ${M} missing (first ${missing[0]})`,
          );
          bad++;
        }
      }
    }
    await e.close();
  }
  check(
    bad === 0 && splitRuns > 0,
    `K26 ${kills} SIGKILLs in the middle of split groups (${splitRuns} runs split a group; ${announcedTotal} commits flushed): no acknowledged commit lost, no torn commit, the durable state a prefix of the flushed commits (${bad} violations)`,
  );
}

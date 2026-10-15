// The committer (committer.ts) on its own, over a scripted store: what the engine-level tests reach only in
// part. Search OCC and its conflict reports, the write log's sizes and retention, the begin window, the
// counters, traces and batch metrics, flush retries, the max_repeatable_ts bumps and the waiters. Mutation
// testing (TEST-01 §7) found these untested.
import { afterEach, describe, expect, test } from "bun:test";
import {
  CommitListenerError,
  Committer,
  CommitterStoppedError,
  ConflictError,
  commitWriteBytes,
  type Interval,
  type LogEntry,
  logEntryBytes,
  MAX_REPEATABLE_TS_GLOBAL,
  OutOfRetentionError,
  type SearchDoc,
  type SearchRead,
  searchOverlaps,
  WRITE_LOG_HARD_MAX_BYTES,
  WRITE_LOG_MAX_RETENTION_NS,
  WRITE_LOG_MIN_RETENTION_NS,
} from "../src/committer.ts";
import type { DocWrite, IndexWrite, Persistence } from "../src/persistence/index.ts";
import type { CommitSpans } from "../src/tracing.ts";

const DOC: DocWrite = { table: "t", id: "d1", json: "{}", prevTs: null };
const IDX: IndexWrite & { docId?: string } = { index: "i", key: Uint8Array.of(1), table: "t", id: "d1" };
const ALL: Interval = { index: "i", lo: Uint8Array.of(0), hi: Uint8Array.of(9) };

/** A store whose flushes can be held at a gate, or fail (transiently or not) a number of times. */
function fakeStore() {
  const s = {
    flushes: 0,
    gate: null as Promise<void> | null,
    failFlushes: 0,
    failApply: false,
    transient: false,
    persistence: null as unknown as Persistence,
  };
  s.persistence = {
    apply() {
      if (s.failApply) throw new Error("apply failed");
    },
    async flush() {
      s.flushes++;
      const gate = s.gate;
      if (gate) await gate;
      await new Promise((r) => setImmediate(r));
      if (s.failFlushes > 0) {
        s.failFlushes--;
        throw new Error("flaky");
      }
    },
    isTransient: () => s.transient,
  } as unknown as Persistence;
  return s;
}

type Put = Partial<Parameters<Committer["commit"]>[0]>;
const put = (c: Committer, o: Put = {}) =>
  c.commit({ snapshot: c.visibleTs, reads: [], docs: [DOC], idx: [IDX], ...o });

/** A trace that records what the committer sets on it. */
function fakeTrace() {
  return {
    validateStart: 0,
    validateEnd: 0,
    writeStart: 0,
    writeEnd: 0,
    batchCommits: 0,
    batchDocuments: 0,
    settled: null as [bigint | null, unknown] | null,
    settle(ts: bigint | null, e?: unknown) {
      this.settled = [ts, e];
    },
  };
}
const asSpans = (t: ReturnType<typeof fakeTrace>) => t as unknown as CommitSpans;

const tick = () => new Promise((r) => setImmediate(r));
// The test's own waits keep the real timer, so that `recordTimeouts` sees only the committer's.
const realSetTimeout = setTimeout;
const sleep = (ms: number) => new Promise((r) => realSetTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000) {
  const end = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > end) throw new Error("timed out waiting");
    await sleep(1);
  }
}

const restore: (() => void)[] = [];
afterEach(() => {
  for (const r of restore.splice(0)) r();
});
function stubRandom(x: number) {
  const real = Math.random;
  Math.random = () => x;
  restore.push(() => {
    Math.random = real;
  });
}
/** The delays passed to `setTimeout` from now on (the timers still run). */
function recordTimeouts() {
  const asked: number[] = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    asked.push(ms ?? 0);
    return real(fn, ms, ...rest);
  }) as typeof setTimeout;
  restore.push(() => {
    globalThis.setTimeout = real;
  });
  return asked;
}
function captureErrors() {
  const errs: string[] = [];
  const real = console.error;
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  restore.push(() => {
    console.error = real;
  });
  return errs;
}

describe("pure parts", () => {
  test("searchOverlaps: the same index, every filter, and one term (the last maybe a prefix)", () => {
    const doc: SearchDoc = { index: "s", id: "d", tokens: new Set(["apple", "banana"]), filters: { f: "k" } };
    const read = (terms: SearchRead["terms"], filters: [string, string][] = []): SearchRead => ({
      index: "s",
      terms,
      filters,
    });
    expect(searchOverlaps({ ...read([]), index: "other" }, doc)).toBe(false);
    expect(searchOverlaps(read([], [["f", "x"]]), doc)).toBe(false);
    expect(searchOverlaps(read([], [["f", "k"]]), doc)).toBe(true);
    expect(searchOverlaps(read([{ term: "app", prefix: true }]), doc)).toBe(true);
    expect(searchOverlaps(read([{ term: "ple", prefix: true }]), doc)).toBe(false);
    expect(searchOverlaps(read([{ term: "app", prefix: false }]), doc)).toBe(false);
    expect(searchOverlaps(read([{ term: "apple", prefix: false }]), doc)).toBe(true);
    expect(
      searchOverlaps(
        read([
          { term: "cherry", prefix: false },
          { term: "ban", prefix: true },
        ]),
        doc,
      ),
    ).toBe(true);
    expect(searchOverlaps(read([{ term: "cherry", prefix: false }]), doc)).toBe(false);
  });

  test("logEntryBytes: the entry, its source, each write's key and id, each search version's id and tokens", () => {
    expect(logEntryBytes({ ts: 1n, writes: [] })).toBe(96);
    expect(logEntryBytes({ ts: 1n, writes: [], source: "ab" })).toBe(98);
    expect(
      logEntryBytes({
        ts: 1n,
        writes: [
          { index: "i", key: new Uint8Array(3), id: "xy" },
          { index: "i", key: new Uint8Array(5), id: null },
        ],
      }),
    ).toBe(96 + (104 + 3 + 2) + (104 + 5));
    expect(
      logEntryBytes({
        ts: 1n,
        writes: [],
        searchDocs: [{ index: "s", id: "d1", tokens: new Set(["ab", "c"]), filters: {} }],
      }),
    ).toBe(96 + (104 + 2) + (32 + 2) + (32 + 1));
  });

  test("commitWriteBytes: per version its id and JSON, per index entry its key and id, 12 bytes each", () => {
    expect(
      commitWriteBytes(
        [
          { table: "t", id: "abc", json: "{}", prevTs: null },
          { table: "t", id: "de", json: null, prevTs: 1n },
        ],
        [
          { index: "i", key: new Uint8Array(4), table: "t", id: "q" },
          { index: "i", key: new Uint8Array(2), table: null, id: null },
        ],
      ),
    ).toBe(12 + 3 + 2 + (12 + 2) + (12 + 4 + 1) + (12 + 2));
  });

  test("the errors' messages and names; the global's name", () => {
    const o = new OutOfRetentionError(5n, 9n);
    expect(o.message).toBe("Timestamp 5 is outside of write log retention window (minimum timestamp 9)");
    expect(o.name).toBe("OutOfRetentionError");
    const c = new ConflictError();
    expect(c.message).toBe("write conflict");
    expect(c.conflict).toEqual({ writeTs: 0n });
    expect(new CommitListenerError("x", new Error("boom")).name).toBe("CommitListenerError");
    expect(new CommitterStoppedError(new Error("io"), "ctx").message).toBe(
      "the committer stopped after a persistence failure: ctx: io",
    );
    expect(new CommitterStoppedError("io").message).toBe("the committer stopped after a persistence failure: io");
    expect(MAX_REPEATABLE_TS_GLOBAL).toBe("max_repeatable_ts");
  });

  test("the retention policy: defaults for what is not given; a disabled hard cap is Infinity", () => {
    const p = fakeStore().persistence;
    expect(
      new Committer(p, { minRetentionNs: undefined, softMaxBytes: 7, hardMaxBytes: null }).retentionPolicy,
    ).toEqual({
      minRetentionNs: WRITE_LOG_MIN_RETENTION_NS,
      maxRetentionNs: WRITE_LOG_MAX_RETENTION_NS,
      softMaxBytes: 7,
      hardMaxBytes: Number.POSITIVE_INFINITY,
    });
    expect(new Committer(p, { hardMaxBytes: 0 }).retentionPolicy.hardMaxBytes).toBe(Number.POSITIVE_INFINITY);
    expect(new Committer(p, { hardMaxBytes: 123 }).retentionPolicy.hardMaxBytes).toBe(123);
    expect(new Committer(p).retentionPolicy.hardMaxBytes).toBe(WRITE_LOG_HARD_MAX_BYTES);
  });

  test("a committer prints by name only", () => {
    expect(Bun.inspect(new Committer(fakeStore().persistence))).toBe("Committer {…}");
  });
});

describe("commits", () => {
  test("counters, the log's entries (writes, source, search versions) and its size", async () => {
    const s = fakeStore();
    const c = new Committer(s.persistence, {}, () => 0n);
    const seen: LogEntry[] = [];
    c.onCommit((es) => seen.push(...es));
    await put(c, { source: "m:a" });
    await put(c, { logWrites: false });
    await put(c, { searchDocs: [] });
    expect(seen.map((e) => e.writes.length)).toEqual([1, 0, 1]);
    expect(seen[0]!.source).toBe("m:a");
    expect("source" in seen[1]!).toBe(false);
    expect("searchDocs" in seen[2]!).toBe(false);
    expect(c.logBytes).toBe(seen.reduce((n, e) => n + logEntryBytes(e), 0));
    expect(c.commits).toBe(3);
    // A refused commit counts as a conflict; a group with nothing accepted is not a group.
    await c.idle(); // a group is counted once all of it is written
    const groups = c.groups;
    await expect(put(c, { snapshot: 0n, reads: [ALL] })).rejects.toBeInstanceOf(ConflictError);
    await c.idle();
    expect([c.conflicts, c.groups, c.commits]).toEqual([1, groups, 3]);
  });

  test("a snapshot from before the log's start is refused as out of retention, and counted", async () => {
    const c = new Committer(fakeStore().persistence, {}, () => 0n);
    c.resume(10n);
    await expect(put(c, { snapshot: 5n })).rejects.toBeInstanceOf(OutOfRetentionError);
    expect([c.outOfRetention, c.conflicts]).toEqual([1, 0]);
  });

  test("within a group, a snapshot that already includes an earlier commit of the group does not conflict with it", async () => {
    const c = new Committer(fakeStore().persistence, {}, () => 0n);
    const a = put(c);
    const a2 = put(c, { idx: [{ ...IDX, index: "j" }] });
    const b = put(c, { snapshot: 1n, reads: [ALL] });
    const d = put(c, { snapshot: 0n, reads: [ALL] }).catch((e) => e);
    expect(await a).toBe(1n);
    expect(await a2).toBe(2n);
    expect(await b).toBe(3n);
    expect(await d).toBeInstanceOf(ConflictError);
  });

  test("search OCC: a version written after the snapshot conflicts, reported with its source when it has one", async () => {
    const c = new Committer(fakeStore().persistence, {}, () => 0n);
    const sd = (id: string): SearchDoc => ({ index: "s", id, tokens: new Set(["apple"]), filters: {} });
    await put(c, { searchDocs: [sd("x")], source: "m:w" }); // ts 1
    await put(c); // ts 2: no search versions
    await put(c, { searchDocs: [sd("y")] }); // ts 3: no source
    const searchReads: SearchRead[] = [{ index: "s", terms: [{ term: "apple", prefix: false }], filters: [] }];
    const at1 = (await put(c, { snapshot: 1n, searchReads }).catch((e) => e)) as ConflictError;
    expect(at1.conflict).toEqual({ writeTs: 3n, id: "y" });
    expect("source" in at1.conflict).toBe(false);
    const at0 = (await put(c, { snapshot: 0n, searchReads }).catch((e) => e)) as ConflictError;
    expect(at0.conflict).toEqual({ writeTs: 1n, id: "x", source: "m:w" });
    // A commit that read no search is not checked against the search versions.
    expect(await put(c, { snapshot: 0n })).toBe(4n);
  });

  test("a group waits for the one being flushed: one drain at a time, published in ts order", async () => {
    const s = fakeStore();
    const c = new Committer(s.persistence, {}, () => 0n);
    let release!: () => void;
    s.gate = new Promise((r) => {
      release = r;
    });
    const order: bigint[] = [];
    const a = put(c).then((ts) => order.push(ts));
    await until(() => s.flushes === 1);
    s.gate = null;
    const b = put(c).then((ts) => order.push(ts));
    const d = put(c).then((ts) => order.push(ts));
    await sleep(5);
    expect(order).toEqual([]);
    release();
    await Promise.all([a, b, d]);
    expect(order).toEqual([1n, 2n, 3n]);
    expect([c.groups, c.visibleTs]).toEqual([2, 3n]);
  });

  test("a batch closes at exactly maxBytes; onBatch hears each batch's commits and its flush time in seconds", async () => {
    const bytes = commitWriteBytes([DOC], [IDX]);
    const c = new Committer(fakeStore().persistence, {}, () => 0n, {}, { maxBytes: bytes, maxDocuments: 100 });
    const heard: [number, number][] = [];
    c.onBatch = (n, seconds) => heard.push([n, seconds]);
    await Promise.all([put(c), put(c), put(c)]);
    expect(heard.map((h) => h[0])).toEqual([1, 1, 1]);
    for (const [, seconds] of heard) {
      expect(seconds).toBeGreaterThanOrEqual(0);
      expect(seconds).toBeLessThan(0.05); // a flush of this store takes well under a millisecond
    }
    await c.idle();
    expect([c.batches, c.groups, c.commits]).toEqual([3, 1, 3]);
    // A commit above the caps still makes progress, alone.
    const tiny = new Committer(fakeStore().persistence, {}, () => 0n, {}, { maxBytes: 1, maxDocuments: 0 });
    expect(await Promise.all([put(tiny), put(tiny)])).toEqual([1n, 2n]);
    expect(tiny.batches).toBe(2);
  });

  test("the write throughput limit is told each published commit's bytes and rows", async () => {
    const c = new Committer(fakeStore().persistence, {}, () => 0n);
    const told: [bigint, number, number][] = [];
    c.writeThroughput = { record: (ts: bigint, b: number, rows: number) => told.push([ts, b, rows]) } as never;
    await put(c, { docs: [DOC, { ...DOC, id: "d2" }] });
    expect(told).toEqual([[1n, commitWriteBytes([DOC, { ...DOC, id: "d2" }], [IDX]), 3]]);
  });
});

describe("traces", () => {
  test("untraced by default: a commit's trace is answered but not timed", async () => {
    const c = new Committer(fakeStore().persistence, {}, () => 0n);
    expect(c.traced).toBe(false);
    const t = fakeTrace();
    expect(await put(c, { trace: asSpans(t) })).toBe(1n);
    expect(t.settled).toEqual([1n, undefined]);
    expect([t.writeStart, t.writeEnd, t.batchCommits]).toEqual([0, 0, 0]);
  });

  test("traced: validation and the write batch are timed; a refusal settles the trace with the error", async () => {
    const c = new Committer(fakeStore().persistence, {}, () => 0n, {}, { maxDocuments: 1 });
    c.traced = true;
    const t1 = fakeTrace();
    const t2 = fakeTrace();
    expect(await Promise.all([put(c, { trace: asSpans(t1) }), put(c, { trace: asSpans(t2) })])).toEqual([1n, 2n]);
    for (const t of [t1, t2]) {
      expect(t.validateEnd).toBeGreaterThan(0);
      expect(t.writeEnd).toBeGreaterThan(0);
      expect([t.batchCommits, t.batchDocuments]).toEqual([1, 1]);
    }
    const t3 = fakeTrace();
    await expect(put(c, { snapshot: 0n, reads: [ALL], trace: asSpans(t3) })).rejects.toBeInstanceOf(ConflictError);
    expect(t3.settled?.[0]).toBeNull();
    expect(t3.settled?.[1]).toBeInstanceOf(ConflictError);
  });

  test("a commit to a stopped committer settles its trace at once", async () => {
    const c = new Committer(fakeStore().persistence, {}, () => 0n);
    c.fail(new Error("lease lost"));
    const t = fakeTrace();
    const p = put(c, { trace: asSpans(t) });
    expect(t.settled).toEqual([null, c.stopped]);
    await expect(p).rejects.toBeInstanceOf(CommitterStoppedError);
  });
});

describe("waiters and stops", () => {
  test("waitForVisible: each waiter wakes once visibleTs reaches it; a stop wakes the rest", async () => {
    const c = new Committer(fakeStore().persistence, {}, () => 0n);
    const woken: number[] = [];
    void c.waitForVisible(1n).then(() => woken.push(1));
    void c.waitForVisible(2n).then(() => woken.push(2));
    void c.waitForVisible(9n).then(() => woken.push(9));
    await put(c);
    await tick();
    expect(woken).toEqual([1]);
    await put(c);
    await tick();
    expect(woken).toEqual([1, 2]);
    c.fail(new Error("lease lost"));
    await tick();
    expect(woken).toEqual([1, 2, 9]);
  });

  test("fail() refuses the commits still queued; nothing is flushed", async () => {
    const s = fakeStore();
    const c = new Committer(s.persistence, {}, () => 0n);
    const p = put(c);
    c.fail(new Error("lease lost"));
    await expect(p).rejects.toThrow("lease lost");
    await tick();
    expect(s.flushes).toBe(0);
  });

  for (const which of ["apply", "flush"] as const)
    test(`a failed ${which}: the commit is refused and its group is not counted`, async () => {
      const s = fakeStore();
      if (which === "apply") s.failApply = true;
      else s.failFlushes = 1;
      const c = new Committer(s.persistence, {}, () => 0n);
      await expect(put(c)).rejects.toBeInstanceOf(CommitterStoppedError);
      expect([c.groups, c.batches, c.commits]).toEqual([0, 0, 0]);
    });

  test("stopped from outside while a batch is flushed: the next batch is refused and the group not counted", async () => {
    const s = fakeStore();
    const c = new Committer(s.persistence, {}, () => 0n, {}, { maxDocuments: 1 });
    let release!: () => void;
    s.gate = new Promise((r) => {
      release = r;
    });
    const a = put(c);
    const b = put(c);
    await until(() => s.flushes === 1);
    c.fail(new Error("lease lost"));
    release();
    expect(await a).toBe(1n);
    await expect(b).rejects.toThrow("lease lost");
    expect(c.groups).toBe(0);
  });

  test("an onVisible hook that throws: the committer stops naming it; its batch is answered, later batches refused", async () => {
    const c = new Committer(fakeStore().persistence, {}, () => 0n, {}, { maxDocuments: 1 });
    c.onCommit(() => {}, "first-listener");
    const a = put(c, {
      onVisible: () => {
        throw new Error("hook");
      },
    });
    // All three in one group, their refusals caught at once: Bun's `expect(…).rejects` runs the event loop.
    const b = put(c).catch((e) => e);
    const d = put(c).catch((e) => e);
    expect(await a).toBe(1n);
    expect(await b).toBeInstanceOf(CommitterStoppedError);
    expect(await d).toBeInstanceOf(CommitterStoppedError);
    expect(c.stopped?.message).toBe(
      'the committer stopped after an internal error in commit listener "onVisible": hook',
    );
  });

  test("the first listener that throws is named", async () => {
    const c = new Committer(fakeStore().persistence, {}, () => 0n);
    c.onCommit(() => {
      throw new Error("bad");
    }, "first-listener");
    await put(c);
    expect(c.stopped?.message).toBe(
      'the committer stopped after an internal error in commit listener "first-listener": bad',
    );
  });

  test("an error while a group is validated (a throwing atTs) stops the committer", async () => {
    const c = new Committer(fakeStore().persistence, {}, () => 0n);
    void put(c, {
      atTs: () => {
        throw new Error("bad atTs");
      },
    }).catch(() => {});
    await until(() => c.stopped !== null);
    expect(c.stopped?.message).toContain("bad atTs");
  });

  test("idle() resolves once nothing is queued or being flushed", async () => {
    const s = fakeStore();
    const c = new Committer(s.persistence, {}, () => 0n);
    let release!: () => void;
    s.gate = new Promise((r) => {
      release = r;
    });
    const p = put(c);
    let idled = false;
    const i = c.idle().then(() => {
      idled = true;
    });
    await until(() => s.flushes === 1);
    await sleep(5);
    expect(idled).toBe(false);
    release();
    await p;
    await i;
    expect(idled).toBe(true);
  });
});

describe("the write log's retention", () => {
  const ENTRY = logEntryBytes({ ts: 1n, writes: [{ index: "i", key: IDX.key, id: "d1" }] });
  const retained = async (retention: ConstructorParameters<typeof Committer>[1], times: bigint[]) => {
    let now = 0n;
    const c = new Committer(fakeStore().persistence, retention, () => now);
    for (const t of times) {
      now = t;
      await put(c);
    }
    return c;
  };

  test("over the soft size, commits older than the min retention are dropped", async () => {
    const c = await retained({ minRetentionNs: 5n, maxRetentionNs: 1000n, softMaxBytes: 0, hardMaxBytes: null }, [
      1n,
      2n,
      10n,
    ]);
    expect([c.logLength, c.logStartTs, c.logBytes]).toEqual([1, 2n, ENTRY]);
  });

  test("at the soft size exactly, it is over it", async () => {
    // At the third commit the log holds 3 entries, the soft size: the oldest goes, then it is under it.
    const c = await retained(
      { minRetentionNs: 5n, maxRetentionNs: 1000n, softMaxBytes: 3 * ENTRY, hardMaxBytes: null },
      [1n, 2n, 10n],
    );
    expect([c.logLength, c.logStartTs, c.logBytes]).toEqual([2, 1n, 2 * ENTRY]);
  });

  test("the hard cap drops the oldest whatever their age, down to the cap exactly", async () => {
    const c = await retained(
      { minRetentionNs: 1000n, maxRetentionNs: 1000n, softMaxBytes: 1e9, hardMaxBytes: 2 * ENTRY },
      [1n, 2n, 3n],
    );
    expect([c.logLength, c.logStartTs, c.logBytes]).toEqual([2, 1n, 2 * ENTRY]);
  });

  test("a cap below one entry empties the log, and the committer carries on; the dropped prefix is compacted", async () => {
    const times = Array.from({ length: 1100 }, (_, i) => BigInt(i + 1));
    const c = await retained({ hardMaxBytes: 1 }, times);
    expect([c.logLength, c.logStartTs, c.logBytes, c.stopped]).toEqual([0, 1100n, 0, null]);
  });

  test("earliestBeginTs and checkBeginTs: the last commit before latest - window, else the log's start", async () => {
    let now = 0n;
    const c = new Committer(fakeStore().persistence, { minRetentionNs: 1000n, maxRetentionNs: 1000n }, () => now);
    c.resume(3n);
    for (const t of [10n, 20n, 30n, 40n]) {
      now = t;
      await put(c);
    }
    expect(c.earliestBeginTs(15n)).toBe(20n);
    expect(c.earliestBeginTs(20n)).toBe(10n);
    expect(c.earliestBeginTs(100n)).toBe(3n);
    expect(c.earliestBeginTs()).toBe(3n); // Convex's 10 s window
    const e = (() => {
      try {
        c.checkBeginTs(19n, 15n);
      } catch (err) {
        return err as OutOfRetentionError;
      }
    })();
    expect(e).toBeInstanceOf(OutOfRetentionError);
    expect([e?.message, e?.ts, e?.minTs]).toEqual([
      "Timestamp 19 is too early, retry with a higher timestamp",
      19n,
      20n,
    ]);
    expect(() => c.checkBeginTs(20n, 15n)).not.toThrow();
  });

  test("with the oldest commits dropped, the window's start is the last one dropped", async () => {
    let now = 0n;
    const c = new Committer(fakeStore().persistence, { minRetentionNs: 15n, maxRetentionNs: 15n }, () => now);
    for (const t of [10n, 20n, 30n, 40n]) {
      now = t;
      await put(c);
    }
    expect(c.logStartTs).toBe(20n); // 10 and 20 dropped (older than 40 - 15)
    expect(c.earliestBeginTs(100n)).toBe(20n);
    expect(c.earliestBeginTs(5n)).toBe(30n);
  });
});

describe("flush retries", () => {
  test("transient failures are retried, the backoff doubling from initialBackoffMs up to maxBackoffMs", async () => {
    stubRandom(0.5);
    const s = fakeStore();
    s.transient = true;
    s.failFlushes = 3;
    const seen: [number, number][] = [];
    const c = new Committer(s.persistence, {}, () => 0n, {
      initialBackoffMs: 2,
      maxBackoffMs: 5,
      onRetry: (_e, failures, delay) => seen.push([failures, delay]),
    });
    expect(await put(c)).toBe(1n);
    expect(seen).toEqual([
      [1, 1],
      [2, 2],
      [3, 2.5],
    ]);
    expect(c.flushFailures).toBe(3);
  });

  test("by default each retry is logged", async () => {
    const errs = captureErrors();
    const s = fakeStore();
    s.transient = true;
    s.failFlushes = 1;
    const c = new Committer(s.persistence, {}, () => 0n, { initialBackoffMs: 1 });
    expect(await put(c)).toBe(1n);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/^bunvex: a flush failed with a transient error \(attempt 1\); retrying in \d+ ms: flaky$/);
  });

  test("stopped during a retry's backoff: the batch is refused, not written by a later attempt", async () => {
    stubRandom(0.999);
    const s = fakeStore();
    s.transient = true;
    s.failFlushes = 1;
    const c = new Committer(s.persistence, {}, () => 0n, { initialBackoffMs: 60_000, onRetry: () => {} });
    const p = put(c);
    await until(() => s.flushes === 1 && s.failFlushes === 0);
    c.fail(new Error("lease lost"));
    await expect(p).rejects.toThrow("lease lost");
    expect([c.visibleTs, s.flushes]).toEqual([0n, 1]);
  });
});

describe("max_repeatable_ts bumps", () => {
  test("the first after commitDelayMs, then every idleMs to twice that (jittered)", async () => {
    stubRandom(0.5);
    // The waits the committer asks of its timer, not the times its bumps ran: a timer fires late on a busy event
    // loop (a GC pause, a neighbour test), never early, so only a lower bound holds on the clock.
    const asked = recordTimeouts();
    const c = new Committer(fakeStore().persistence, {}, () => 0n);
    const at: number[] = [];
    const t0 = performance.now();
    c.startRepeatableBumps(
      async () => {
        at.push(performance.now() - t0);
      },
      { commitDelayMs: 10, idleMs: 40 },
    );
    await until(() => at.length >= 3);
    c.stopRepeatableBumps();
    expect(at[0]).toBeGreaterThanOrEqual(9);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(59); // 40 × (1 + 0.5)
    const waits = asked.slice(0, at.length).map(Math.round);
    expect(waits).toEqual([10, ...Array(at.length - 1).fill(60)]);
    expect(c.repeatableBumps).toBe(at.length);
  });

  test("an idle bump takes the next commit ts (above the last, or the clock when ahead) and wakes its waiters", async () => {
    let now = 0n;
    const c = new Committer(fakeStore().persistence, {}, () => now);
    await put(c); // ts 1
    const written: bigint[] = [];
    const woke = c.waitForVisible(2n).then(() => "woken");
    c.startRepeatableBumps(
      async (ts) => {
        written.push(ts);
      },
      { commitDelayMs: 1, idleMs: 60_000 },
    );
    await until(() => written.length === 1);
    c.stopRepeatableBumps();
    expect(written).toEqual([2n]);
    expect(c.visibleTs).toBe(2n);
    expect(await woke).toBe("woken");

    now = 1000n;
    const ahead = new Committer(fakeStore().persistence, {}, () => now);
    const w2: bigint[] = [];
    ahead.startRepeatableBumps(
      async (ts) => {
        w2.push(ts);
      },
      { commitDelayMs: 1, idleMs: 60_000 },
    );
    await until(() => w2.length === 1);
    ahead.stopRepeatableBumps();
    expect(w2).toEqual([1000n]);
  });

  test("a bump while a commit is being flushed writes the last durable ts, below it", async () => {
    const s = fakeStore();
    const c = new Committer(s.persistence, {}, () => 0n);
    await put(c); // ts 1
    let release!: () => void;
    s.gate = new Promise((r) => {
      release = r;
    });
    const p = put(c);
    await until(() => s.flushes === 2);
    const written: bigint[] = [];
    c.startRepeatableBumps(
      async (ts) => {
        written.push(ts);
      },
      { commitDelayMs: 1, idleMs: 60_000 },
    );
    await until(() => written.length === 1);
    expect(written).toEqual([1n]);
    release();
    expect(await p).toBe(2n);
    expect(c.visibleTs).toBe(2n);
    c.stopRepeatableBumps();
  });

  test("a failed bump is logged and tried again after commitDelayMs", async () => {
    const errs = captureErrors();
    const c = new Committer(fakeStore().persistence, {}, () => 0n);
    let calls = 0;
    c.startRepeatableBumps(
      async () => {
        calls++;
        if (calls === 1) throw new Error("store down");
      },
      { commitDelayMs: 5, idleMs: 60_000 },
    );
    await until(() => calls === 2);
    c.stopRepeatableBumps();
    expect(errs).toEqual(["bunvex: max_repeatable_ts was not written: store down"]);
    expect(c.repeatableBumps).toBe(1);
  });

  test("a bump that fails after the bumps were stopped is not logged", async () => {
    const errs = captureErrors();
    const c = new Committer(fakeStore().persistence, {}, () => 0n);
    let fail: ((e: Error) => void) | undefined;
    c.startRepeatableBumps(
      () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
      { commitDelayMs: 1, idleMs: 60_000 },
    );
    await until(() => fail !== undefined);
    c.stopRepeatableBumps();
    fail?.(new Error("closed"));
    await sleep(5);
    expect(errs).toEqual([]);
  });
});

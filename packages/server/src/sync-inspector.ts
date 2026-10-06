// The subscriptions and invalidation inspector's memory (STUDY-131 AD-25, a bunvex addition: Convex keeps its
// read sets internal and no screen says why a query re-ran). Per execution key of the sync hub, a bounded ring
// of what made it run again: an invalidation (the commit's ts, its write source, the first write that
// overlapped the key's reads, and how long until a transition sent the new result), or a run with no
// invalidation behind it (a new subscriber, an identity change, new code, a retry). And one feed of every
// invalidation, for a screen that follows them.
//
// It sits on the invalidation path, so it records only raw facts (the written key's bytes are decoded when
// someone asks) and nothing at all when the ring's size is 0.

/** The ring's default size per execution key. */
export const INVALIDATION_HISTORY = 8;
/** How many invalidations the follow feed keeps for a reader that polls behind. */
export const FOLLOW_FEED = 1024;

/** A run that no invalidation caused (`retry`: it had found an index still being rebuilt, STUDY-79). */
export type RerunReason = "newSubscriber" | "identityChange" | "codeChange" | "retry";

export type InvalidationRecord = {
  kind: "invalidation";
  /** Its number in the follow feed: what a function log entry links to (STUDY-131 AD-27). */
  seq: number;
  /** Wall-clock ms when the hub matched the commit. */
  at: number;
  commitTs: bigint;
  /** The mutation (or system writer) that committed, when it gave its name. */
  source: string | null;
  /** The first write of the commit inside the key's reads: its index and full index key. */
  index: string;
  key: Uint8Array;
  /** ms from the match until a transition carried the new result; null until then. */
  sentAfterMs: number | null;
  /** performance.now() at the match, for `sentAfterMs`. */
  perf: number;
};
export type RerunRecord = { kind: "rerun"; at: number; reason: RerunReason };
export type HistoryRecord = InvalidationRecord | RerunRecord;
/** A feed entry: the record (shared with the key's ring), its sequence number and execution key. */
export type FeedRecord = { seq: number; execKey: string; record: InvalidationRecord };

/** A short, stable digest of a query's canonical arguments: who reads it can tell two calls apart. */
export function argsDigest(argsJson: string): string {
  return new Bun.CryptoHasher("sha256").update(argsJson).digest("hex").slice(0, 12);
}

/** The ring's size from the environment, `SUBSCRIPTION_INVALIDATION_HISTORY` (a non-negative integer). */
export function invalidationHistoryFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SUBSCRIPTION_INVALIDATION_HISTORY;
  if (raw === undefined || raw === "") return INVALIDATION_HISTORY;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`SUBSCRIPTION_INVALIDATION_HISTORY: not a non-negative integer: ${raw}`);
  return n;
}

export class SyncInspector {
  private rings = new Map<string, HistoryRecord[]>();
  /** A circular buffer of the last FOLLOW_FEED invalidations: `seq` n lives at `n % FOLLOW_FEED`. */
  private feed: (FeedRecord | undefined)[] = new Array(FOLLOW_FEED);
  private seq = 0;
  private waiters = new Set<() => void>();

  /** `size`: records kept per execution key; 0 records nothing. */
  constructor(readonly size: number) {}

  get enabled(): boolean {
    return this.size > 0;
  }

  private push(execKey: string, r: HistoryRecord) {
    let ring = this.rings.get(execKey);
    if (!ring) {
      ring = [];
      this.rings.set(execKey, ring);
    }
    ring.push(r);
    if (ring.length > this.size) ring.shift();
  }

  /** A commit invalidated `execKey`; `write` is its first write inside the key's reads. */
  invalidated(
    execKey: string,
    commitTs: bigint,
    source: string | undefined,
    write: { index: string; key: Uint8Array },
  ) {
    const seq = ++this.seq;
    const r: InvalidationRecord = {
      kind: "invalidation",
      seq,
      at: Date.now(),
      commitTs,
      source: source ?? null,
      index: write.index,
      key: write.key,
      sentAfterMs: null,
      perf: performance.now(),
    };
    this.push(execKey, r);
    this.feed[seq % FOLLOW_FEED] = { seq, execKey, record: r };
    if (this.waiters.size > 0) for (const w of this.waiters) w();
  }

  /**
   * The invalidation a run of `execKey` starting now answers (STUDY-131 AD-27): the newest one whose new result
   * has not been sent yet. Null when none waits (a run for another reason) or nothing is recorded.
   */
  pending(execKey: string): InvalidationRecord | null {
    const ring = this.rings.get(execKey);
    if (!ring) return null;
    for (let i = ring.length - 1; i >= 0; i--) {
      const r = ring[i]!;
      if (r.kind === "invalidation" && r.sentAfterMs === null) return r;
    }
    return null;
  }

  /** `execKey` ran again for no invalidation. */
  rerun(execKey: string, reason: RerunReason) {
    this.push(execKey, { kind: "rerun", at: Date.now(), reason });
  }

  /** A transition carried `execKey`'s new result: its invalidations not yet sent are now. */
  sent(execKey: string) {
    const ring = this.rings.get(execKey);
    if (!ring) return;
    const now = performance.now();
    for (const r of ring) if (r.kind === "invalidation" && r.sentAfterMs === null) r.sentAfterMs = now - r.perf;
  }

  /** Nobody watches `execKey` any more. */
  forget(execKey: string) {
    this.rings.delete(execKey);
  }

  /** `execKey`'s history, newest first. */
  history(execKey: string): readonly HistoryRecord[] {
    return [...(this.rings.get(execKey) ?? [])].reverse();
  }

  /**
   * The feed's invalidations after `cursor` (a `seq`), as soon as there are any, or none and the same cursor
   * after `timeoutMs` (the log streams' long poll).
   */
  async after(
    cursor: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ entries: FeedRecord[]; newCursor: number }> {
    const take = () => {
      const out: FeedRecord[] = [];
      for (let n = Math.max(cursor + 1, this.seq - FOLLOW_FEED + 1); n <= this.seq; n++)
        out.push(this.feed[n % FOLLOW_FEED]!);
      return out;
    };
    let found = take();
    if (found.length === 0 && timeoutMs > 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        this.waiters.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
      found = take();
    }
    return { entries: found, newCursor: found.at(-1)?.seq ?? Math.max(cursor, 0) };
  }
}

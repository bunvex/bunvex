// The engine: runs transactions against a snapshot, retries mutations on conflict, and caches query
// results by read-set. It executes ANONYMOUS transaction bodies (`db => …`); naming, registering and
// exposing functions is the server's job (@bunvex/server).
import { Committer, ConflictError, type Interval, overlaps } from "./committer.ts";
import type { Persistence } from "./persistence/index.ts";
import type { Schema } from "./schema.ts";
import { Tx } from "./tx.ts";

export type TxBody<T> = (db: Tx) => Promise<T> | T;
type CacheEntry = { value: unknown; reads: Interval[] };

export class Engine {
  readonly committer: Committer;
  private cache = new Map<string, CacheEntry>();
  stats = { cacheHits: 0, cacheMisses: 0, retries: 0 };

  constructor(
    readonly schema: Schema,
    readonly persistence: Persistence,
    private opts: { cacheMax?: number; maxRetries?: number } = {},
  ) {
    this.committer = new Committer(persistence);
    // Invalidation: a durable commit drops every cached result whose read-set it overlaps.
    this.committer.onCommit((entries) => {
      if (this.cache.size === 0) return;
      for (const [k, c] of this.cache)
        for (const e of entries)
          if (overlaps(e.writes, c.reads)) {
            this.cache.delete(k);
            break;
          }
    });
  }

  /** Resume after a restart (PERSIST-01 C5): the committer continues from the store's durable maxTs. */
  async init() {
    const m = (await this.persistence.maxTs?.()) ?? 0;
    this.committer.appliedTs = m;
    this.committer.visibleTs = m;
    return this;
  }

  private tx(snapshot: number, writable: boolean) {
    return new Tx(this.schema, this.persistence, snapshot, writable);
  }

  /** A read-only transaction. With a `cacheKey`, the result is cached until a commit overlaps its reads. */
  async query<T>(body: TxBody<T>, cacheKey?: string): Promise<T> {
    if (cacheKey !== undefined) {
      const hit = this.cache.get(cacheKey);
      if (hit) {
        this.stats.cacheHits++;
        return hit.value as T;
      }
      this.stats.cacheMisses++;
    }
    const snapshot = this.committer.visibleTs;
    const tx = this.tx(snapshot, false);
    const value = await body(tx);
    // Cache only if nothing committed after the snapshot (it would have been invalidated had it been
    // cached already — the same rule, checked at insertion).
    if (cacheKey !== undefined && this.committer.visibleTs === snapshot) {
      const max = this.opts.cacheMax ?? 1000;
      if (this.cache.size >= max) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(cacheKey, { value, reads: tx.reads });
    }
    return value;
  }

  /** A read-only transaction for a SUBSCRIPTION: returns its read-set too, never touches the cache. */
  async queryTracked<T>(body: TxBody<T>): Promise<{ value: T; reads: Interval[]; ts: number }> {
    const snapshot = this.committer.visibleTs;
    const tx = this.tx(snapshot, false);
    const value = await body(tx);
    return { value, reads: tx.reads, ts: snapshot };
  }

  /** A read-write transaction, re-run on conflict up to `maxRetries` times. */
  async mutation<T>(body: TxBody<T>): Promise<T> {
    const maxRetries = this.opts.maxRetries ?? 30;
    for (let attempt = 0; ; attempt++) {
      const tx = this.tx(this.committer.visibleTs, true);
      const value = await body(tx);
      if (!tx.hasWrites) return value;
      const { docs, idx } = tx.toWrites();
      try {
        await this.committer.commit({ snapshot: tx.snapshot, reads: tx.reads, docs, idx });
        return value;
      } catch (e) {
        if (!(e instanceof ConflictError) || attempt >= maxRetries) throw e;
        this.stats.retries++;
        await new Promise((r) => setTimeout(r, Math.min(2 ** attempt, 20) * Math.random()));
      }
    }
  }
}

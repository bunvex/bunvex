// The engine: runs transactions against a snapshot, retries mutations on conflict, and caches query
// results by read-set. It executes ANONYMOUS transaction bodies (`db => …`); naming, registering and
// exposing functions is the server's job (@bunvex/server).
import {
  bootstrapCatalog,
  buildCatalog,
  type Catalog,
  hasChanges,
  INDEX_TABLE,
  type IndexMeta,
  planCatalog,
  TABLES_TABLE,
  type TableMeta,
} from "./catalog.ts";
import { Committer, ConflictError, type Interval, overlaps } from "./committer.ts";
import { type ExecutionKind, installDeterminism, preciseClock, runDeterministic } from "./determinism.ts";
import { encodeKey, prefixEnd } from "./keyenc.ts";
import type { IndexWrite, Persistence } from "./persistence/index.ts";
import { type Doc, indexKey, type Schema } from "./schema.ts";
import { Tx } from "./tx.ts";

export type TxBody<T> = (db: Tx) => Promise<T> | T;
/** A cached result is kept SERIALIZED: every caller gets its own copy, as Convex hands out serialized values. */
type CacheEntry = { json: string; reads: Interval[] };

export class Engine {
  readonly committer: Committer;
  /** The resolved tables and indexes (ids from `_tables` / `_index`), loaded by `init()`. */
  catalog: Catalog = bootstrapCatalog();
  private cache = new Map<string, CacheEntry>();
  stats = { cacheHits: 0, cacheMisses: 0, retries: 0 };

  constructor(
    readonly schema: Schema,
    readonly persistence: Persistence,
    private opts: { cacheMax?: number; maxRetries?: number } = {},
  ) {
    installDeterminism();
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

  /**
   * Open the engine on its store: resume after the store's durable maxTs (PERSIST-01 C5), then load the
   * catalog and reconcile it with the declared schema (STUDY-04). Must finish before serving requests.
   */
  async init() {
    const m = (await this.persistence.maxTs?.()) ?? 0;
    this.committer.appliedTs = m;
    this.committer.visibleTs = m;
    await this.reconcileCatalog();
    return this;
  }

  /** Create missing tables and indexes, drop undeclared indexes, and backfill new indexes. */
  private async reconcileCatalog() {
    const read = async (db: Tx) => ({
      tables: (await db.query(TABLES_TABLE).collect()) as unknown as TableMeta[],
      indexes: (await db.query(INDEX_TABLE).collect()) as unknown as IndexMeta[],
    });
    const { tables, indexes } = await this.runMutation(async (db) => {
      const current = await read(db);
      const changes = planCatalog(this.schema.tables.values(), current.tables, current.indexes);
      if (!hasChanges(changes)) return current;
      for (const t of changes.insertTables) await db.insert(TABLES_TABLE, t);
      for (const id of changes.deleteIndexes) await db.delete(INDEX_TABLE, id);
      for (const i of changes.insertIndexes) await db.insert(INDEX_TABLE, i);
      return read(db); // read-your-own-writes: the catalog as this commit leaves it
    }, true);
    this.catalog = buildCatalog(tables, indexes);
    for (const ix of indexes) if (ix.state === "backfilling") await this.backfill(ix);
  }

  /**
   * Fill a new index from its table's live documents, in batches of commits, then enable it. Idempotent:
   * after a crash midway the index is still `backfilling` and the next start rewrites the same keys.
   */
  private async backfill(meta: IndexMeta, batch = 1000) {
    const t = [...this.catalog.tables.values()].find((x) => x.id === meta.tablet)!;
    const ix = t.indexes.get(meta.name)!;
    let lo: Uint8Array = new Uint8Array(0);
    const hi = Uint8Array.from([0xff, 0xff, 0xff, 0xff]);
    for (;;) {
      const snapshot = this.committer.visibleTs;
      const ids = await this.persistence.scan(t.byId.id, lo, hi, snapshot, batch, false);
      if (ids.length === 0) break;
      const idx: IndexWrite[] = [];
      for (const id of ids) {
        const json = await this.persistence.get(t.id, id, snapshot);
        if (json) idx.push({ index: ix.id, key: indexKey(ix, JSON.parse(json) as Doc), id });
      }
      if (idx.length) await this.committer.commit({ snapshot, reads: [], docs: [], idx });
      lo = prefixEnd(encodeKey([ids[ids.length - 1]]));
    }
    await this.runMutation((db) => db.patch(INDEX_TABLE, meta._id, { state: "enabled" }), true);
  }

  /** Run `body` in a new transaction at `snapshot`, as a deterministic execution frozen at its start. */
  private async execute<T>(kind: ExecutionKind, snapshot: number, body: TxBody<T>, system = false) {
    const now = preciseClock(); // the first _creationTime; Date.now() in the body is its floor
    const tx = new Tx(this.catalog, this.persistence, snapshot, kind === "mutation", now, system);
    const value = await runDeterministic(kind, now, () => body(tx));
    return { tx, value };
  }

  /** A read-only transaction. With a `cacheKey`, the result is cached until a commit overlaps its reads. */
  async query<T>(body: TxBody<T>, cacheKey?: string): Promise<T> {
    const r = await this.cachedQuery(body, cacheKey);
    return "json" in r ? (JSON.parse(r.json) as T) : r.value;
  }

  /**
   * The same, as the result's JSON: a cache hit goes straight to the transport without a parse or a
   * stringify (the HTTP API).
   */
  async queryJson(body: TxBody<unknown>, cacheKey?: string): Promise<string> {
    const r = await this.cachedQuery(body, cacheKey);
    return "json" in r ? r.json : JSON.stringify(r.value ?? null);
  }

  private async cachedQuery<T>(body: TxBody<T>, cacheKey?: string): Promise<{ json: string } | { value: T }> {
    if (cacheKey !== undefined) {
      const hit = this.cache.get(cacheKey);
      if (hit) {
        this.stats.cacheHits++;
        return { json: hit.json };
      }
      this.stats.cacheMisses++;
    }
    const snapshot = this.committer.visibleTs;
    const { tx, value } = await this.execute("query", snapshot, body);
    // Cache only if nothing committed after the snapshot (it would have been invalidated had it been
    // cached already — the same rule, checked at insertion). The caller keeps `value`; the cache keeps
    // its own serialized copy.
    if (cacheKey !== undefined && this.committer.visibleTs === snapshot) {
      const max = this.opts.cacheMax ?? 1000;
      if (this.cache.size >= max) this.cache.delete(this.cache.keys().next().value!);
      const json = JSON.stringify(value ?? null);
      this.cache.set(cacheKey, { json, reads: tx.reads });
      return { json };
    }
    return { value };
  }

  /**
   * A read-only transaction for a SUBSCRIPTION: never touches the cache, and settles instead of throwing.
   * A failed run still returns what it read before failing — as in Convex, an error is a result that is
   * re-evaluated when those reads change (e.g. a query that throws until a document exists).
   */
  async queryTracked<T>(
    body: TxBody<T>,
  ): Promise<({ ok: true; value: T } | { ok: false; error: unknown }) & { reads: Interval[]; ts: number }> {
    const snapshot = this.committer.visibleTs;
    const now = preciseClock(); // as in execute(): the first _creationTime; Date.now() is its floor
    const tx = new Tx(this.catalog, this.persistence, snapshot, false, now);
    try {
      const value = await runDeterministic("query", now, () => body(tx));
      return { ok: true, value, reads: tx.reads, ts: snapshot };
    } catch (error) {
      return { ok: false, error, reads: tx.reads, ts: snapshot };
    }
  }

  /** A read-write transaction, re-run on conflict up to `maxRetries` times. */
  mutation<T>(body: TxBody<T>): Promise<T> {
    return this.runMutation(body, false);
  }

  private async runMutation<T>(body: TxBody<T>, system: boolean): Promise<T> {
    const maxRetries = this.opts.maxRetries ?? 30;
    for (let attempt = 0; ; attempt++) {
      const { tx, value } = await this.execute("mutation", this.committer.visibleTs, body, system);
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

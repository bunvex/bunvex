// The engine: runs transactions against a snapshot, retries mutations on conflict, and caches query
// results by read-set. It executes ANONYMOUS transaction bodies (`db => …`); naming, registering and
// exposing functions is the server's job (@bunvex/server).
import { fromJsonValue, type GenericValidator, toJsonValue, type Value, v } from "@bunvex/values";
import {
  bootstrapCatalog,
  buildCatalog,
  type Catalog,
  hasChanges,
  INDEX_TABLE,
  INSTANCE_TABLE,
  type IndexMeta,
  planCatalog,
  TABLES_TABLE,
  type TableMeta,
} from "./catalog.ts";
import { Committer, type Conflict, ConflictError, type Interval, overlaps } from "./committer.ts";
import {
  type ExecutionKind,
  installDeterminism,
  outsideExecution,
  preciseClock,
  runDeterministic,
} from "./determinism.ts";
import { encodeKey, prefixEnd } from "./keyenc.ts";
import type { IndexWrite, Persistence } from "./persistence/index.ts";
import { type Doc, documentValidator, indexKey, type SchemaDefinition } from "./schema.ts";
import { decodeDoc, Tx } from "./tx.ts";

/** A function result as Convex JSON text (`undefined` → null), and back. */
export const stringifyValue = (v: unknown): string => JSON.stringify(toJsonValue((v ?? null) as Value));
export const parseValue = (json: string): unknown => fromJsonValue(JSON.parse(json));

/** What a subscribed query carries from one run to the next (Convex's `QueryJournal`). */
export type QueryJournal = { endCursor?: string | null };

export type TxBody<T> = (db: Tx) => Promise<T> | T;
/**
 * Convex's OCC retry budget (`crates/common/src/knobs.rs`): a conflicting mutation is re-run up to
 * UDF_EXECUTOR_OCC_MAX_RETRIES = 4 times (5 executions), sleeping between runs with full-jitter exponential
 * backoff from UDF_EXECUTOR_OCC_INITIAL_BACKOFF = 100 ms up to UDF_EXECUTOR_OCC_MAX_BACKOFF = 2 s
 * (`Backoff::fail` in sync_types/src/backoff.rs: `min(initial * 2^failures, max) * random()`).
 */
export const OCC_MAX_RETRIES = 4;
export const OCC_INITIAL_BACKOFF_MS = 100;
export const OCC_MAX_BACKOFF_MS = 2000;

/** The sleep before retry number `failures + 1`: full jitter over the capped exponential. */
export const occBackoffMs = (failures: number, initialMs: number, maxMs: number, random = Math.random) =>
  Math.min(initialMs * 2 ** failures, maxMs) * random();

/**
 * A mutation that still conflicted after the whole retry budget, as Convex's `ErrorMetadata::user_occ`
 * (`crates/errors/src/lib.rs`): code `OptimisticConcurrencyControlFailure`, and a message naming the table
 * that changed and, when known, which mutation changed which document (`occ_write_source_string` in
 * `crates/database/src/database.rs`). The HTTP API answers it with 503, as Convex does.
 */
export class OccError extends Error {
  readonly code = "OptimisticConcurrencyControlFailure";
  constructor(
    message: string,
    readonly info: { table?: string; documentId?: string; writeSource?: string; writeTs: number },
  ) {
    super(message);
  }
}

/** A cached result is kept SERIALIZED: every caller gets its own copy, as Convex hands out serialized values. */
type CacheEntry = { json: string; reads: Interval[] };

export class Engine {
  readonly committer: Committer;
  /** The resolved tables and indexes (ids from `_tables` / `_index`), loaded by `init()`. */
  catalog: Catalog = bootstrapCatalog();
  /** Signs pagination cursors: INSTANCE_SECRET, or the one stored in `_instance` (set by init()). */
  private instanceSecret = "";
  /** Document validators of the declared tables (empty when `schemaValidation` is off). */
  private readonly docValidators = new Map<string, GenericValidator>();
  private cache = new Map<string, CacheEntry>();
  stats = { cacheHits: 0, cacheMisses: 0, retries: 0 };

  constructor(
    readonly schema: SchemaDefinition,
    readonly persistence: Persistence,
    private opts: {
      cacheMax?: number;
      /** Retries after an OCC conflict (default: Convex's 4). */
      maxRetries?: number;
      /** Backoff between retries, in ms (default: Convex's 100 ms doubling up to 2 s, full jitter). */
      occInitialBackoffMs?: number;
      occMaxBackoffMs?: number;
      /** Signs pagination cursors (STUDY-17); the deployment's secret, as Convex's INSTANCE_SECRET. */
      instanceSecret?: string;
    } = {},
  ) {
    installDeterminism();
    // Schema enforcement (STUDY-14): each declared table's validator, with the system fields added.
    if (schema.schemaValidation)
      for (const t of schema.tables.values()) {
        const dv = documentValidator(t.name, t.document);
        if (dv) this.docValidators.set(t.name, dv);
      }
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
    await this.loadInstanceSecret();
    return this;
  }

  /**
   * The secret that signs pagination cursors, as Convex's self-hosted image does it
   * (self-hosted/docker-build/read_credentials.sh): the configured INSTANCE_SECRET wins; otherwise the one
   * stored with the data; otherwise a random one, generated once and stored (in `_instance`, since the data
   * may live in a remote database rather than a directory).
   */
  private async loadInstanceSecret() {
    if (this.opts.instanceSecret) {
      this.instanceSecret = this.opts.instanceSecret;
      return;
    }
    this.instanceSecret = await this.runMutation(async (db) => {
      const stored = (await db.query(INSTANCE_TABLE).first()) as { instanceSecret?: string } | null;
      if (stored?.instanceSecret) return stored.instanceSecret;
      const secret = Buffer.from(outsideExecution(() => crypto.getRandomValues(new Uint8Array(32)))).toString("hex");
      await db.insert(INSTANCE_TABLE, { instanceSecret: secret });
      return secret;
    }, true);
  }

  /** Create missing tables and indexes, drop undeclared indexes, and backfill new indexes. */
  private async reconcileCatalog() {
    const read = async (db: Tx) => ({
      tables: (await db.query(TABLES_TABLE).collect()) as unknown as TableMeta[],
      indexes: (await db.query(INDEX_TABLE).collect()) as unknown as IndexMeta[],
    });
    const { tables, indexes } = await this.runMutation(async (db) => {
      const current = await read(db);
      const systemTables = [{ name: INSTANCE_TABLE, indexes: {}, document: v.any() }];
      const changes = planCatalog([...systemTables, ...this.schema.tables.values()], current.tables, current.indexes);
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
        if (json) idx.push({ index: ix.id, key: indexKey(ix, decodeDoc(json)), id });
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
    tx.instanceSecret = this.instanceSecret;
    if (kind === "mutation") tx.docValidators = this.docValidators;
    const value = await runDeterministic(kind, now, () => body(tx));
    return { tx, value };
  }

  /** A read-only transaction. With a `cacheKey`, the result is cached until a commit overlaps its reads. */
  async query<T>(body: TxBody<T>, cacheKey?: string): Promise<T> {
    const r = await this.cachedQuery(body, cacheKey);
    return "json" in r ? (parseValue(r.json) as T) : r.value;
  }

  /**
   * The same, as the result's JSON: a cache hit goes straight to the transport without a parse or a
   * stringify (the HTTP API).
   */
  async queryJson(body: TxBody<unknown>, cacheKey?: string): Promise<string> {
    const r = await this.cachedQuery(body, cacheKey);
    return "json" in r ? r.json : stringifyValue(r.value);
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
      const json = stringifyValue(value);
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
    journal: QueryJournal = {},
  ): Promise<
    ({ ok: true; value: T } | { ok: false; error: unknown }) & { reads: Interval[]; ts: number; journal: QueryJournal }
  > {
    const snapshot = this.committer.visibleTs;
    const now = preciseClock(); // as in execute(): the first _creationTime; Date.now() is its floor
    const tx = new Tx(this.catalog, this.persistence, snapshot, false, now);
    tx.instanceSecret = this.instanceSecret;
    // Reactive pagination: a re-run ends its page where the previous run ended (Convex's QueryJournal).
    tx.prevEndCursor = journal.endCursor ?? null;
    const out = () => ({ reads: tx.reads, ts: snapshot, journal: { endCursor: tx.nextEndCursor } });
    try {
      const value = await runDeterministic("query", now, () => body(tx));
      return { ok: true, value, ...out() };
    } catch (error) {
      return { ok: false, error, ...out() };
    }
  }

  /**
   * A read-write transaction, re-run on conflict with Convex's retry budget and backoff; an `OccError`
   * once the budget is spent. `source` names the mutation (e.g. "messages:send") in the conflict errors of
   * the transactions it beats.
   */
  mutation<T>(body: TxBody<T>, source?: string): Promise<T> {
    return this.runMutation(body, false, source);
  }

  private async runMutation<T>(body: TxBody<T>, system: boolean, source?: string): Promise<T> {
    const maxRetries = this.opts.maxRetries ?? OCC_MAX_RETRIES;
    const initialMs = this.opts.occInitialBackoffMs ?? OCC_INITIAL_BACKOFF_MS;
    const maxMs = this.opts.occMaxBackoffMs ?? OCC_MAX_BACKOFF_MS;
    for (let failures = 0; ; ) {
      const { tx, value } = await this.execute("mutation", this.committer.visibleTs, body, system);
      if (!tx.hasWrites) return value;
      const { docs, idx } = tx.toWrites();
      try {
        await this.committer.commit({ snapshot: tx.snapshot, reads: tx.reads, docs, idx, source });
        // Tables the mutation created exist for everyone from now on (their _tables/_index documents are
        // durable; a transaction that raced to create the same table conflicted on _tables and retries).
        for (const [name, c] of tx.createdTables)
          if (!this.catalog.tables.has(name))
            this.catalog.add(
              name,
              c.meta.tablet,
              c.meta.number,
              c.indexes.map((i) => ({ name: i.name, fields: i.fields, id: i.indexId })),
            );
        return value;
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
        if (failures >= maxRetries) throw this.occError(e.conflict, source);
        const sleep = occBackoffMs(failures, initialMs, maxMs);
        failures++;
        this.stats.retries++;
        await new Promise((r) => setTimeout(r, sleep));
        // As Convex: wait for the write we lost to, so the next snapshot contains it.
        await this.committer.waitForVisible(e.conflict.writeTs);
      }
    }
  }

  /** The OCC error for `conflict`, worded as Convex's (without its documentation link). */
  private occError(conflict: Conflict, source: string | undefined): OccError {
    let table: string | undefined;
    if (conflict.index !== undefined)
      for (const t of this.catalog.tables.values())
        for (const ix of t.indexes.values()) if (ix.id === conflict.index) table = t.name;
    const documentId = conflict.id ?? undefined;
    const writeSource = conflict.source;
    // Convex names the document only when it knows which mutation changed it.
    let changedBy = "";
    if (writeSource !== undefined && documentId !== undefined) {
      const who = writeSource === source ? "Another call to this mutation" : `A call to "${writeSource}"`;
      changedBy = ` ${who} changed the document with ID "${documentId}".`;
    }
    const where = table === undefined ? "some table" : `the "${table}" table`;
    return new OccError(
      `Documents read from or written to ${where} changed while this mutation was being run and on every subsequent retry.${changedBy}`,
      { table, documentId, writeSource, writeTs: conflict.writeTs },
    );
  }
}

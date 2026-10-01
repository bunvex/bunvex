// The engine: runs transactions against a snapshot, retries mutations on conflict, and caches query
// results by read-set. It executes ANONYMOUS transaction bodies (`db => …`); naming, registering and
// exposing functions is the server's job (@bunvex/server).

import { hostname } from "node:os";
import { fromJsonValue, type GenericValidator, toJsonValue, type Value, v } from "@bunvex/values";
import {
  bootstrapCatalog,
  buildCatalog,
  type Catalog,
  finishCatalog,
  hasChanges,
  hasFinishChanges,
  INDEX_BACKFILLS_INDEX,
  INDEX_BACKFILLS_TABLE,
  INDEX_TABLE,
  INSTANCE_TABLE,
  type IndexBackfillMeta,
  type IndexMeta,
  planCatalog,
  SESSION_REQUESTS_TABLE,
  TABLES_TABLE,
  type TableMeta,
} from "./catalog.ts";
import {
  Committer,
  type Conflict,
  ConflictError,
  type FlushRetryOptions,
  type Interval,
  type WriteLogRetention,
} from "./committer.ts";
import {
  type ExecutionKind,
  installDeterminism,
  outsideExecution,
  preciseClock,
  runDeterministic,
} from "./determinism.ts";
import { INDEX_BACKFILL_DEFAULTS, type IndexBackfillOptions, IndexWorker } from "./index-worker.ts";
import {
  hasLease,
  hasRetention,
  type Lease,
  LeaseHeldError,
  LeaseLostError,
  type Persistence,
} from "./persistence/index.ts";
import { ReadSetIndex } from "./read-set-index.ts";
import { Retention, type RetentionOptions } from "./retention.ts";
import { type DeclaredTable, documentValidator, type SchemaDefinition } from "./schema.ts";
import {
  deleteSessionRequestsBefore,
  findSessionRequest,
  recordSessionRequest,
  SESSION_CLEANUP_CHUNK,
  SESSION_REQUESTS_INDEX,
  type SessionRequestId,
  type SessionRequestOutcome,
} from "./session-requests.ts";
import { Tx } from "./tx.ts";

export { INDEX_BACKFILL_DEFAULTS, type IndexBackfillOptions };

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

/**
 * A cached result is kept SERIALIZED: every caller gets its own copy, as Convex hands out serialized values.
 * Its read-set lives in `cacheReads`, under the same key.
 */
type CacheEntry = { json: string; extra?: unknown };

/**
 * What a caller keeps with a cached query result and gets back on a hit: the server stores the execution's
 * log lines there, so a cache hit answers them too, as Convex's cache entries do (STUDY-20 D2).
 */
/**
 * Who runs a transaction (STUDY-27): the server's identity object, opaque to the engine, and a stable string
 * of it. A cached query result is keyed by that string only if the run read the identity, as Convex's query
 * cache (`observed_identity`, crates/application/src/cache/mod.rs); otherwise it serves every caller.
 */
export type Caller = { identity: unknown; key: string };
const ANONYMOUS: Caller = { identity: null, key: "" };
/** Separates a cache key from its identity part; `*` is the identity-free entry. */
const ID_SEP = "\u0001";

export type CacheCompanion = {
  /** On a miss: the body to run instead, and what to store with its result afterwards. */
  wrap<T>(body: TxBody<T>): { body: TxBody<T>; capture(): unknown };
  /** On a hit: hand back what was stored. */
  replay(extra: unknown): void;
};

export class Engine {
  readonly committer: Committer;
  /** The resolved tables and indexes (ids from `_tables` / `_index`), loaded by `init()`. */
  catalog: Catalog = bootstrapCatalog();
  /** Signs pagination cursors: INSTANCE_SECRET, or the one stored in `_instance` (set by init()). */
  private instanceSecret = "";
  /** Document validators of the declared tables (empty when `schemaValidation` is off). */
  private readonly docValidators = new Map<string, GenericValidator>();
  private cache = new Map<string, CacheEntry>();
  /** The read-sets of the cached results, by cache key: what a commit invalidates (STUDY-08 D9). */
  readonly cacheReads = new ReadSetIndex<string>();
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
      /**
       * The store's lease (PERSIST-01 C7), for drivers that have one. `ttlMs` (default 5000): how long the
       * lease outlives this process if it dies. `waitMs` (default 0): how long `init()` waits for a lease
       * another process holds before failing with `LeaseHeldError`.
       */
      lease?: { ttlMs?: number; waitMs?: number };
      /** The committer's write-log retention (default: Convex's 30 s / 300 s / 50 MiB; STUDY-06 D10). */
      writeLogRetention?: Partial<WriteLogRetention>;
      /** Retention's knobs (Convex's INDEX_RETENTION_DELAY, DOCUMENT_RETENTION_DELAY, …; STUDY-33). */
      retention?: RetentionOptions;
      /** The background index backfill's knobs (Convex's INDEX_BACKFILL_*; STUDY-29). */
      indexBackfill?: IndexBackfillOptions;
      /**
       * How a flush that failed with a transient error is retried (STUDY-25 L4): Convex's backoff, 100 ms
       * doubling up to 10 s with full jitter, as many times as it takes (the lease bounds it).
       */
      flushRetry?: FlushRetryOptions;
    } = {},
  ) {
    installDeterminism();
    // Schema enforcement (STUDY-14): each declared table's validator, with the system fields added.
    if (schema.schemaValidation)
      for (const t of schema.tables.values()) {
        const dv = documentValidator(t.name, t.document);
        if (dv) this.docValidators.set(t.name, dv);
      }
    this.committer = new Committer(persistence, opts.writeLogRetention, undefined, opts.flushRetry);
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyState = { resolve, reject, settled: false };
    });
    this.ready.catch(() => {}); // a rejection nobody awaits is not an error
    this.committer.onFatal((e) => this.settleReady(e));
    // Invalidation: a durable commit drops every cached result whose read-set it overlaps, found through
    // the index of the cached read-sets rather than by testing every entry.
    this.committer.onCommit((entries) => {
      if (this.cache.size === 0) return;
      for (const k of this.cacheReads.matchingEntries(entries)) this.dropCached(k);
    });
  }

  /**
   * Open the engine on its store: resume after the store's durable maxTs (PERSIST-01 C5), then load the
   * catalog and reconcile it with the declared schema (STUDY-04). Must finish before serving requests.
   * New indexes are NOT waited for: they are backfilled in the background (STUDY-29), and a query on one
   * fails with `IndexBackfillingError` until it is enabled; `indexesReady()` resolves then.
   */
  async init() {
    // The lease first (PERSIST-01 C7): maxTs is only meaningful once no other process can write.
    if (hasLease(this.persistence)) await this.acquireLease(this.persistence);
    const m = (await this.persistence.maxTs?.()) ?? 0;
    this.committer.resume(m);
    const backfilling = await this.reconcileCatalog();
    await this.loadInstanceSecret();
    // The worker belongs to the process that holds the lease: the one that writes (STUDY-24 §4.6).
    if (backfilling) {
      this.indexWorker = new IndexWorker(this.workerHost(), this.opts.indexBackfill);
      this.indexWorker.start();
    }
    // So does retention (STUDY-33, Convex's leader-only `LeaderRetentionManager`), on a store that has it.
    if (hasRetention(this.persistence) && typeof this.persistence.readLog === "function") {
      this.retention = new Retention(this.persistence, this.committer, this.opts.retention);
      await this.retention.start();
    }
    return this;
  }

  /** Retention, on a store that has it (its windows and `stats` are for tests and measurements). */
  retention: Retention | null = null;

  /** The background index backfill, while there is one (its `stats` are for tests and measurements). */
  indexWorker: IndexWorker | null = null;
  private readonly ready: Promise<void>;
  private readyState!: { resolve: () => void; reject: (e: unknown) => void; settled: boolean };

  /**
   * Resolves once every index the declared schema asks for is enabled (staged ones excepted), as Convex's
   * `wait_for_schema` lets a push complete; rejects if the engine closes or stops first.
   */
  indexesReady(): Promise<void> {
    return this.ready;
  }

  private settleReady(error?: unknown) {
    if (this.readyState.settled) return;
    this.readyState.settled = true;
    if (error === undefined) this.readyState.resolve();
    else this.readyState.reject(error);
  }

  private lease: { store: Lease; timer: ReturnType<typeof setInterval> } | null = null;

  private async acquireLease(store: Persistence & Lease) {
    const ttlMs = this.opts.lease?.ttlMs ?? 5000;
    const deadline = Date.now() + (this.opts.lease?.waitMs ?? 0);
    const random = Buffer.from(outsideExecution(() => crypto.getRandomValues(new Uint8Array(4)))).toString("hex");
    const holder = `${hostname()}:${process.pid}:${random}`;
    for (;;) {
      const r = await store.acquireLease({ holder, ttlMs });
      if ("epoch" in r) break;
      if (Date.now() >= deadline) throw new LeaseHeldError(r.heldBy, r.expiresInMs);
      await new Promise((ok) => setTimeout(ok, Math.min(250, Math.max(10, deadline - Date.now()))));
    }
    // Renew every TTL/3. A lost lease, or renewals failing until the TTL runs out (the store may then give it
    // to another process), stops the committer: fail-stop, as a failed flush. So does a renewal still waiting
    // for the store when the TTL runs out (a hung connection; drivers bound a renewal by a quarter of the TTL,
    // STUDY-25 L3, but a driver without timeouts could wait forever): the lease may already be another
    // process's, and this one must not keep serving as the writer.
    let renewedAt = Date.now();
    let renewing = false;
    const timer = setInterval(async () => {
      if (this.committer.stopped) return;
      if (renewing) {
        if (Date.now() - renewedAt >= ttlMs)
          this.committer.fail(new LeaseLostError("the store did not answer a lease renewal within the lease's TTL"));
        return;
      }
      renewing = true;
      try {
        await store.renewLease();
        renewedAt = Date.now();
      } catch (e) {
        if (e instanceof LeaseLostError) this.committer.fail(e);
        else if (Date.now() - renewedAt >= ttlMs)
          this.committer.fail(new LeaseLostError(`could not renew the store's lease within its TTL: ${e}`));
      } finally {
        renewing = false;
      }
    }, ttlMs / 3);
    timer.unref?.();
    this.lease = { store, timer };
  }

  /** Stop writing and hand the store over: let the last group land, release the lease, close the store. */
  async close() {
    await this.indexWorker?.stop();
    await this.retention?.stop();
    this.settleReady(new Error("the engine closed before its indexes were ready"));
    await this.committer.idle();
    if (this.lease) {
      clearInterval(this.lease.timer);
      if (!this.committer.stopped) await this.lease.store.releaseLease();
      this.lease = null;
    }
    await this.persistence.close();
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

  /** Every table the engine declares: its own system tables, then the schema's. */
  private declaredTables(): DeclaredTable[] {
    const systemTables: DeclaredTable[] = [
      { name: INSTANCE_TABLE, indexes: {}, document: v.any() },
      {
        name: SESSION_REQUESTS_TABLE,
        indexes: { [SESSION_REQUESTS_INDEX]: ["sessionId", "requestId"] },
        document: v.any(),
      },
      { name: INDEX_BACKFILLS_TABLE, indexes: { [INDEX_BACKFILLS_INDEX]: ["indexId"] }, document: v.any() },
    ];
    return [...systemTables, ...this.schema.tables.values()];
  }

  /**
   * Start the schema change (Convex's `start_push` / `prepare_new_and_mutated_indexes`): create missing
   * tables, add new indexes as `backfilling`, drop pending indexes no longer declared. If nothing is left to
   * backfill, finish it at once; otherwise the worker does once it is. Whether anything is backfilling.
   */
  private async reconcileCatalog(): Promise<boolean> {
    const { tables, indexes } = await this.runMutation(async (db) => {
      const current = await readCatalog(db);
      const changes = planCatalog(this.declaredTables(), current.tables, current.indexes);
      if (!hasChanges(changes)) return current;
      for (const t of changes.insertTables) await db.insert(TABLES_TABLE, t);
      for (const id of changes.deleteIndexes) {
        await db.delete(INDEX_TABLE, id);
        await deleteBackfillProgress(db, id);
      }
      for (const r of changes.restageIndexes) await db.patch(INDEX_TABLE, r._id, { staged: r.staged });
      for (const i of changes.insertIndexes) await db.insert(INDEX_TABLE, i);
      return readCatalog(db); // read-your-own-writes: the catalog as this commit leaves it
    }, true);
    this.catalog = buildCatalog(tables, indexes);
    if (!indexes.some((i) => i.state === "backfilling" && !i.staged)) await this.finishSchema();
    return indexes.some((i) => i.state === "backfilling");
  }

  /**
   * Finish the schema change (Convex's `finish_push` / `commit_indexes_for_schema`), once no index it waits
   * for is still backfilling: enable what is backfilled, disable what became staged, drop what was replaced
   * or removed, in ONE commit; the catalog changes with it. True once finished.
   */
  private async finishSchema(): Promise<boolean> {
    if (this.readyState.settled) return true;
    const finished = await this.runMutation(
      async (db) => {
        const { tables, indexes } = await readCatalog(db);
        const f = finishCatalog(this.declaredTables(), tables, indexes);
        if (!f) return false;
        if (!hasFinishChanges(f)) return true;
        for (const i of f.drop) {
          await db.delete(INDEX_TABLE, i._id);
          await deleteBackfillProgress(db, i._id);
        }
        for (const i of f.enable) await db.patch(INDEX_TABLE, i._id, { state: "enabled", staged: false });
        for (const i of f.disable) await db.patch(INDEX_TABLE, i._id, { state: "backfilled", staged: true });
        const ids = (l: IndexMeta[]) => l.map((i) => i.indexId);
        db.onCommitVisible = (ts) =>
          this.installIndexChanges({ enable: ids(f.enable), disable: ids(f.disable), drop: ids(f.drop) }, ts);
        return true;
      },
      true,
      "index_finish_schema",
    );
    if (finished) this.settleReady();
    return finished;
  }

  /**
   * Install a committed `_index` change: a new catalog object (transactions already running keep theirs,
   * as Convex's index registry belongs to a snapshot), and an empty query cache — a cached result may have
   * read an index that is gone and will never be invalidated by a write again.
   */
  private installIndexChanges(changes: { enable: number[]; disable: number[]; drop: number[] }, ts: number) {
    this.catalog = this.catalog.withIndexChanges(changes, ts);
    this.cache.clear();
  }

  private workerHost() {
    // biome-ignore lint/complexity/noUselessThisAlias: the host reads the engine's CURRENT catalog
    const engine = this;
    return {
      committer: this.committer,
      persistence: this.persistence,
      get catalog() {
        return engine.catalog;
      },
      system: <T>(body: (db: Tx) => Promise<T>, source: string) => this.runMutation(body, true, source),
      installIndexChanges: (c: { enable: number[]; disable: number[]; drop: number[] }, ts: number) =>
        this.installIndexChanges(c, ts),
      finishSchema: () => this.finishSchema(),
    };
  }

  /** Run `body` in a new transaction at `snapshot`, as a deterministic execution frozen at its start. */
  private async execute<T>(
    kind: ExecutionKind,
    snapshot: number,
    body: TxBody<T>,
    system = false,
    caller: Caller = ANONYMOUS,
  ) {
    const now = preciseClock(); // the first _creationTime; Date.now() in the body is its floor
    const tx = new Tx(this.catalog, this.persistence, snapshot, kind === "mutation", now, system);
    tx.retention = this.retention;
    tx.identity = caller.identity;
    tx.instanceSecret = this.instanceSecret;
    if (kind === "mutation") tx.docValidators = this.docValidators;
    const value = await runDeterministic(kind, now, () => body(tx));
    return { tx, value };
  }

  /** A read-only transaction. With a `cacheKey`, the result is cached until a commit overlaps its reads. */
  async query<T>(body: TxBody<T>, cacheKey?: string, companion?: CacheCompanion, caller?: Caller): Promise<T> {
    const r = await this.cachedQuery(body, cacheKey, companion, caller);
    return "json" in r ? (parseValue(r.json) as T) : r.value;
  }

  /**
   * The same, as the result's JSON: a cache hit goes straight to the transport without a parse or a
   * stringify (the HTTP API).
   */
  async queryJson(
    body: TxBody<unknown>,
    cacheKey?: string,
    companion?: CacheCompanion,
    caller?: Caller,
  ): Promise<string> {
    const r = await this.cachedQuery(body, cacheKey, companion, caller);
    return "json" in r ? r.json : stringifyValue(r.value);
  }

  private async cachedQuery<T>(
    body: TxBody<T>,
    cacheKey?: string,
    companion?: CacheCompanion,
    caller: Caller = ANONYMOUS,
  ): Promise<{ json: string } | { value: T }> {
    // Two possible entries, most specific first: this caller's, then the one of a run that read no identity.
    const precise = cacheKey === undefined ? undefined : `${cacheKey}${ID_SEP}${caller.key}`;
    const shared = cacheKey === undefined ? undefined : `${cacheKey}${ID_SEP}*`;
    if (precise !== undefined && shared !== undefined) {
      const hit = this.cache.get(precise) ?? this.cache.get(shared);
      if (hit) {
        this.stats.cacheHits++;
        companion?.replay(hit.extra);
        return { json: hit.json };
      }
      this.stats.cacheMisses++;
    }
    const snapshot = this.committer.visibleTs;
    const wrapped = cacheKey !== undefined ? companion?.wrap(body) : undefined;
    const { tx, value } = await this.execute("query", snapshot, wrapped?.body ?? body, false, caller);
    // Cache only if nothing committed after the snapshot (it would have been invalidated had it been
    // cached already — the same rule, checked at insertion). The caller keeps `value`; the cache keeps
    // its own serialized copy.
    if (precise !== undefined && this.committer.visibleTs === snapshot) {
      const max = this.opts.cacheMax ?? 1000;
      if (this.cache.size >= max) this.dropCached(this.cache.keys().next().value!);
      const json = stringifyValue(value);
      // Keyed by the caller only if the run read the identity (STUDY-27 §1.4).
      const key = tx.identityObserved ? precise! : shared!;
      this.cache.set(key, { json, extra: wrapped?.capture() });
      this.cacheReads.set(key, tx.reads);
      return { json };
    }
    return { value };
  }

  /** Drop a cached result and its read-set (invalidation and eviction). */
  private dropCached(key: string) {
    this.cache.delete(key);
    this.cacheReads.delete(key);
  }

  /**
   * A read-only transaction for a SUBSCRIPTION: never touches the cache, and settles instead of throwing.
   * A failed run still returns what it read before failing — as in Convex, an error is a result that is
   * re-evaluated when those reads change (e.g. a query that throws until a document exists).
   */
  async queryTracked<T>(
    body: TxBody<T>,
    journal: QueryJournal = {},
    /** Run at this snapshot (≤ visibleTs) instead of the latest: a sync transition runs all at one ts. */
    at?: number,
    caller: Caller = ANONYMOUS,
  ): Promise<
    ({ ok: true; value: T } | { ok: false; error: unknown }) & {
      reads: Interval[];
      ts: number;
      journal: QueryJournal;
      /** Whether the run read the identity: its result is then the caller's alone. */
      identityObserved: boolean;
    }
  > {
    const snapshot = at === undefined ? this.committer.visibleTs : Math.min(at, this.committer.visibleTs);
    const now = preciseClock(); // as in execute(): the first _creationTime; Date.now() is its floor
    const tx = new Tx(this.catalog, this.persistence, snapshot, false, now);
    tx.retention = this.retention;
    tx.instanceSecret = this.instanceSecret;
    tx.identity = caller.identity;
    // Reactive pagination: a re-run ends its page where the previous run ended (Convex's QueryJournal).
    tx.prevEndCursor = journal.endCursor ?? null;
    const out = () => ({
      reads: tx.reads,
      ts: snapshot,
      journal: { endCursor: tx.nextEndCursor },
      identityObserved: tx.identityObserved,
    });
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
  mutation<T>(body: TxBody<T>, source?: string, caller?: Caller): Promise<T> {
    return this.runMutation(body, false, source, false, caller);
  }

  /**
   * The same, with the commit timestamp (the snapshot, for a mutation that wrote nothing): what the sync
   * protocol's MutationResponse carries so a client can wait for its queries to reflect the write.
   */
  mutationWithTs<T>(body: TxBody<T>, source?: string, caller?: Caller): Promise<{ value: T; ts: number }> {
    return this.runMutation(body, false, source, true, caller);
  }

  /**
   * A sync session's mutation, run at most once per (sessionId, requestId): a request that already
   * committed is not run again, and its recorded outcome comes back as `replayed`. `outcome` turns a
   * successful run's value into what is recorded, in the same transaction as the run's writes.
   *
   * A replay's `ts` is the snapshot that saw the record, not the original commit's: it is at or after
   * that commit, which is what a client waiting for its write needs.
   */
  async sessionMutation<T>(
    body: TxBody<T>,
    source: string | undefined,
    request: SessionRequestId,
    outcome: (value: T) => SessionRequestOutcome,
    caller?: Caller,
  ): Promise<{ ts: number } & ({ value: T } | { replayed: SessionRequestOutcome })> {
    const r = await this.runMutation(
      async (db): Promise<{ value: T } | { replayed: SessionRequestOutcome }> => {
        const prior = await findSessionRequest(db, request);
        if (prior) return { replayed: prior };
        const value = await body(db);
        await recordSessionRequest(db, request, outcome(value));
        return { value };
      },
      false,
      source,
      true,
      caller,
    );
    return { ...r.value, ts: r.ts };
  }

  /** Delete one chunk of session requests created before `cutoffMs` (retention); how many it deleted. */
  deleteSessionRequests(cutoffMs: number, limit = SESSION_CLEANUP_CHUNK): Promise<number> {
    return this.runMutation((db) => deleteSessionRequestsBefore(db, cutoffMs, limit), true, "session_requests_cleanup");
  }

  private runMutation<T>(
    body: TxBody<T>,
    system: boolean,
    source?: string,
    withTs?: false,
    caller?: Caller,
  ): Promise<T>;
  private runMutation<T>(
    body: TxBody<T>,
    system: boolean,
    source: string | undefined,
    withTs: true,
    caller?: Caller,
  ): Promise<{ value: T; ts: number }>;
  // `withTs` rather than a wrapper, so the common path costs no extra promise.
  private async runMutation<T>(
    body: TxBody<T>,
    system: boolean,
    source?: string,
    withTs = false,
    caller: Caller = ANONYMOUS,
  ): Promise<unknown> {
    const maxRetries = this.opts.maxRetries ?? OCC_MAX_RETRIES;
    const initialMs = this.opts.occInitialBackoffMs ?? OCC_INITIAL_BACKOFF_MS;
    const maxMs = this.opts.occMaxBackoffMs ?? OCC_MAX_BACKOFF_MS;
    for (let failures = 0; ; ) {
      const { tx, value } = await this.execute("mutation", this.committer.visibleTs, body, system, caller);
      if (!tx.hasWrites) return withTs ? { value, ts: tx.snapshot } : value;
      const { docs, idx } = tx.toWrites();
      try {
        const ts = await this.committer.commit({
          snapshot: tx.snapshot,
          reads: tx.reads,
          docs,
          idx,
          source,
          onVisible: tx.onCommitVisible ?? undefined,
        });
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
        return withTs ? { value, ts } : value;
      } catch (e) {
        // Only an OCC conflict is retried. An OutOfRetentionError (the snapshot fell out of the write log)
        // is a system error, as in Convex's `run_mutation`, which retries `occ_info()` errors only.
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

async function readCatalog(db: Tx) {
  return {
    tables: (await db.query(TABLES_TABLE).collect()) as unknown as TableMeta[],
    indexes: (await db.query(INDEX_TABLE).collect()) as unknown as IndexMeta[],
  };
}

/** Drop the backfill checkpoint of a dropped index, if it has one. */
async function deleteBackfillProgress(db: Tx, indexMetaId: string) {
  const p = (await db
    .query(INDEX_BACKFILLS_TABLE)
    .withIndex(INDEX_BACKFILLS_INDEX, (q) => q.eq("indexId", indexMetaId))
    .first()) as unknown as IndexBackfillMeta | null;
  if (p) await db.delete(INDEX_BACKFILLS_TABLE, p._id);
}

// The engine: runs transactions against a snapshot, retries mutations on conflict, and caches query
// results by read-set. It executes ANONYMOUS transaction bodies (`db => …`); naming, registering and
// exposing functions is the server's job (@bunvex/server).

import { hostname } from "node:os";
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
  SESSION_REQUESTS_TABLE,
  TABLES_TABLE,
  type TableMeta,
} from "./catalog.ts";
import {
  Committer,
  type Conflict,
  ConflictError,
  type Interval,
  overlaps,
  type WriteLogRetention,
} from "./committer.ts";
import {
  type ExecutionKind,
  installDeterminism,
  outsideExecution,
  preciseClock,
  runDeterministic,
} from "./determinism.ts";
import { encodeKey, prefixEnd } from "./keyenc.ts";
import {
  hasLease,
  type IndexWrite,
  type Lease,
  LeaseHeldError,
  LeaseLostError,
  type Persistence,
} from "./persistence/index.ts";
import { type DeclaredTable, type Doc, documentValidator, indexKey, type SchemaDefinition } from "./schema.ts";
import {
  deleteSessionRequestsBefore,
  findSessionRequest,
  recordSessionRequest,
  SESSION_CLEANUP_CHUNK,
  SESSION_REQUESTS_INDEX,
  type SessionRequestId,
  type SessionRequestOutcome,
} from "./session-requests.ts";
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
type CacheEntry = { json: string; reads: Interval[]; extra?: unknown };

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
    } = {},
  ) {
    installDeterminism();
    // Schema enforcement (STUDY-14): each declared table's validator, with the system fields added.
    if (schema.schemaValidation)
      for (const t of schema.tables.values()) {
        const dv = documentValidator(t.name, t.document);
        if (dv) this.docValidators.set(t.name, dv);
      }
    this.committer = new Committer(persistence, opts.writeLogRetention);
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
    // The lease first (PERSIST-01 C7): maxTs is only meaningful once no other process can write.
    if (hasLease(this.persistence)) await this.acquireLease(this.persistence);
    const m = (await this.persistence.maxTs?.()) ?? 0;
    this.committer.resume(m);
    await this.reconcileCatalog();
    await this.loadInstanceSecret();
    return this;
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
    // to another process), stops the committer: fail-stop, as a failed flush.
    let renewedAt = Date.now();
    let renewing = false;
    const timer = setInterval(async () => {
      if (renewing || this.committer.stopped) return;
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

  /** Create missing tables and indexes, drop undeclared indexes, and backfill new indexes. */
  private async reconcileCatalog() {
    const read = async (db: Tx) => ({
      tables: (await db.query(TABLES_TABLE).collect()) as unknown as TableMeta[],
      indexes: (await db.query(INDEX_TABLE).collect()) as unknown as IndexMeta[],
    });
    const { tables, indexes } = await this.runMutation(async (db) => {
      const current = await read(db);
      const systemTables: DeclaredTable[] = [
        { name: INSTANCE_TABLE, indexes: {}, document: v.any() },
        {
          name: SESSION_REQUESTS_TABLE,
          indexes: { [SESSION_REQUESTS_INDEX]: ["sessionId", "requestId"] },
          document: v.any(),
        },
      ];
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
  private async execute<T>(
    kind: ExecutionKind,
    snapshot: number,
    body: TxBody<T>,
    system = false,
    caller: Caller = ANONYMOUS,
  ) {
    const now = preciseClock(); // the first _creationTime; Date.now() in the body is its floor
    const tx = new Tx(this.catalog, this.persistence, snapshot, kind === "mutation", now, system);
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
      if (this.cache.size >= max) this.cache.delete(this.cache.keys().next().value!);
      const json = stringifyValue(value);
      // Keyed by the caller only if the run read the identity (STUDY-27 §1.4).
      this.cache.set(tx.identityObserved ? precise! : shared!, { json, reads: tx.reads, extra: wrapped?.capture() });
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
        const ts = await this.committer.commit({ snapshot: tx.snapshot, reads: tx.reads, docs, idx, source });
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

// The engine: runs transactions against a snapshot, retries mutations on conflict, and caches query
// results by read-set. It executes ANONYMOUS transaction bodies (`db => …`); naming, registering and
// exposing functions is the server's job (@bunvex/server).

import { hostname } from "node:os";
import { checkValue, fromJsonValue, type GenericValidator, toJsonValue, type Value, v } from "@bunvex/values";
import {
  bootstrapCatalog,
  buildCatalog,
  type Catalog,
  CRON_JOB_LOGS_TABLE,
  CRON_JOBS_TABLE,
  CRON_NEXT_RUN_TABLE,
  finishCatalog,
  hasChanges,
  hasFinishChanges,
  INDEX_BACKFILLS_INDEX,
  INDEX_BACKFILLS_TABLE,
  INDEX_TABLE,
  INSTANCE_TABLE,
  type IndexBackfillMeta,
  type IndexMeta,
  MODULES_TABLE,
  planCatalog,
  SCHEDULED_FUNCTIONS_TABLE,
  SCHEMAS_TABLE,
  SESSION_REQUESTS_TABLE,
  SOURCE_PACKAGES_TABLE,
  STORAGE_DELETIONS_TABLE,
  STORAGE_TABLE,
  TABLES_TABLE,
  type TableMeta,
  UDF_CONFIG_TABLE,
} from "./catalog.ts";
import {
  Committer,
  type Conflict,
  ConflictError,
  type FlushRetryOptions,
  type Interval,
  type WriteBatchLimits,
  type WriteLogRetention,
} from "./committer.ts";
import {
  type ExecutionKind,
  installDeterminism,
  type Observed,
  outsideExecution,
  preciseClock,
  runDeterministic,
  wallClock,
} from "./determinism.ts";
import { INDEX_BACKFILL_DEFAULTS, type IndexBackfillOptions, IndexWorker } from "./index-worker.ts";
import { instanceSecretBytes, kbkdfCtrHmacSha256 } from "./kbkdf.ts";
import {
  hasLease,
  hasRetention,
  type Lease,
  LeaseHeldError,
  LeaseLostError,
  type Persistence,
} from "./persistence/index.ts";
import { type CachedResult, MAX_CACHE_AGE_MS, QUERY_CACHE_MAX_BYTES, QueryCache } from "./query-cache.ts";
import { Retention, type RetentionOptions } from "./retention.ts";
import { SCHEDULED_FUNCTIONS_INDEXES } from "./scheduled-jobs.ts";
import { type DeclaredTable, documentValidator, type SchemaDefinition, SYSTEM_INDEXES } from "./schema.ts";
import { type SchemaJson, schemaFromJson, schemaToJson } from "./schema-json.ts";
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

/** The instance name a deployment gets when none is configured (Convex's image: its own name; DV-159). */
export const DEFAULT_INSTANCE_NAME = "bunvex-self-hosted";

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
 * Who runs a transaction (STUDY-27): the server's identity object, opaque to the engine, and a stable string
 * of it. A cached query result is keyed by that string only if the run read the identity, as Convex's query
 * cache (`observed_identity`, crates/application/src/cache/mod.rs); otherwise it serves every caller.
 */
export type Caller = { identity: unknown; key: string };
const ANONYMOUS: Caller = { identity: null, key: "" };
/** Separates a cache key from its identity part; `*` is the identity-free entry. */
const ID_SEP = "\u0001";

/**
 * What a caller keeps with a cached query result and gets back on a hit: the server stores the execution's
 * log lines there, so a cache hit answers them too, as Convex's cache entries do (STUDY-20 D2).
 */
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
  /** The deployment's name (Convex's INSTANCE_NAME): admin keys carry it (STUDY-34). Set by `init()`. */
  instanceName = "";
  /** Document validators of the declared tables (empty when `schemaValidation` is off). */
  private docValidators = new Map<string, GenericValidator>();
  /** Query results by function, arguments and (when read) identity: an LRU bounded by bytes (STUDY-08 D8). */
  readonly cache: QueryCache;
  /** Bumped when the catalog changes under the cache: a run begun before is not stored. */
  private cacheEpoch = 0;
  /**
   * `cacheHits` counts answers from the cache, including the ones that waited for another caller's run;
   * `cacheWaits` counts the waits; `cacheMisses` counts the runs.
   */
  stats = { cacheHits: 0, cacheMisses: 0, cacheWaits: 0, retries: 0 };

  constructor(
    /** The declared schema: the constructor's, the stored one (`storedSchema`), or the last pushed. */
    public schema: SchemaDefinition,
    readonly persistence: Persistence,
    private opts: {
      /** The query cache's byte budget (default: UDF_CACHE_MAX_SIZE from the environment, else 100 MiB). */
      cacheMaxBytes?: number;
      /** The wall clock (ms) the query cache ages results that read the clock by; tests move it. */
      cacheClock?: () => number;
      /** Retries after an OCC conflict (default: Convex's 4). */
      maxRetries?: number;
      /** Backoff between retries, in ms (default: Convex's 100 ms doubling up to 2 s, full jitter). */
      occInitialBackoffMs?: number;
      occMaxBackoffMs?: number;
      /** Signs pagination cursors (STUDY-17); the deployment's secret, as Convex's INSTANCE_SECRET. */
      instanceSecret?: string;
      /**
       * The deployment's name, as Convex's INSTANCE_NAME: an admin key is valid for one name (STUDY-34).
       * Default: the one stored with the data, else `bunvex-self-hosted`, stored (DV-159).
       */
      instanceName?: string;
      /**
       * The store's lease (PERSIST-01 C7), for drivers that have one. `ttlMs` (default 5000): how long the
       * lease outlives this process if it dies. `waitMs` (default 0): how long `init()` waits for a lease
       * another process holds before failing with `LeaseHeldError`.
       */
      lease?: { ttlMs?: number; waitMs?: number };
      /** The committer's write-log retention (default: Convex's 30 s / 300 s / 50 MiB; STUDY-06 D10). */
      writeLogRetention?: Partial<WriteLogRetention>;
      /**
       * Start on the schema last pushed (STUDY-35): a deployable deployment's schema comes from its pushes,
       * kept in `_schemas`, not from code. The constructor's schema is used until the first push.
       */
      storedSchema?: boolean;
      /** Retention's knobs (Convex's INDEX_RETENTION_DELAY, DOCUMENT_RETENTION_DELAY, …; STUDY-33). */
      retention?: RetentionOptions;
      /** The background index backfill's knobs (Convex's INDEX_BACKFILL_*; STUDY-29). */
      indexBackfill?: IndexBackfillOptions;
      /**
       * How a flush that failed with a transient error is retried (STUDY-25 L4): Convex's backoff, 100 ms
       * doubling up to 10 s with full jitter, as many times as it takes (the lease bounds it).
       */
      flushRetry?: FlushRetryOptions;
      /** The soft caps on what one flush carries (default: Convex's 64 documents / 64 KiB; DV-62). */
      writeBatch?: Partial<WriteBatchLimits>;
    } = {},
  ) {
    installDeterminism();
    this.installValidators(schema);
    this.committer = new Committer(persistence, opts.writeLogRetention, undefined, opts.flushRetry, opts.writeBatch);
    this.cache = new QueryCache(opts.cacheMaxBytes ?? cacheMaxBytesFromEnv());
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyState = { resolve, reject, settled: false };
    });
    this.ready.catch(() => {}); // a rejection nobody awaits is not an error
    this.committer.onFatal((e) => this.settleReady(e));
    // No invalidation on commit: as Convex's, a cached result is checked against the write log when it is
    // looked up (`cachedQuery`), so a commit costs the cache nothing.
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
    // A deployable deployment's schema is the last one pushed (STUDY-35): read before reconciling, or the
    // constructor's (empty) schema would drop every index.
    if (this.opts.storedSchema) {
      const active = (await readSystemRows(this.persistence, SCHEMAS_TABLE)).find((r) => r.state === "active");
      if (active) {
        this.schema = schemaFromJson(JSON.parse(active.schema as string) as SchemaJson);
        this.installValidators(this.schema);
      }
    }
    const backfilling = await this.reconcileCatalog();
    await this.loadInstanceSecret();
    await this.loadInstanceName();
    // The worker belongs to the process that holds the lease: the one that writes (STUDY-24 §4.6).
    if (backfilling) this.startIndexWorker();
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

  /**
   * A key for one purpose, derived from the instance secret (HMAC-SHA256(secret, purpose)), as Convex's
   * keybroker derives one per use ("store file authorization", …). The secret itself never leaves.
   */
  secretKey(purpose: string): Uint8Array {
    if (!this.instanceSecret) throw new Error("secretKey: the engine is not initialized");
    return new Uint8Array(new Bun.CryptoHasher("sha256", this.instanceSecret).update(purpose).digest());
  }

  /**
   * The deployment's name: the configured one wins; otherwise the one stored with the data; otherwise
   * `bunvex-self-hosted` (Convex's self-hosted image defaults to its own name and persists it). It is stored.
   */
  private async loadInstanceName() {
    const configured = this.opts.instanceName;
    if (configured !== undefined && !/^[^|:\s]+$/.test(configured))
      throw new Error(
        `invalid instance name ${JSON.stringify(configured)}: it may not be empty or contain "|", ":" or spaces`,
      );
    // The name the deployment runs with is the one recorded, so tools reading the store (`bunvex admin-key`)
    // issue keys for it.
    this.instanceName = await this.runMutation(async (db) => {
      const doc = (await db.query(INSTANCE_TABLE).first()) as Record<string, unknown> | null;
      const stored = typeof doc?.instanceName === "string" ? doc.instanceName : undefined;
      const name = configured || stored || DEFAULT_INSTANCE_NAME;
      if (name !== stored) {
        if (doc) await db.patch(INSTANCE_TABLE, doc._id as string, { instanceName: name });
        else await db.insert(INSTANCE_TABLE, { instanceName: name });
      }
      return name;
    }, true);
  }

  /**
   * A 16-byte key for one purpose, derived from the instance secret by KBKDF-CTR-HMAC-SHA256 exactly as
   * Convex's keybroker derives it (`Encryptor::derive_from_secret`): the admin key cipher's key is
   * `derivedKey("admin key")`, so keys are interchangeable with Convex's for the same name and secret.
   */
  derivedKey(purpose: string, length = 16): Uint8Array {
    if (!this.instanceSecret) throw new Error("derivedKey: the engine is not initialized");
    return kbkdfCtrHmacSha256(instanceSecretBytes(this.instanceSecret), purpose, length);
  }

  /** A deployment setting kept in `_instance` (e.g. the S3 key prefix): the stored one, else `make()`'s, stored. */
  async instanceSetting(name: string, make: () => string): Promise<string> {
    return this.runMutation(async (db) => {
      const doc = (await db.query(INSTANCE_TABLE).first()) as Record<string, unknown> | null;
      const have = doc?.[name];
      if (typeof have === "string") return have;
      const value = make();
      if (doc) await db.patch(INSTANCE_TABLE, doc._id as string, { [name]: value });
      else await db.insert(INSTANCE_TABLE, { [name]: value });
      return value;
    }, true);
  }

  /** Every table the engine declares: its own system tables, then the schema's. */
  private declaredTables(schema: SchemaDefinition = this.schema): DeclaredTable[] {
    const systemTables: DeclaredTable[] = [
      { name: INSTANCE_TABLE, indexes: {}, document: v.any() },
      {
        name: SESSION_REQUESTS_TABLE,
        indexes: { [SESSION_REQUESTS_INDEX]: ["sessionId", "requestId"] },
        document: v.any(),
      },
      { name: INDEX_BACKFILLS_TABLE, indexes: { [INDEX_BACKFILLS_INDEX]: ["indexId"] }, document: v.any() },
      { name: SCHEDULED_FUNCTIONS_TABLE, indexes: SCHEDULED_FUNCTIONS_INDEXES, document: v.any() },
      { name: CRON_JOBS_TABLE, indexes: { by_name: ["name"] }, document: v.any() },
      {
        name: CRON_NEXT_RUN_TABLE,
        indexes: { by_cron_job_id: ["cronJobId"], by_next_ts: ["nextTs"] },
        document: v.any(),
      },
      { name: CRON_JOB_LOGS_TABLE, indexes: { by_name_and_ts: ["name", "ts"] }, document: v.any() },
      { name: STORAGE_TABLE, indexes: { by_storage_id: ["storageId"] }, document: v.any() },
      { name: STORAGE_DELETIONS_TABLE, indexes: {}, document: v.any() },
      { name: MODULES_TABLE, indexes: { by_path: ["path"] }, document: v.any() },
      { name: SOURCE_PACKAGES_TABLE, indexes: {}, document: v.any() },
      { name: UDF_CONFIG_TABLE, indexes: {}, document: v.any() },
      { name: SCHEMAS_TABLE, indexes: {}, document: v.any() },
    ];
    return [...systemTables, ...schema.tables.values()];
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
    // Only the engine's start finishes on its own; a push finishes in its commit (commitSchemaPush).
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

  private installValidators(schema: SchemaDefinition) {
    this.docValidators = validatorsOf(schema);
  }

  private startIndexWorker() {
    this.indexWorker ??= new IndexWorker(this.workerHost(), this.opts.indexBackfill);
    this.indexWorker.start();
  }

  /** The schema change a push started and has not finished: its `_schemas` row and the schema. */
  private pendingPush: { id: string; schema: SchemaDefinition } | null = null;
  /** The pending schema's document validators, checked on every write (but not enforced) until it finishes. */
  private pendingValidators: Map<string, GenericValidator> | null = null;
  /** The background walk of a pending schema's existing documents (STUDY-35 PR 5). */
  private validation: Promise<unknown> | null = null;

  /** A transaction's commit hook, plus failing the pending schema when one of its writes did not match it. */
  private withPendingCheck(tx: Tx): ((ts: number) => void) | undefined {
    const own = tx.onCommitVisible;
    const v = tx.pendingViolation;
    if (!v) return own ?? undefined;
    const pending = this.pendingPush;
    return (ts) => {
      own?.(ts);
      if (pending) void this.failSchemaPush(pending.id, v.error, v.table).catch(() => {});
    };
  }

  /** Mark a pending (or validated) schema `failed` (Convex's `mark_failed`). */
  private async failSchemaPush(schemaId: string, error: string, tableName: string | null) {
    await this.runMutation(
      async (db) => {
        const row = (await db.get(SCHEMAS_TABLE, schemaId)) as Record<string, unknown> | null;
        if (row && (row.state === "pending" || row.state === "validated"))
          await db.patch(SCHEMAS_TABLE, schemaId, { state: "failed", error, tableName });
      },
      true,
      "schema_worker",
    );
  }

  /**
   * Convex's `SchemaWorker`: walk every table whose validator the pushed schema changes (or adds) and check
   * each existing document; the first that does not match fails the schema
   * (`Document with ID "…" in table "…" does not match the schema: …`), else it becomes `validated`. Writes
   * made meanwhile are checked as they commit (`pendingValidators`).
   */
  private async validateExisting(schemaId: string, schema: SchemaDefinition, active: SchemaDefinition) {
    const stillPending = () => this.pendingPush?.id === schemaId;
    if (schema.schemaValidation)
      for (const t of schema.tables.values()) {
        const validator = documentValidator(t.name, t.document);
        if (!validator) continue;
        const before = active.schemaValidation ? active.tables.get(t.name) : undefined;
        if (before && JSON.stringify(before.document.json) === JSON.stringify(t.document.json)) continue;
        let cursor: string | null = null;
        for (;;) {
          if (!stillPending()) return;
          const page = await this.query(async (db) => db.query(t.name).paginate({ numItems: 256, cursor }));
          for (const doc of page.page) {
            const msg = checkValue(validator, doc as unknown as Value, (n) => this.catalog.byNumber(n)?.name);
            if (msg) {
              await this.failSchemaPush(
                schemaId,
                `Document with ID "${doc._id as string}" in table "${t.name}" does not match the schema: ${msg}`,
                t.name,
              );
              return;
            }
          }
          if (page.isDone) break;
          cursor = page.continueCursor;
        }
      }
    if (!stillPending()) return;
    await this.runMutation(
      async (db) => {
        const row = (await db.get(SCHEMAS_TABLE, schemaId)) as Record<string, unknown> | null;
        if (row?.state === "pending") await db.patch(SCHEMAS_TABLE, schemaId, { state: "validated" });
      },
      true,
      "schema_worker",
    );
  }

  /**
   * A push's schema change, first half (Convex's `start_push` → `handle_schema_change_in_start_push`):
   * create missing tables, add new and changed indexes as `backfilling` (the worker builds them), drop
   * pending ones no longer declared, and record the schema as `pending` — an earlier pending one becomes
   * `overwritten` (its push then sees `raceDetected`). Enabled indexes keep serving the running code until
   * `commitSchemaPush`. Returns the schema's id and the indexes it added.
   */
  async startSchemaPush(schema: SchemaDefinition): Promise<{ schemaId: string; addedIndexes: string[] }> {
    const declared = this.declaredTables(schema);
    const r = await this.runMutation(
      async (db) => {
        const current = await readCatalog(db);
        const changes = planCatalog(declared, current.tables, current.indexes);
        for (const t of changes.insertTables) await db.insert(TABLES_TABLE, t);
        for (const id of changes.deleteIndexes) {
          await db.delete(INDEX_TABLE, id);
          await deleteBackfillProgress(db, id);
        }
        for (const x of changes.restageIndexes) await db.patch(INDEX_TABLE, x._id, { staged: x.staged });
        for (const i of changes.insertIndexes) await db.insert(INDEX_TABLE, i);
        for (const row of await db.query(SCHEMAS_TABLE).collect())
          if (row.state === "pending" || row.state === "validated")
            await db.patch(SCHEMAS_TABLE, row._id as string, { state: "overwritten" });
        const schemaId = await db.insert(SCHEMAS_TABLE, {
          state: "pending",
          schema: JSON.stringify(schemaToJson(schema)),
        });
        const tableName = (tablet: number) =>
          current.tables.find((t) => t.tablet === tablet)?.name ??
          changes.insertTables.find((t) => t.tablet === tablet)?.name;
        const addedIndexes = changes.insertIndexes
          .filter((i) => !(i.name in SYSTEM_INDEXES))
          .map((i) => `${tableName(i.tablet)}.${i.name}`);
        return { schemaId, addedIndexes, after: await readCatalog(db) };
      },
      true,
      "start_push",
    );
    this.catalog = buildCatalog(r.after.tables, r.after.indexes);
    const active = this.schema;
    this.pendingPush = { id: r.schemaId, schema };
    this.pendingValidators = validatorsOf(schema);
    this.validation = this.validateExisting(r.schemaId, schema, active).catch((e) =>
      this.failSchemaPush(r.schemaId, `Schema validation failed: ${e instanceof Error ? e.message : e}`, null).catch(
        () => {},
      ),
    );
    if (r.after.indexes.some((i) => i.state === "backfilling")) this.startIndexWorker();
    return { schemaId: r.schemaId, addedIndexes: r.addedIndexes };
  }

  /**
   * Where a push's schema change stands (Convex's `wait_for_schema` states): `raceDetected` once another
   * push replaced it; `inProgress` while an index it enables is backfilling; else `complete`.
   */
  async schemaPushStatus(
    schemaId: string,
  ): Promise<
    | { type: "raceDetected" }
    | { type: "failed"; error: string; tableName: string | null }
    | { type: "inProgress"; indexesComplete: number; indexesTotal: number; schemaValidationComplete: boolean }
    | { type: "complete" }
  > {
    return this.query((db) =>
      db.asSystem(async () => {
        const row = (await db.get(SCHEMAS_TABLE, schemaId)) as Record<string, unknown> | null;
        if (!row || row.state === "overwritten") return { type: "raceDetected" as const };
        if (row.state === "failed")
          return { type: "failed" as const, error: row.error as string, tableName: (row.tableName as string) ?? null };
        if (row.state === "active") return { type: "complete" as const };
        const validated = row.state === "validated";
        const pending = schemaFromJson(JSON.parse(row.schema as string) as SchemaJson);
        const indexes = (await db.query(INDEX_TABLE).collect()) as unknown as IndexMeta[];
        const tables = (await db.query(TABLES_TABLE).collect()) as unknown as TableMeta[];
        const tabletOf = new Map(tables.map((t) => [t.name, t.tablet]));
        // The indexes this schema enables (staged ones are never waited for, as Convex's).
        let total = 0;
        let done = 0;
        for (const t of pending.tables.values())
          for (const name of Object.keys(t.indexes)) {
            if (t.staged?.includes(name)) continue;
            const live = indexes.filter((i) => i.tablet === tabletOf.get(t.name) && i.name === name);
            total++;
            if (live.some((i) => i.state !== "backfilling")) done++;
          }
        if (done < total || !validated)
          return {
            type: "inProgress" as const,
            indexesComplete: done,
            indexesTotal: total,
            schemaValidationComplete: validated,
          };
        return { type: "complete" as const };
      }),
    ) as never;
  }

  /**
   * A push's schema change, second half, in ONE commit with `body` (Convex's `finish_push`): enable what is
   * backfilled, disable what became staged, drop what was replaced or removed, make the schema `active`,
   * and whatever `body` writes (the code, the crons). The engine switches to the schema — its validators,
   * its catalog — when the commit is visible. Throws if the schema was overwritten or is not complete.
   */
  async commitSchemaPush<T>(
    schemaId: string,
    body: (db: Tx) => Promise<T>,
  ): Promise<{ value: T; indexDiff: { enabled: string[]; disabled: string[]; dropped: string[] } }> {
    const pending = this.pendingPush;
    if (!pending || pending.id !== schemaId)
      throw new SchemaPushError("RaceDetected", "Schema was overwritten by another push.");
    const declared = this.declaredTables(pending.schema);
    const r = await this.runMutation(
      async (db) => {
        const row = (await db.get(SCHEMAS_TABLE, schemaId)) as Record<string, unknown> | null;
        if (row?.state === "failed")
          throw new SchemaPushError("SchemaNotReady", `Schema validation failed: ${row.error as string}`);
        if (!row || (row.state !== "pending" && row.state !== "validated"))
          throw new SchemaPushError("RaceDetected", "Schema was overwritten by another push.");
        if (row.state !== "validated")
          throw new SchemaPushError(
            "SchemaNotReady",
            "The existing documents are still being checked against the schema.",
          );
        const { tables, indexes } = await readCatalog(db);
        const f = finishCatalog(declared, tables, indexes);
        if (!f) throw new SchemaPushError("SchemaNotReady", "The schema's indexes are still backfilling.");
        for (const i of f.drop) {
          await db.delete(INDEX_TABLE, i._id);
          await deleteBackfillProgress(db, i._id);
        }
        for (const i of f.enable) await db.patch(INDEX_TABLE, i._id, { state: "enabled", staged: false });
        for (const i of f.disable) await db.patch(INDEX_TABLE, i._id, { state: "backfilled", staged: true });
        for (const old of await db.query(SCHEMAS_TABLE).collect())
          if (old.state === "active") await db.delete(SCHEMAS_TABLE, old._id as string);
        await db.patch(SCHEMAS_TABLE, schemaId, { state: "active" });
        const value = await body(db);
        const ids = (l: IndexMeta[]) => l.map((i) => i.indexId);
        const name = (i: IndexMeta) => `${tables.find((t) => t.tablet === i.tablet)?.name}.${i.name}`;
        db.onCommitVisible = (ts) => {
          this.installIndexChanges({ enable: ids(f.enable), disable: ids(f.disable), drop: ids(f.drop) }, ts);
          this.schema = pending.schema;
          this.installValidators(pending.schema);
          if (this.pendingPush?.id === schemaId) {
            this.pendingPush = null;
            this.pendingValidators = null;
          }
        };
        return {
          value,
          indexDiff: { enabled: f.enable.map(name), disabled: f.disable.map(name), dropped: f.drop.map(name) },
        };
      },
      true,
      "finish_push",
    );
    return r;
  }

  /**
   * Install a committed `_index` change: a new catalog object (transactions already running keep theirs,
   * as Convex's index registry belongs to a snapshot), and an empty query cache — a cached result may have
   * read an index that is gone and will never be invalidated by a write again. Runs under way are not
   * stored either (`cacheEpoch`).
   */
  private installIndexChanges(changes: { enable: number[]; disable: number[]; drop: number[] }, ts: number) {
    this.catalog = this.catalog.withIndexChanges(changes, ts);
    this.cache.clear();
    this.cacheEpoch++;
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
    if (kind === "mutation") {
      tx.docValidators = this.docValidators;
      tx.pendingValidators = this.pendingValidators;
    }
    const observed: Observed = { time: false };
    const value = await runDeterministic(kind, now, () => body(tx), observed);
    return { tx, value, observed, now };
  }

  /**
   * A read-only transaction. With a `cacheKey`, through the query cache (STUDY-08 D8). `at`: the snapshot
   * (≤ the visible ts) instead of the latest.
   */
  async query<T>(
    body: TxBody<T>,
    cacheKey?: string,
    companion?: CacheCompanion,
    caller?: Caller,
    at?: number,
  ): Promise<T> {
    const r = await this.cachedQuery(body, cacheKey, companion, caller, at);
    return "value" in r ? r.value : (parseValue(r.json) as T);
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
    at?: number,
  ): Promise<string> {
    const r = await this.cachedQuery(body, cacheKey, companion, caller, at);
    return "value" in r ? (r.json ?? stringifyValue(r.value)) : r.json;
  }

  /**
   * Convex's query cache (`CacheManager::get`, crates/application/src/cache/mod.rs), at snapshot `ts`:
   * - a result stored at or before `ts` is served if no commit since wrote into its reads (checked now,
   *   against the write log: Convex's token refresh) and, if it read the clock, it is not older than
   *   MAX_CACHE_AGE_MS; otherwise it is dropped and the query planned again;
   * - a run already under way at or before `ts` is waited for, then checked the same way; if it failed or
   *   stored its result under another key, the waiters plan again (one of them runs, the others wait);
   * - otherwise this call runs the query, under a waiting entry when nothing newer is cached, and stores
   *   the result if it succeeded. Errors are never stored.
   * Keys, most specific first: this caller's, then the one of a run that read no identity (STUDY-27).
   */
  private async cachedQuery<T>(
    body: TxBody<T>,
    cacheKey: string | undefined,
    companion: CacheCompanion | undefined,
    caller: Caller = ANONYMOUS,
    at?: number,
  ): Promise<{ json: string } | { value: T; json?: string }> {
    const visible = this.committer.visibleTs;
    const ts = at === undefined ? visible : Math.min(at, visible);
    if (cacheKey === undefined) return { value: (await this.execute("query", ts, body, false, caller)).value };
    const keys = [`${cacheKey}${ID_SEP}${caller.key}`, `${cacheKey}${ID_SEP}*`] as const;
    // Where a run is coordinated once a key was found (Convex's `stored_key_hint`): a result stored shared
    // and found invalid is recomputed under the shared key, so callers of other identities wait for it.
    let hint: string | undefined;
    for (;;) {
      const found = this.cache.find(keys);
      const key = found?.key ?? hint ?? keys[0];
      hint = key;
      const e = found?.entry;
      let r: CachedResult;
      if (e?.kind === "ready" && e.result.originalTs <= ts) r = e.result;
      else if (e?.kind === "waiting" && e.ts <= ts) {
        this.stats.cacheWaits++;
        const waited = await e.result;
        if (waited === null) {
          this.cache.removeWaiting(key, e.id);
          continue;
        }
        r = waited;
      } else return this.runCached(body, ts, keys, key, e === undefined, companion, caller);
      if (!this.stillValid(key, r, ts)) continue;
      this.stats.cacheHits++;
      companion?.replay(r.extra);
      return { json: r.json };
    }
  }

  /**
   * Run a query for the cache. With `coordinate`, under a waiting entry at `key` that later callers wait
   * for, and the result is stored; without (a newer result or run is there), the result is only returned.
   */
  private async runCached<T>(
    body: TxBody<T>,
    ts: number,
    keys: readonly [precise: string, shared: string],
    key: string,
    coordinate: boolean,
    companion: CacheCompanion | undefined,
    caller: Caller,
  ): Promise<{ value: T; json?: string }> {
    this.stats.cacheMisses++;
    const waiting = coordinate ? this.cache.putWaiting(key, ts) : undefined;
    const epoch = this.cacheEpoch;
    const wrapped = waiting ? companion?.wrap(body) : undefined;
    let run: Awaited<ReturnType<typeof this.execute<T>>>;
    try {
      run = await this.execute("query", ts, wrapped?.body ?? body, false, caller);
    } catch (error) {
      // Errors are not cached; whoever waited plans again.
      if (waiting) {
        this.cache.removeWaiting(key, waiting.id);
        waiting.settle(null);
      }
      throw error;
    }
    if (!waiting) return { value: run.value };
    const { tx, value, observed, now } = run;
    this.cache.removeWaiting(key, waiting.id);
    if (epoch !== this.cacheEpoch) {
      waiting.settle(null);
      return { value };
    }
    // Keyed by the caller only if the run read the identity (STUDY-27 §1.4). The cache keeps its own
    // serialized copy; the caller keeps `value`.
    const stored = tx.identityObserved ? keys[0] : keys[1];
    const json = stringifyValue(value);
    const result: CachedResult = {
      json,
      extra: wrapped?.capture(),
      originalTs: ts,
      tokenTs: ts,
      reads: tx.reads,
      observedTime: observed.time,
      unixMs: Math.floor(now),
      identityObserved: tx.identityObserved,
    };
    this.cache.putReady(stored, result);
    // Waiters at `key` take this result only if it is stored there; otherwise they look again.
    waiting.settle(stored === key ? result : null);
    return { value, json };
  }

  /**
   * Whether `r`, cached under `key`, is the query's result at `ts` (Convex's `validate_cache_result`): no
   * commit in `(tokenTs, ts]` wrote into its reads (a token older than the write log's retention cannot be
   * checked and counts as changed), and a result that read the clock is not older than MAX_CACHE_AGE_MS.
   * An invalid result is dropped; a valid one is now known valid up to `ts`.
   */
  private stillValid(key: string, r: CachedResult, ts: number): boolean {
    if (ts < r.originalTs) return false;
    let valid = !this.committer.changedBetween(r.reads, r.tokenTs, ts);
    if (valid && r.observedTime) valid = Math.abs((this.opts.cacheClock ?? wallClock)() - r.unixMs) <= MAX_CACHE_AGE_MS;
    if (!valid) this.cache.removeReady(key, r.originalTs);
    // A hit moves the entry's token to `ts`, so the next check only walks the commits after it: what
    // Convex's step 4 says a hit does ("this will bump the cache result's token"), though its guard only
    // writes back a fresh run's result (STUDY-08 §1.1). Not observable: the result is the same.
    else if (r.tokenTs < ts) r.tokenTs = ts;
    return valid;
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
          onVisible: this.withPendingCheck(tx),
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

/** UDF_CACHE_MAX_SIZE (bytes), as Convex's knob, else its default. */
function cacheMaxBytesFromEnv(): number {
  const n = Number(process.env.UDF_CACHE_MAX_SIZE);
  return Number.isFinite(n) && n > 0 ? n : QUERY_CACHE_MAX_BYTES;
}

async function readCatalog(db: Tx) {
  return {
    tables: (await db.query(TABLES_TABLE).collect()) as unknown as TableMeta[],
    indexes: (await db.query(INDEX_TABLE).collect()) as unknown as IndexMeta[],
  };
}

/**
 * The `_instance` record (the instance secret and name, the deployment's settings) read straight from a
 * store at its latest commit, without the lease and without writing: what `bunvex admin-key` needs while
 * the server holds the store (STUDY-34, DV-160). Null when the store has none yet.
 */
export async function readInstanceRecord(persistence: Persistence): Promise<Record<string, unknown> | null> {
  return (await readSystemRows(persistence, INSTANCE_TABLE))[0] ?? null;
}

/** Every row of a system table, read at the store's latest commit without the lease or a write. */
export async function readSystemRows(persistence: Persistence, table: string): Promise<Record<string, unknown>[]> {
  const ts = (await persistence.maxTs?.()) ?? 0;
  const read = (catalog: Catalog) => new Tx(catalog, persistence, ts, false, wallClock(), true);
  const { tables, indexes } = await readCatalog(read(bootstrapCatalog()));
  if (!tables.some((t) => t.name === table)) return [];
  return (await read(buildCatalog(tables, indexes)).query(table).collect()) as Record<string, unknown>[];
}

/** Schema enforcement (STUDY-14): each declared table's validator, with the system fields added. */
function validatorsOf(schema: SchemaDefinition): Map<string, GenericValidator> {
  const out = new Map<string, GenericValidator>();
  if (schema.schemaValidation)
    for (const t of schema.tables.values()) {
      const dv = documentValidator(t.name, t.document);
      if (dv) out.set(t.name, dv);
    }
  return out;
}

/** A push's schema change that cannot finish (Convex's `RaceDetected`, or indexes not ready). */
export class SchemaPushError extends Error {
  constructor(
    readonly code: "RaceDetected" | "SchemaNotReady",
    message: string,
  ) {
    super(message);
    this.name = "SchemaPushError";
  }
}

/** Drop the backfill checkpoint of a dropped index, if it has one. */
async function deleteBackfillProgress(db: Tx, indexMetaId: string) {
  const p = (await db
    .query(INDEX_BACKFILLS_TABLE)
    .withIndex(INDEX_BACKFILLS_INDEX, (q) => q.eq("indexId", indexMetaId))
    .first()) as unknown as IndexBackfillMeta | null;
  if (p) await db.delete(INDEX_BACKFILLS_TABLE, p._id);
}

// The engine: runs transactions against a snapshot, retries mutations on conflict, and caches query
// results by read-set. It executes ANONYMOUS transaction bodies (`db => …`); naming, registering and
// exposing functions is the server's job (@bunvex/server).

import { hostname } from "node:os";
import {
  checkValue,
  fromJsonValue,
  type GenericValidator,
  hasCommitTs,
  resolveCommitTs,
  toJsonValue,
  type Value,
  v,
} from "@bunvex/values";
import { BackendStateCache } from "./backend-state.ts";
import {
  AUTH_TABLE,
  activeTables,
  BACKEND_STATE_TABLE,
  bootstrapCatalog,
  buildCatalog,
  CANONICAL_URLS_TABLE,
  type Catalog,
  CRON_JOB_LOGS_TABLE,
  CRON_JOBS_TABLE,
  CRON_NEXT_RUN_TABLE,
  DATA_SYNC_PROGRESS_TABLE,
  DATABASE_GLOBALS_TABLE,
  DEPLOYMENT_AUDIT_LOG_TABLE,
  databaseIndexRows,
  ENVIRONMENT_VARIABLES_TABLE,
  EXPORTS_TABLE,
  FILE_STORAGE_TABLE,
  FUNCTION_HANDLES_TABLE,
  finishCatalog,
  hasChanges,
  hasFinishChanges,
  INDEX_BACKFILLS_INDEX,
  INDEX_BACKFILLS_TABLE,
  INDEX_TABLE,
  INDEX_WORKER_METADATA_INDEX,
  INDEX_WORKER_METADATA_TABLE,
  INSTANCE_TABLE,
  IndexBackfillingError,
  type IndexBackfillMeta,
  type IndexMeta,
  IndexStagedError,
  indexTooLarge,
  LOG_SINKS_TABLE,
  MODULES_TABLE,
  NEXT_PERSISTENCE_INDEX_ID_TABLE,
  NEXT_TABLET_ID_TABLE,
  planCatalog,
  SCHEDULED_JOB_ARGS_TABLE,
  SCHEDULED_JOBS_TABLE,
  SCHEMA_VALIDATION_PROGRESS_TABLE,
  SCHEMA_VALIDATIONS_TABLE,
  SCHEMAS_TABLE,
  SESSION_REQUESTS_TABLE,
  SNAPSHOT_IMPORTS_TABLE,
  SOURCE_PACKAGES_TABLE,
  TABLES_TABLE,
  type TableMeta,
  UDF_CONFIG_TABLE,
  USAGE_LIMITS_TABLE,
  vectorIndexesUnavailable,
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
import type { CursorCodec } from "./cursor.ts";
import {
  DATABASE_VERSION,
  initializeDatabaseGlobals,
  initializeStorageType,
  type StorageTagInitializer,
  type StorageType,
} from "./database-globals.ts";
import {
  type ExecutionKind,
  installDeterminism,
  nextUp,
  type Observed,
  outsideExecution,
  preciseClock,
  runDeterministic,
  settled,
  wallClock,
} from "./determinism.ts";
import { EnvironmentVariables } from "./environment-variables.ts";
import { readNextIndexId, writeNextIndexId } from "./index-ids.ts";
import { INDEX_BACKFILL_DEFAULTS, type IndexBackfillOptions, IndexWorker } from "./index-worker.ts";
import { opaqueToInspect } from "./inspect.ts";
import { instanceSecretBytes, kbkdfCtrHmacSha256 } from "./kbkdf.ts";
import {
  hasLease,
  hasRetention,
  type Lease,
  LeaseHeldError,
  LeaseLostError,
  type Persistence,
} from "./persistence/index.ts";
import {
  type CachedResult,
  MAX_CACHE_AGE_MS,
  type MissReason,
  QUERY_CACHE_MAX_BYTES,
  QueryCache,
} from "./query-cache.ts";
import { Retention, type RetentionOptions } from "./retention.ts";
import { type Runtime, realRuntime } from "./runtime.ts";
import { SCHEDULED_JOBS_INDEXES } from "./scheduled-jobs.ts";
import {
  type DeclaredTable,
  type Doc,
  documentValidator,
  MAX_VECTOR_DIMENSIONS,
  referencedTables,
  type SchemaDefinition,
  SYSTEM_INDEXES,
  type TableDef,
} from "./schema.ts";
import { type SchemaJson, schemaFromJson, schemaKey, schemaToJson } from "./schema-json.ts";
import {
  deleteValidationsForSchema,
  markValidationValid,
  progressThreshold,
  recordValidationProgress,
  resetSchemaValidations,
  startTableValidation,
} from "./schema-validations.ts";
import { filterKey, indexedDoc, indexedDocBytes, type SearchIndexEntry, SearchIndexes } from "./search-indexes.ts";
import {
  canPersistSegments,
  changedSince,
  type IndexRowWrite,
  type IndexSegmentsState,
  isSearchIndexRow,
  rowToState,
  type SearchCompactionConfig,
  type SearchSegmentLimits,
  type SearchSegmentStore,
  SearchSegmentsState,
  type SearchWorkerOptions,
  SegmentReplay,
  sameSpec,
  searchCompactionFromEnv,
  searchSegmentLimitsFromEnv,
  searchWorkersFromEnv,
  segmentRefs,
  segmentsToCompact,
  stateKey,
} from "./search-segments.ts";
import {
  deleteSessionRequestsBefore,
  findSessionRequest,
  recordSessionRequest,
  SESSION_CLEANUP_CHUNK,
  SESSION_REQUESTS_INDEX,
  type SessionRequestId,
  type SessionRequestOutcome,
} from "./session-requests.ts";
import { TableSummaries, TableSummariesUnavailableError } from "./table-summaries.ts";
import {
  canCheckpoint,
  restoreSummaries,
  SummaryCheckpointer,
  type SummaryCheckpointOptions,
} from "./table-summary-checkpoint.ts";
import { readNextTablet, writeNextTablet } from "./tablet-ids.ts";
import { CommitSpans, IndexReadSpans, NO_TRACER, type Tracer } from "./tracing.ts";
import { decodeDoc, Tx } from "./tx.ts";
import {
  DEFAULT_VECTOR_LIMIT,
  MAX_VECTOR_FILTER_CONDITIONS,
  MAX_VECTOR_RESULTS,
  type VectorFilter,
  type VectorIndexEntry,
  VectorIndexes,
  vectorEntry,
} from "./vector-indexes.ts";
import { TooManyWritesError, WriteThroughputLimiter, type WriteThroughputOptions } from "./write-throughput.ts";

/** A shuffled copy of `xs` (the compactor picks among candidates at random, as Convex's). */
function shuffled<T>(xs: T[]): T[] {
  const out = [...xs];
  const r = outsideExecution(() => crypto.getRandomValues(new Uint32Array(out.length)));
  for (let i = out.length - 1; i > 0; i--) {
    const j = r[i]! % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

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
  /**
   * What the lost attempt returned (its commit-ts placeholders unresolved): Convex logs an attempt that will
   * retry before it fails it, so its `function_returns_bytes` is that value's (STUDY-74).
   */
  attempt?: { value: unknown };
  constructor(
    message: string,
    /** `retries`: how many times the mutation had already been re-run. */
    readonly info: { table?: string; documentId?: string; writeSource?: string; writeTs: number; retries: number },
  ) {
    super(message);
  }
}

/**
 * Who runs a transaction (STUDY-27): the server's identity object, opaque to the engine, and a stable string
 * of it. A cached query result is keyed by that string only if the run read the identity, as Convex's query
 * cache (`observed_identity`, crates/application/src/cache/mod.rs); otherwise it serves every caller.
 */
/**
 * The request a call comes from (STUDY-44, Convex's `RequestMetadata` and execution context), for
 * `ctx.meta.getRequestMetadata()`: passed down to the functions it calls.
 */
export type CallRequest = {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
  /** The user's raw token; null for an admin key or none. */
  authToken: string | null;
  /** The scheduled function this execution belongs to, if any. */
  scheduledFunctionId: string | null;
};
export type Caller = { identity: unknown; key: string; request?: CallRequest };
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

/** Documents a deletion-worker transaction removes (Convex deletes tables in batches too). */
export const TABLE_DELETION_BATCH = 1000;

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
  /** The last transaction's first `_creationTime` (see `transactionStart`). */
  private lastStart = 0;
  /** The last transaction begun: its creation cursor bounds the next start. */
  private lastTx: Tx | null = null;
  /** The deployment's run state, as every user function checks it (STUDY-63). */
  readonly backendState: BackendStateCache;
  /** The search indexes of the active tables, in memory (STUDY-45 S1). */
  readonly searchIndexes = new SearchIndexes();
  /** Each table's count, size and shape (STUDY-52 PR 2), kept by every commit; built on start. */
  readonly tableSummaries = new TableSummaries();
  private summariesBuild: Promise<void> | null = null;
  /** Vector indexes (STUDY-51): exact, in memory. */
  readonly vectorIndexes = new VectorIndexes();
  private searchBackfills = new Set<Promise<void>>();
  /**
   * `cacheHits` counts answers from the cache, including the ones that waited for another caller's run;
   * `cacheWaits` counts the waits; `cacheMisses` counts the runs.
   */
  stats = { cacheHits: 0, cacheMisses: 0, cacheWaits: 0, retries: 0, writeThroughputRetries: 0 };
  /** The deployment's write throughput limit (STUDY-78): every commit counts, gated writers check it. */
  readonly writeThroughput: WriteThroughputLimiter;
  /**
   * Called when a mutation attempt lost an OCC conflict and will run again (`failures`: the attempts lost so
   * far), in the mutation's own async context: the server logs each such attempt, as Convex's
   * `log_mutation_occ_error` with `will_retry` (STUDY-47).
   */
  onOccRetry: ((error: OccError, failures: number) => void) | null = null;
  /** The clock and timers (STUDY-132): `opts.runtime`, else the process's. */
  readonly runtime: Runtime;

  private tracerOf: Tracer = NO_TRACER;
  /**
   * Where spans go (STUDY-131 AD-26): `NO_TRACER` unless the server configured an exporter. A traced
   * transaction reports its index reads under the current span, and a traced mutation its commit.
   */
  get tracer(): Tracer {
    return this.tracerOf;
  }
  set tracer(t: Tracer) {
    this.tracerOf = t;
    this.committer.traced = t.on;
  }

  /** The index reads of a transaction run under the current span, if one is current. */
  private indexSpansOf(tx: Tx) {
    const parent = this.tracerOf.current();
    if (parent) tx.indexSpans = new IndexReadSpans(parent);
  }

  constructor(
    /** The declared schema: the constructor's, the stored one (`storedSchema`), or the last pushed. */
    public schema: SchemaDefinition,
    readonly persistence: Persistence,
    private opts: {
      /**
       * The clock and timers the engine and the server on it use (STUDY-132): the process's own by default; a
       * test passes a `TestRuntime` (`@bunvex/core/test-runtime`) to move the time itself.
       */
      runtime?: Runtime;
      /** The query cache's byte budget (default: UDF_CACHE_MAX_SIZE from the environment, else 100 MiB). */
      cacheMaxBytes?: number;
      /** The wall clock (ms) the query cache ages results that read the clock by; tests move it. */
      cacheClock?: () => number;
      /** Awaited before each page a search or vector index's backfill reads (tests hold the backfill with it). */
      beforeSearchBackfillPage?: () => Promise<void>;
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
      /** Table summary checkpoints' knobs (STUDY-72); `false`: none, the summaries scanned on every start. */
      summaryCheckpoints?: SummaryCheckpointOptions | false;
      /**
       * Where the search and vector indexes' segments are kept (the `search` blob use case, STUDY-111): flushed
       * as their memory parts grow and at a clean shutdown, loaded at start with the log since. None: the
       * indexes are in memory only, read from their tables at every start.
       */
      searchStorage?: SearchSegmentStore;
      /** The memory parts' flush thresholds (default: SEARCH_INDEX_SIZE_SOFT_LIMIT / VECTOR_INDEX_SIZE_SOFT_LIMIT). */
      searchSegmentLimits?: Partial<SearchSegmentLimits>;
      /** The compactor's thresholds (default: Convex's, from MIN_COMPACTION_SEGMENTS and the others). */
      searchCompaction?: Partial<SearchCompactionConfig>;
      /** The search index workers' pacing (default: Convex's knobs from the environment). */
      searchWorkers?: Partial<SearchWorkerOptions>;
      /** Awaited between a compaction's build and its commit (tests interleave flushes there). */
      beforeSearchCompactionCommit?: () => Promise<void>;
      /** The background index backfill's knobs (Convex's INDEX_BACKFILL_*; STUDY-29). */
      indexBackfill?: IndexBackfillOptions;
      /**
       * How a flush that failed with a transient error is retried (STUDY-25 L4): Convex's backoff, 100 ms
       * doubling up to 10 s with full jitter, as many times as it takes (the lease bounds it).
       */
      flushRetry?: FlushRetryOptions;
      /** The soft caps on what one flush carries (default: Convex's 64 documents / 64 KiB; DV-62). */
      writeBatch?: Partial<WriteBatchLimits>;
      /**
       * The write throughput limit (STUDY-78; default: MAX_BYTES_WRITTEN_PER_SECOND and WRITE_THROUGHPUT_WINDOW
       * from the environment, else Convex's 4 MiB per 1 s).
       */
      writeThroughput?: WriteThroughputOptions;
    } = {},
  ) {
    this.runtime = opts.runtime ?? realRuntime;
    installDeterminism();
    this.installValidators(schema);
    this.committer = new Committer(persistence, opts.writeLogRetention, undefined, opts.flushRetry, opts.writeBatch);
    this.cache = new QueryCache(opts.cacheMaxBytes ?? cacheMaxBytesFromEnv());
    this.writeThroughput = new WriteThroughputLimiter(opts.writeThroughput ?? writeThroughputFromEnv());
    this.committer.writeThroughput = this.writeThroughput;
    // A count at an older snapshot (STUDY-107) needs the changes since: kept as long as the write log keeps them.
    this.tableSummaries.retainedAfter = () => this.committer.logStartTs;
    // The table exists once `init()` reconciled the catalog; before that, no commit can write it (-1).
    const backendStateTable = () => this.catalog.tables.get(BACKEND_STATE_TABLE);
    this.backendState = new BackendStateCache(() => backendStateTable()?.byId.id ?? -1);
    this.committer.onCommit((entries) => this.backendState.observe(entries), "backend state");
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
  private env: EnvironmentVariables | null = null;
  /** The deployment's environment variables (STUDY-37). */
  get environment(): EnvironmentVariables {
    this.env ??= new EnvironmentVariables(() => this.catalog, this.committer);
    return this.env;
  }

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
    // The search and vector indexes of the schema the process starts on existed before it: each loads its
    // segments and replays the log since (STUDY-111), or is read from its table, and searches meanwhile are
    // Convex's bootstrapping answer (STUDY-79).
    await this.loadSearchSegments();
    this.reconcileSearch(true);
    this.reconcileVector(true);
    this.startSearchWorkers();
    // The log since the segments is held only while the indexes it restores are being built.
    void Promise.allSettled([...this.searchBackfills]).then(() => {
      this.segmentReplay = null;
    });
    await this.loadInstanceSecret();
    await this.loadInstanceName();
    await this.loadDatabaseGlobals();
    if (this.opts.storedSchema) await this.resumePendingSchema();
    // The worker belongs to the process that holds the lease: the one that writes (STUDY-24 §4.6).
    if (backfilling) this.startIndexWorker();
    // Tables left being deleted by an earlier run (STUDY-42).
    this.startTableDeletion();
    this.summariesBuild = this.buildSummaries().catch((err) => {
      if (!this.closed) console.error(`bunvex: table summaries failed to build: ${err.message}`);
    });
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
  private closed = false;

  async close() {
    this.closed = true;
    await this.deleting?.catch(() => {});
    await this.indexWorker?.stop();
    await this.retention?.stop();
    await this.summaryCheckpointer?.stop();
    this.settleReady(new Error("the engine closed before its indexes were ready"));
    await this.committer.idle();
    if (this.workerTimer) clearInterval(this.workerTimer);
    // A compaction in progress stops; then every index is flushed.
    await Promise.allSettled([...this.compacting.values()]);
    await this.flushSearchSegments();
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
   * The database's globals (`_db`, STUDY-126), written at the store's first start as Convex's bootstrap
   * does. A version above this bunvex's is warned about, as Convex's migration worker does.
   */
  private async loadDatabaseGlobals() {
    const uuid = outsideExecution(() => crypto.randomUUID());
    const version = await this.runMutation((db) => initializeDatabaseGlobals(db, () => uuid), true);
    if (version > DATABASE_VERSION)
      console.warn(`persisted db metadata version is ahead at ${version}, this binary is at ${DATABASE_VERSION}`);
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

  private cursorCodecCache: CursorCodec | null = null;
  /** Pagination cursors' key (`derivedKey("cursor")`, as Convex's keybroker) and the instance they name. */
  private readonly cursorCodecOf = (): CursorCodec => this.cursorCodec;
  get cursorCodec(): CursorCodec {
    const c = this.cursorCodecCache;
    if (c && c.instanceName === this.instanceName) return c;
    this.cursorCodecCache = { key: this.derivedKey("cursor"), instanceName: this.instanceName };
    return this.cursorCodecCache;
  }

  /**
   * The storage this start uses, checked against the one the store was initialized with (STUDY-126, Convex's
   * `initialize_storage_tag`): the first start records it; S3's key prefix is `<instance name>-<uuid>/`.
   * Throws when the store was initialized with another kind of storage.
   */
  async initializeStorage(init: StorageTagInitializer): Promise<StorageType> {
    const uuid = outsideExecution(() => crypto.randomUUID());
    return this.runMutation(
      (db) => initializeStorageType(db, init, this.instanceName, () => uuid),
      true,
      "init_storage",
    );
  }

  /** Every table the engine declares: its own system tables, then the schema's. */
  private declaredTables(schema: SchemaDefinition = this.schema): DeclaredTable[] {
    const systemTables: DeclaredTable[] = [
      { name: INSTANCE_TABLE, indexes: {}, document: v.any() },
      { name: NEXT_TABLET_ID_TABLE, indexes: {}, document: v.any() },
      { name: DATABASE_GLOBALS_TABLE, indexes: {}, document: v.any() },
      {
        name: SESSION_REQUESTS_TABLE,
        indexes: { [SESSION_REQUESTS_INDEX]: ["sessionId", "requestId"] },
        document: v.any(),
      },
      { name: INDEX_BACKFILLS_TABLE, indexes: { [INDEX_BACKFILLS_INDEX]: ["indexId"] }, document: v.any() },
      { name: SCHEDULED_JOBS_TABLE, indexes: SCHEDULED_JOBS_INDEXES, document: v.any() },
      { name: SCHEDULED_JOB_ARGS_TABLE, indexes: {}, document: v.any() },
      {
        name: INDEX_WORKER_METADATA_TABLE,
        indexes: { [INDEX_WORKER_METADATA_INDEX]: ["index_id"] },
        document: v.any(),
      },
      { name: NEXT_PERSISTENCE_INDEX_ID_TABLE, indexes: {}, document: v.any() },
      { name: CRON_JOBS_TABLE, indexes: { by_name: ["name"] }, document: v.any() },
      {
        name: CRON_NEXT_RUN_TABLE,
        indexes: { by_cron_job_id: ["cronJobId"], by_next_ts: ["nextTs"] },
        document: v.any(),
      },
      { name: CRON_JOB_LOGS_TABLE, indexes: { by_name_and_ts: ["name", "ts"] }, document: v.any() },
      { name: FILE_STORAGE_TABLE, indexes: { by_storage_id: ["storageId"] }, document: v.any() },
      { name: MODULES_TABLE, indexes: { by_path: ["path"] }, document: v.any() },
      { name: SOURCE_PACKAGES_TABLE, indexes: {}, document: v.any() },
      { name: UDF_CONFIG_TABLE, indexes: {}, document: v.any() },
      { name: SCHEMAS_TABLE, indexes: {}, document: v.any() },
      {
        name: SCHEMA_VALIDATIONS_TABLE,
        indexes: { by_schema_id_and_table_name: ["schemaId", "tableName"] },
        document: v.any(),
      },
      { name: SCHEMA_VALIDATION_PROGRESS_TABLE, indexes: { by_validation_id: ["validationId"] }, document: v.any() },
      { name: ENVIRONMENT_VARIABLES_TABLE, indexes: { by_name: ["name"] }, document: v.any() },
      { name: AUTH_TABLE, indexes: {}, document: v.any() },
      {
        name: EXPORTS_TABLE,
        indexes: { by_state_and_ts: ["state", "start_ts"], by_requestor: ["requestor", "_creationTime"] },
        document: v.any(),
      },
      { name: SNAPSHOT_IMPORTS_TABLE, indexes: {}, document: v.any() },
      { name: LOG_SINKS_TABLE, indexes: {}, document: v.any() },
      { name: BACKEND_STATE_TABLE, indexes: {}, document: v.any() },
      { name: CANONICAL_URLS_TABLE, indexes: {}, document: v.any() },
      {
        name: DEPLOYMENT_AUDIT_LOG_TABLE,
        indexes: { by_action_and_creation_time: ["action", "_creationTime"] },
        document: v.any(),
      },
      { name: FUNCTION_HANDLES_TABLE, indexes: { by_component_path: ["component", "path"] }, document: v.any() },
      {
        name: DATA_SYNC_PROGRESS_TABLE,
        indexes: {
          by_sync_id: ["syncId", "_creationTime"],
          by_last_updated: ["lastUpdatedMs", "_creationTime"],
        },
        document: v.any(),
      },
      {
        name: USAGE_LIMITS_TABLE,
        indexes: { by_selector: ["metric", "window", "limitType", "_creationTime"] },
        document: v.any(),
      },
    ];
    return [...systemTables, ...schema.tables.values()];
  }

  /**
   * Start the schema change (Convex's `start_push` / `prepare_new_and_mutated_indexes`): create missing
   * tables, add new indexes as `backfilling`, drop pending indexes no longer declared. If nothing is left to
   * backfill, finish it at once; otherwise the worker does once it is. Whether anything is backfilling.
   */
  private async reconcileCatalog(): Promise<boolean> {
    // The stored catalog first, so the change below sees the system tables it reads (the tablet and index id
    // allocators).
    const stored = await this.runMutation((db) => readCatalog(db), true);
    this.catalog = buildCatalog(stored.tables, stored.indexes);
    const { tables, indexes } = await this.runMutation(async (db) => {
      const current = await readCatalog(db);
      const changes = planCatalog(
        this.declaredTables(),
        current.tables,
        current.indexes,
        true,
        current.nextIndexId,
        current.nextTablet,
      );
      if (!hasChanges(changes)) return current;
      for (const t of changes.insertTables) await db.insert(TABLES_TABLE, t);
      await writeNextTablet(db, changes.nextTablet);
      for (const id of changes.deleteIndexes) {
        await db.delete(INDEX_TABLE, id);
        await deleteBackfillProgress(db, id);
      }
      for (const r of changes.restageIndexes) await db.patch(INDEX_TABLE, r._id, { staged: r.staged });
      for (const i of changes.insertIndexes) await db.insert(INDEX_TABLE, i);
      await writeNextIndexId(db, changes.nextIndexId);
      return readCatalog(db); // read-your-own-writes: the catalog as this commit leaves it
    }, true);
    this.catalog = buildCatalog(tables, indexes);
    // The store's first start created the allocator's table in that commit: its counter is written now, with
    // the tablets and the index ids that commit took (Convex writes its index id allocator in its bootstrap).
    await this.runMutation(async (db) => {
      if ((await readNextTablet(db)) === undefined)
        await writeNextTablet(db, Math.max(0, ...tables.map((t) => t.tablet)) + 1);
      if ((await readNextIndexId(db)) === undefined)
        await writeNextIndexId(db, Math.max(0, ...indexes.map((i) => i.indexId)) + 1);
    }, true);
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

  /** A commit's search part (STUDY-45 PR 3): its searches to check, its versions and their read-set keys. */
  private searchCommit(tx: Tx, own: ((ts: number) => void) | undefined) {
    const writes = tx.writtenDocs();
    const { docs, keys, indexed } = this.searchIndexes.commitWrites(writes);
    // A commit timestamp (STUDY-53) is written into the documents at `atTs`, after this commit is built: the
    // indexes then take the resolved versions. The OCC and log keys above keep the placeholder's, which no
    // search can name before the commit has its timestamp.
    const resolvesLater = tx.hasCommitTs;
    return {
      // The search indexes are brought up to date with the commit as it becomes visible, in commit order.
      onVisible: (ts: number) => {
        own?.(ts);
        const final = resolvesLater ? tx.writtenDocs() : writes;
        this.searchIndexes.apply(ts, final, resolvesLater ? this.searchIndexes.commitWrites(final).indexed : indexed);
        this.vectorIndexes.apply(ts, final);
        this.flushFull(final);
        this.tableSummaries.apply(
          ts,
          final.map((w) => ({ tablet: w.table.id, old: w.old, next: w.next })),
        );
      },
      ...(tx.searchReads.length ? { searchReads: tx.searchReads } : {}),
      ...(docs.length ? { searchDocs: docs, logExtra: keys } : {}),
    };
  }

  /**
   * Make the search indexes the active schema's (STUDY-45): after the schema or the tables change. A new
   * index is backfilled from its table at one snapshot; commits meanwhile are applied as they land.
   */
  private reconcileSearch(bootstrapping = false) {
    const wanted = [];
    for (const [name, declared] of this.schema.tables) {
      const t = this.catalog.tables.get(name);
      if (!t || !declared.searchIndexes) continue;
      const staged = new Set(declared.stagedSearch ?? []);
      for (const [index, def] of Object.entries(declared.searchIndexes))
        wanted.push({ table: t, name: index, def, staged: staged.has(index) });
    }
    for (const e of this.searchIndexes.reconcile(wanted, this.committer.visibleTs, bootstrapping)) {
      const p = this.backfillSearch(e).catch((err) => {
        if (!this.closed) console.error(`bunvex: search index ${e.table}.${e.name} failed to build: ${err.message}`);
      });
      this.searchBackfills.add(p);
      void p.finally(() => this.searchBackfills.delete(p));
    }
    this.scheduleIndexRowsSync();
  }

  /** Make the vector indexes the active schema's (STUDY-51), as `reconcileSearch` does for search ones. */
  private reconcileVector(bootstrapping = false) {
    const wanted = [];
    for (const [name, declared] of this.schema.tables) {
      const t = this.catalog.tables.get(name);
      if (!t || !declared.vectorIndexes) continue;
      const staged = new Set(declared.stagedVector ?? []);
      for (const [index, def] of Object.entries(declared.vectorIndexes))
        wanted.push({ table: t, name: index, def, staged: staged.has(index) });
    }
    for (const e of this.vectorIndexes.reconcile(wanted, bootstrapping)) {
      const p = this.backfillVector(e).catch((err) => {
        if (!this.closed) console.error(`bunvex: vector index ${e.table}.${e.name} failed to build: ${err.message}`);
      });
      this.searchBackfills.add(p);
      void p.finally(() => this.searchBackfills.delete(p));
    }
    this.scheduleIndexRowsSync();
  }

  private get compactionConfig(): SearchCompactionConfig {
    this.compaction ??= { ...searchCompactionFromEnv(), ...this.opts.searchCompaction };
    return this.compaction;
  }
  private compaction: SearchCompactionConfig | null = null;

  /** What the search and vector indexes' segments did since the start (tests and measurements). */
  readonly searchStats = {
    fromSegments: 0,
    replayed: 0,
    flushes: 0,
    backfillSteps: 0,
    compactions: 0,
    fastForwards: 0,
    backfilled: 0,
    resumed: 0,
  };

  /** Wait until no index is being flushed (tests). */
  async searchFlushed() {
    while (this.flushing.size) await Promise.allSettled([...this.flushing.values()]);
  }

  /**
   * The search and vector indexes' `_index` rows (STUDY-111): kept for every such index, as Convex's. With a
   * segment store and a persistence that has the document log, `searchSegments` is the same, and segments are
   * persisted; otherwise null, and every index is read from its table at each start.
   */
  private indexRows: SearchSegmentsState | null = null;
  private searchSegments: SearchSegmentsState | null = null;
  /** The log since the segments' ts, read once per table while the indexes are restored at a start. */
  private segmentReplay: SegmentReplay | null = null;
  private limits: SearchSegmentLimits | null = null;
  private get segmentLimits(): SearchSegmentLimits {
    this.limits ??= { ...searchSegmentLimitsFromEnv(), ...this.opts.searchSegmentLimits };
    return this.limits;
  }
  /** Each index's flush in progress, and the indexes to flush again once it is done. */
  private flushing = new Map<SearchIndexEntry | VectorIndexEntry, Promise<void>>();
  private flushAgain = new Set<SearchIndexEntry | VectorIndexEntry>();

  /** Reads the segments' state at start (STUDY-111): what each index restores from. */
  private async loadSearchSegments() {
    const p = this.persistence;
    const store = canPersistSegments(p) ? p : null;
    const blobs = store ? (this.opts.searchStorage ?? null) : null;
    const state = new SearchSegmentsState(store, blobs, (writes) => this.writeIndexRows(writes));
    state.load(
      await this.runMutation((db) => db.query(INDEX_TABLE).collect() as Promise<Record<string, unknown>[]>, true),
    );
    state.loadForwarded(
      await this.runMutation(
        (db) => db.query(INDEX_WORKER_METADATA_TABLE).collect() as Promise<Record<string, unknown>[]>,
        true,
      ),
    );
    this.indexRows = state;
    if (!store || !blobs) return;
    this.searchSegments = state;
    // Each table's log is read once, from the oldest ts any of its indexes starts from.
    const oldest = new Map<number, number>();
    for (const s of state.all()) {
      const ts = state.currentTs(s);
      oldest.set(s.tablet, Math.min(oldest.get(s.tablet) ?? ts, ts));
    }
    this.segmentReplay = new SegmentReplay(store, this.committer.visibleTs, decodeDoc, oldest);
  }

  /** The search index workers' pacing. */
  private get workers(): SearchWorkerOptions {
    return { ...searchWorkersFromEnv(), ...this.opts.searchWorkers };
  }
  private workerTimer: ReturnType<typeof setInterval> | null = null;
  /** Commits since the start, and at the last fast-forward (Convex's `write_commits_since_load`). */
  private commitsSeen = 0;
  private lastForward: { at: number; commits: number } | null = null;

  /**
   * Convex's search index workers' periodic part (STUDY-111 PR 7): every poll interval, the `TooOld` flush of a
   * ready index whose memory part is not empty and whose ts is `SEARCH_WORKERS_MAX_CHECKPOINT_AGE` old, then the
   * fast-forward of the ready indexes with nothing in their memory part (`fast_forward.rs`): their
   * `_index_worker_metadata` row's `fast_forward_ts` moves to now, so a start replays nothing older and retention
   * never overtakes an idle index. Debounced as Convex's: after the first time, only once
   * DATABASE_WORKERS_MIN_COMMITS commits or the checkpoint age have passed.
   */
  private startSearchWorkers() {
    if (!this.searchSegments || this.workerTimer) return;
    this.committer.onCommit((entries) => {
      this.commitsSeen += entries.length;
    }, "search workers");
    this.workerTimer = setInterval(() => {
      void this.searchWorkersTick().catch((err) => {
        if (!this.closed) console.error(`bunvex: search index workers failed: ${err.message}`);
      });
    }, this.workers.pollIntervalMs);
    this.workerTimer.unref?.();
  }

  /** One pass of the search index workers (tests call it directly). */
  async searchWorkersTick(atShutdown = false) {
    const state = this.searchSegments;
    if (!state || (this.closed && !atShutdown) || this.committer.stopped) return;
    const w = this.workers;
    const now = this.committer.visibleTs;
    const all = [
      ...this.searchIndexes.all().map((e) => ["text", e] as const),
      ...this.vectorIndexes.all().map((e) => ["vector", e] as const),
    ];
    // TooOld: a memory part with writes older than the checkpoint age is flushed.
    for (const [kind, e] of all) {
      const s = state.get(kind, e.tablet, e.name);
      if (!e.ready || e.staged || !s || !e.index.changed.size) continue;
      if (now - state.currentTs(s) >= w.maxCheckpointAgeMs * 1000) this.scheduleFlush(kind, e);
    }
    // Fast-forward, debounced.
    const last = this.lastForward;
    if (
      !atShutdown &&
      last &&
      this.commitsSeen - last.commits < w.minCommits &&
      Date.now() - last.at < w.maxCheckpointAgeMs
    )
      return;
    const idle = all
      .filter(([kind, e]) => {
        const s = state.get(kind, e.tablet, e.name);
        return (
          e.ready &&
          !e.staged &&
          s &&
          !s.backfill &&
          !e.index.changed.size &&
          !e.index.segments.some((p) => p.version !== p.persisted) &&
          state.currentTs(s) < now
        );
      })
      .map(([kind, e]) => stateKey(kind, e.tablet, e.name));
    this.lastForward = { at: Date.now(), commits: this.commitsSeen };
    if (!idle.length) return;
    const { writes, done } = state.forward(idle, now);
    const ids = await this.runMutation(async (db) => {
      const out: (string | undefined)[] = [];
      for (const x of writes) {
        const row = {
          index_id: x.index_id,
          index_metadata: { metadata_type: x.metadata_type, metadata: { fast_forward_ts: now } },
        };
        if (x._id) {
          await db.patch(INDEX_WORKER_METADATA_TABLE, x._id, row);
          out.push(undefined);
        } else out.push((await db.insert(INDEX_WORKER_METADATA_TABLE, row)) as string);
      }
      return out;
    }, true);
    done(ids);
    this.searchStats.fastForwards += idle.length;
  }

  /** Writes search and vector indexes' `_index` rows, in one system transaction; the inserted rows' ids. */
  private writeIndexRows(writes: IndexRowWrite[]): Promise<string[]> {
    return this.runMutation(async (db) => {
      const ids: string[] = [];
      for (const w of writes)
        if (w._id === undefined) ids.push((await db.insert(INDEX_TABLE, w.row!)) as string);
        else if (w.row) await db.patch(INDEX_TABLE, w._id, { config: w.row.config });
        else await db.delete(INDEX_TABLE, w._id);
      return ids;
    }, true);
  }

  /** Stores a new segment and its (empty) deletes, as Convex stores every segment with its deletes files. */
  private async storeSegment(kind: "text" | "vector", e: SearchIndexEntry | VectorIndexEntry, bytes: Uint8Array) {
    const blobs = this.searchSegments!.blobs!;
    const { segment, deletes } = (e.index as SearchIndexEntry["index"]).describe(bytes) as unknown as {
      segment: { numDocs: number; uid: string };
      deletes: Uint8Array;
    };
    const [segmentKey, deletesKey] = await Promise.all([blobs.put(bytes), blobs.put(deletes)]);
    return {
      keys: { segment: segmentKey, deletes: deletesKey },
      ref: {
        segment: segmentKey,
        deletes: deletesKey,
        docs: segment.numDocs,
        deleted: 0,
        bytes: this.segmentSize(kind, e)(segment),
        id: segment.uid,
      },
    };
  }

  /** The bytes a segment counts for (Convex's `size_bytes_total`, or vectors × dimensions × 4). */
  private segmentSize(kind: "text" | "vector", e: SearchIndexEntry | VectorIndexEntry) {
    const dims = kind === "vector" ? (e.def as { dimensions: number }).dimensions : 0;
    return (segment: { numDocs: number; uid: string }) =>
      kind === "text" ? (segment as unknown as { bytes: Uint8Array }).bytes.length : segment.numDocs * dims * 4;
  }

  /**
   * A bootstrapping index from its stored segments and the log since their ts (Convex's bootstrap, STUDY-111);
   * false when there are none it can trust (the index is then built another way).
   */
  private async restoreFromSegments<Doc>(
    kind: "text" | "vector",
    e: SearchIndexEntry | VectorIndexEntry,
    load: (parts: NonNullable<Awaited<ReturnType<SearchSegmentsState["fetch"]>>>) => void,
    replay: (id: string, doc: Doc | null) => void,
  ): Promise<boolean> {
    const state = this.searchSegments;
    const log = this.segmentReplay;
    if (!state || !log || !e.bootstrapping) return false;
    try {
      const s = await state.usable(kind, e.tablet, e.name, e.def, log.at);
      // An index whose build was interrupted resumes it instead (`backfillPaged`).
      if (!s || s.backfill) return false;
      const parts = await state.fetch(s);
      if (!parts) return false;
      load(parts);
      const changes = await log.since(e.tablet, state.currentTs(s));
      await this.opts.beforeSearchBackfillPage?.();
      for (const [id, doc] of changes) {
        replay(id, doc as Doc | null);
        this.searchStats.replayed++;
      }
      return true;
    } catch (err) {
      console.error(
        `bunvex: the segments of ${e.table}.${e.name} could not be loaded, indexing the table: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /** Whether `e` is still the index of its table and name (not dropped or replaced by a push). */
  private isCurrent(kind: "text" | "vector", e: SearchIndexEntry | VectorIndexEntry): boolean {
    const t = this.catalog.byTablet(e.tablet);
    if (!t) return false;
    return (kind === "text" ? this.searchIndexes.get(t, e.name) : this.vectorIndexes.get(t, e.name)) === e;
  }

  /**
   * Convex's `validate_memory_index_sizes` (STUDY-111, DV-228): a transaction writing a table one of whose ready
   * search or vector indexes has a memory part at its hard limit (100 MiB) is refused, `TextIndexTooLarge` /
   * `VectorIndexTooLarge`, until a flush brings it down. Indexes being built never refuse writes. Only with
   * segments: without a store there is nothing to flush into.
   */
  private checkMemoryIndexSizes(tx: Tx) {
    if (!this.searchSegments) return;
    const limits = this.segmentLimits;
    for (const t of tx.writtenTables()) {
      for (const e of this.searchIndexes.forTablet(t.id))
        if (e.ready && !e.staged && e.index.memoryBytes >= limits.textHardLimitBytes) {
          this.scheduleFlush("text", e);
          throw indexTooLarge("text", `${e.table}.${e.name}`);
        }
      for (const e of this.vectorIndexes.forTablet(t.id))
        if (e.ready && !e.staged && e.index.memoryBytes >= limits.vectorHardLimitBytes) {
          this.scheduleFlush("vector", e);
          throw indexTooLarge("vector", `${e.table}.${e.name}`);
        }
    }
  }

  /** After a commit: the ready indexes of its tables whose memory part passed the soft limit are flushed. */
  private flushFull(writes: readonly { table: TableDef }[]) {
    if (!this.searchSegments || this.closed) return;
    let last = -1;
    for (const w of writes) {
      if (w.table.id === last) continue;
      last = w.table.id;
      for (const e of this.searchIndexes.forTablet(last))
        if (e.ready && e.index.memoryBytes > this.segmentLimits.textSoftLimitBytes) this.scheduleFlush("text", e);
      for (const e of this.vectorIndexes.forTablet(last))
        if (e.ready && e.index.memoryBytes > this.segmentLimits.vectorSoftLimitBytes) this.scheduleFlush("vector", e);
    }
  }

  /** Flushes `e` in the background: one flush per index at a time, and again after it if asked meanwhile. */
  private scheduleFlush(kind: "text" | "vector", e: SearchIndexEntry | VectorIndexEntry) {
    if (this.flushing.has(e)) {
      this.flushAgain.add(e);
      return;
    }
    const p = this.flushIndex(kind, e)
      .catch((err) => {
        if (!this.closed) console.error(`bunvex: ${kind} index ${e.table}.${e.name} failed to flush: ${err.message}`);
      })
      .finally(() => {
        this.flushing.delete(e);
        if (this.flushAgain.delete(e) && !this.closed) this.scheduleFlush(kind, e);
      });
    this.flushing.set(e, p);
  }

  /**
   * Convex's flusher for one index (STUDY-111): its memory part as a new segment and the older segments' new
   * deletes, as of the visible ts, written to the blob store; then the state names them (and the ts); then the
   * index drops what they hold from its memory part. No blob is ever deleted, as Convex's (DV-370). With nothing to
   * write, only the ts moves (no log to replay up to it).
   */
  private flushIndex(kind: "text" | "vector", e: SearchIndexEntry | VectorIndexEntry) {
    return this.withIndexLock(e, () => this.flushLocked(kind, e));
  }

  /**
   * Runs `fn` once the index's earlier flush, backfill step or compaction commit is done: what each prepares
   * against the segments stays valid until it commits, as Convex's writer serializes its flusher and compactor.
   */
  private withIndexLock<T>(e: SearchIndexEntry | VectorIndexEntry, fn: () => Promise<T>): Promise<T> {
    const run = (this.indexLocks.get(e) ?? Promise.resolve()).then(fn);
    const done = run.then(
      () => {},
      () => {},
    );
    this.indexLocks.set(e, done);
    void done.then(() => {
      if (this.indexLocks.get(e) === done) this.indexLocks.delete(e);
    });
    return run;
  }
  private indexLocks = new Map<SearchIndexEntry | VectorIndexEntry, Promise<void>>();

  private async flushLocked(kind: "text" | "vector", e: SearchIndexEntry | VectorIndexEntry) {
    const state = this.searchSegments;
    if (!state || e.staged || !this.isCurrent(kind, e)) return;
    const ts = this.committer.visibleTs;
    // Prepared at once: the memory part and the deletes as of `ts`.
    const index = e.index as SearchIndexEntry["index"] & VectorIndexEntry["index"];
    const f = index.prepareFlush();
    const before = state.get(kind, e.tablet, e.name);
    // Nothing to write: the ts moves by a fast-forward instead (`searchWorkersTick`), as Convex's.
    if (!f.segment && !f.deletes.length && before && !before.backfill) return;
    const added = f.segment ? await this.storeSegment(kind, e, f.segment) : null;
    const deletes = await Promise.all(f.deletes.map((d) => state.blobs!.put(d.bytes)));
    const stored = await state.update(
      (states) => {
        if (!this.isCurrent(kind, e)) return false;
        const refs = segmentRefs(index.segments, this.segmentSize(kind, e)).map((r, i) => {
          const at = f.deletes.findIndex((d) => d.part === index.segments[i]);
          return at < 0 ? r : { ...r, deletes: deletes[at]!, deleted: f.deletes[at]!.part.deletes.count };
        });
        if (added) refs.push(added.ref);
        const s: IndexSegmentsState = {
          kind,
          tablet: e.tablet,
          name: e.name,
          def: e.def,
          ts,
          segments: refs,
          staged: false,
        };
        states.set(stateKey(kind, e.tablet, e.name), s);
        return true;
      },
      () => {
        f.deletes.forEach((d, i) => {
          d.part.keys = { segment: d.part.keys!.segment, deletes: deletes[i]! };
        });
        index.commitFlush(f, added?.keys);
      },
    );
    if (stored) this.searchStats.flushes++;
    else return;
    this.scheduleCompaction(kind, e);
  }

  /** Each index's compaction in progress (one at a time per index). */
  private compacting = new Map<SearchIndexEntry | VectorIndexEntry, Promise<void>>();

  /** Compacts `e` in the background when its segments call for it, and again after while they still do. */
  private scheduleCompaction(kind: "text" | "vector", e: SearchIndexEntry | VectorIndexEntry) {
    if (this.compacting.has(e) || this.closed || !this.searchSegments) return;
    const p = this.compactIndex(kind, e)
      .catch((err) => {
        if (!this.closed) console.error(`bunvex: ${kind} index ${e.table}.${e.name} failed to compact: ${err.message}`);
        return false;
      })
      .then((compacted) => {
        this.compacting.delete(e);
        if (compacted && !this.closed) this.scheduleCompaction(kind, e);
      });
    this.compacting.set(e, p);
  }

  /** Wait until no index is being flushed or compacted (tests). */
  async searchCompacted() {
    while (this.flushing.size || this.compacting.size)
      await Promise.allSettled([...this.flushing.values(), ...this.compacting.values()]);
  }

  /**
   * Convex's compactor for one index (STUDY-111 PR 5, `search_compactor.rs`): the segments
   * `segmentsToCompact` picks are merged into one of their live documents, built outside the index's lock; then,
   * under it, the deletes they got meanwhile (flushes' included) are carried into it and stored with it
   * (Convex's writer `merge_deletes`), the state names it in their place, and their blobs are deleted. True when
   * it compacted.
   */
  private async compactIndex(kind: "text" | "vector", e: SearchIndexEntry | VectorIndexEntry): Promise<boolean> {
    const state = this.searchSegments;
    if (!state || e.staged || !this.isCurrent(kind, e)) return false;
    const index = e.index as SearchIndexEntry["index"] & VectorIndexEntry["index"];
    const dims = kind === "vector" ? (e.def as { dimensions: number }).dimensions : 0;
    const candidates = index.segments.map((p) => ({
      size: kind === "text" ? p.segment.bytes.length : p.segment.numDocs * dims * 4,
      docs: p.segment.numDocs,
      deleted: p.deletes.count,
    }));
    // Segments with no live document are dropped whatever else is merged (Convex never reads them).
    const picked = segmentsToCompact(candidates, this.compactionConfig, shuffled);
    const empty = index.segments.filter((p) => p.deletes.live === 0);
    const chosen = [...new Set([...(picked ?? []).map((i) => index.segments[i]!), ...empty])];
    if (!chosen.length) return false;
    // Built in the background: other work runs between its chunks, and a close stops it.
    const c = await index.prepareCompaction(chosen, async () => {
      await new Promise((r) => setImmediate(r));
      if (this.closed) throw new Error("the engine closed");
    });
    const segment = c.segment ? await state.blobs!.put(c.segment) : null;
    await this.opts.beforeSearchCompactionCommit?.();
    return this.withIndexLock(e, async () => {
      if (this.closed || !this.isCurrent(kind, e) || chosen.some((p) => !index.segments.includes(p))) return false;
      // Its deletes (none, or those carried over) are stored with it.
      const carried = index.reconcileCompaction(c) ?? (c.merged ? c.merged.deletes.encode() : null);
      const deletes = carried ? await state.blobs!.put(carried) : null;
      const stored = await state.update(
        (states) => {
          const before = states.get(stateKey(kind, e.tablet, e.name));
          if (!before || !this.isCurrent(kind, e)) return false;
          // The segments as they will be: the merged one in the place of the first it replaces.
          const kept = index.segments.filter((p) => !chosen.includes(p));
          const refs = segmentRefs(kept, this.segmentSize(kind, e));
          if (segment && deletes && c.merged)
            refs.splice(Math.min(index.segments.indexOf(chosen[0]!), refs.length), 0, {
              segment,
              deletes,
              docs: c.merged.segment.numDocs,
              deleted: c.merged.deletes.count,
              bytes: this.segmentSize(kind, e)(c.merged.segment),
              id: c.merged.segment.uid,
            });
          states.set(stateKey(kind, e.tablet, e.name), { ...before, segments: refs });
          return true;
        },
        () => {
          index.commitCompaction(c, segment ? { segment, deletes } : undefined);
        },
      );
      if (!stored) return false;
      this.searchStats.compactions++;
      return true;
    });
  }

  /**
   * Convex's paged backfill of an index (STUDY-111 PR 4, `search_flusher.rs` `build_multipart_segment`): each
   * step reads the table by id from the cursor at a fresh ts, up to the soft limit's worth of documents, and
   * takes the documents of the earlier pages the log changed since the last step; they become one segment (their
   * old copies deleted in the earlier segments), stored with the new cursor, so a restart resumes from it. When
   * the table is read, the index is ready at the last step's ts. True once built (false: closed or dropped).
   */
  private async backfillPaged<Doc2>(
    kind: "text" | "vector",
    e: SearchIndexEntry | VectorIndexEntry,
    toDoc: (doc: Doc) => Doc2 | null,
    sizeOf: (doc: Doc) => number,
  ): Promise<boolean> {
    const state = this.searchSegments!;
    const t = this.catalog.byTablet(e.tablet);
    if (!t) return false;
    const index = e.index as unknown as {
      load(parts: NonNullable<Awaited<ReturnType<SearchSegmentsState["fetch"]>>>): void;
      buildSegment(docs: [string, Doc2][]): Uint8Array | null;
      deleteFromAll(ids: Iterable<string>): void;
      changedDeletes(): { part: unknown; version: number; bytes: Uint8Array }[];
      commitBackfill(
        segment: Uint8Array | null,
        deletes: { part: unknown; version: number; bytes: Uint8Array }[],
        ts: number,
        keys?: { segment: string; deletes: string | null },
      ): unknown;
      segments: Parameters<typeof segmentRefs>[0];
    };
    const threshold = kind === "text" ? this.segmentLimits.textSoftLimitBytes : this.segmentLimits.vectorSoftLimitBytes;
    // An interrupted build resumes from its stored cursor (Convex's `Backfilling { cursor, segments }`).
    let cursor: string | null = null;
    let lastTs: number | null = null;
    const resume = await state.usable(kind, e.tablet, e.name, e.def, this.committer.visibleTs).catch(() => null);
    if (resume?.backfill) {
      const parts = await state.fetch(resume).catch(() => null);
      if (parts) {
        try {
          index.load(parts);
          cursor = resume.backfill.cursor;
          lastTs = resume.ts;
          this.searchStats.resumed++;
          // Never ready before: a search meanwhile is Convex's `IndexBackfillingError`.
          e.bootstrapping = false;
        } catch {
          cursor = null;
        }
      }
    }
    for (;;) {
      const ts = this.committer.visibleTs;
      // The table from the cursor, at `ts`, up to the threshold.
      const docs: [string, Doc2][] = [];
      let size = 0;
      let next = cursor;
      let end = false;
      while (size < threshold) {
        await this.opts.beforeSearchBackfillPage?.();
        if (this.closed || !this.isCurrent(kind, e)) return false;
        const from = next;
        const page = (await this.query(
          (db) =>
            db.asSystem(() =>
              db
                .queryDef(t)
                .withIndex("by_id", (q) => (from === null ? q : q.gt("_id", from)))
                .take(1000),
            ),
          undefined,
          undefined,
          undefined,
          ts,
        )) as Doc[];
        let k = 0;
        for (; k < page.length && size < threshold; k++) {
          const d = page[k]!;
          next = d._id as string;
          const entry = toDoc(d);
          if (entry) {
            docs.push([next, entry]);
            size += sizeOf(d);
          }
        }
        this.searchStats.backfilled += k;
        if (k === page.length && page.length < 1000) {
          end = true;
          break;
        }
      }
      // The earlier pages' documents the log changed since the last step, at `ts`.
      const updates: [string, Doc | null][] = [];
      if (cursor !== null && lastTs !== null) {
        const upTo = cursor;
        const changed = await changedSince(state.store!, e.tablet, lastTs, ts, decodeDoc, (id) => id <= upTo);
        for (const [id, c] of changed) updates.push([id, c.doc]);
      }
      if (this.closed || !this.isCurrent(kind, e)) return false;
      const stepped = await this.withIndexLock(e, async () => {
        // Built at once: the new segment, and the earlier segments' deletes.
        index.deleteFromAll(updates.map(([id]) => id));
        for (const [id, doc] of updates) {
          const entry = doc && toDoc(doc);
          if (entry) docs.push([id, entry]);
        }
        const bytes = index.buildSegment(docs);
        const deletes = index.changedDeletes();
        const added = bytes ? await this.storeSegment(kind, e, bytes) : null;
        const deleteKeys = await Promise.all(deletes.map((d) => state.blobs!.put(d.bytes)));
        const stored = await state.update(
          (states) => {
            if (!this.isCurrent(kind, e)) return false;
            const refs = segmentRefs(index.segments as never, this.segmentSize(kind, e)).map((r, i) => {
              const at = deletes.findIndex((d) => d.part === index.segments[i]);
              return at < 0 ? r : { ...r, deletes: deleteKeys[at]! };
            });
            if (added) refs.push(added.ref);
            const s: IndexSegmentsState = {
              kind,
              tablet: e.tablet,
              name: e.name,
              def: e.def,
              ts,
              segments: refs,
              staged: false,
              ...(end ? {} : { backfill: { cursor: next } }),
            };
            states.set(stateKey(kind, e.tablet, e.name), s);
            return true;
          },
          () => {
            deletes.forEach((d, i) => {
              const part = d.part as { keys?: { segment: string; deletes: string | null } };
              part.keys = { segment: part.keys!.segment, deletes: deleteKeys[i]! };
            });
            index.commitBackfill(bytes, deletes, ts, added?.keys);
          },
        );
        // Not stored (the index was dropped meanwhile): what was written stays, as every search blob (DV-370).
        if (!stored) return false;
        this.searchStats.backfillSteps++;
        return true;
      });
      if (!stepped) return false;
      // Convex compacts a backfilling index's segments too.
      this.scheduleCompaction(kind, e);
      if (end) return true;
      cursor = next;
      lastTs = ts;
      // A background job: let the server's own work run between steps.
      await new Promise((r) => setImmediate(r));
    }
  }

  /** At a clean shutdown: every ready index flushed, so the next start replays nothing (STUDY-111). */
  private async flushSearchSegments() {
    if (!this.searchSegments || this.committer.stopped) return;
    await Promise.allSettled([...this.flushing.values()]);
    const all = [
      ...this.searchIndexes.all().map((e) => ["text", e] as const),
      ...this.vectorIndexes.all().map((e) => ["vector", e] as const),
    ];
    for (const [kind, e] of all) {
      if (!e.ready || e.staged) continue;
      try {
        await this.flushIndex(kind, e);
      } catch (err) {
        console.error(`bunvex: ${kind} index ${e.table}.${e.name} failed to flush: ${(err as Error).message}`);
      }
    }
    // Then every index with nothing left in memory moves its ts to now: the next start replays nothing.
    await this.searchWorkersTick(true).catch((err) => {
      console.error(`bunvex: search indexes could not be fast-forwarded: ${(err as Error).message}`);
    });
  }

  /**
   * Makes the search and vector indexes' `_index` rows the indexes': a row for each (a new one backfilling, as
   * Convex inserts it), none for an index that is gone or redefined (its blobs kept, DV-370). A staged index is not
   * built, so its row stays backfilling, staged, without segments (DV-368).
   */
  private rowsSyncScheduled = false;
  /** Syncs the rows once the text and vector reconciles that run together are both done. */
  private scheduleIndexRowsSync() {
    if (this.rowsSyncScheduled) return;
    this.rowsSyncScheduled = true;
    queueMicrotask(() => {
      this.rowsSyncScheduled = false;
      this.syncIndexRows();
    });
  }

  private syncIndexRows() {
    const state = this.indexRows;
    if (!state) return;
    const wanted = new Map<string, ["text" | "vector", SearchIndexEntry | VectorIndexEntry]>();
    for (const e of this.searchIndexes.all()) wanted.set(stateKey("text", e.tablet, e.name), ["text", e]);
    for (const e of this.vectorIndexes.all()) wanted.set(stateKey("vector", e.tablet, e.name), ["vector", e]);
    void state
      .update((states) => {
        let changed = false;
        for (const [k, s] of states) {
          const w = wanted.get(k);
          if (w && sameSpec(w[1].def, s.def) && !(w[1].staged && s.segments.length)) {
            if (s.staged !== w[1].staged) {
              s.staged = w[1].staged;
              changed = true;
            }
            continue;
          }
          states.delete(k);
          changed = true;
        }
        for (const [k, [kind, e]] of wanted)
          if (!states.has(k)) {
            states.set(k, {
              kind,
              tablet: e.tablet,
              name: e.name,
              def: e.def,
              ts: 0,
              segments: [],
              backfill: { cursor: null },
              staged: e.staged,
            });
            changed = true;
          }
        return changed;
      })
      .catch((err) => {
        if (!this.closed) console.error(`bunvex: the search indexes' _index rows could not be written: ${err.message}`);
      });
  }

  /**
   * Without segments, an index read from its table is ready with nothing stored: its row says so (`snapshotted`
   * with no segments at ts 0, so a later start with a store replays from the beginning or reads the table).
   */
  private markRowReady(kind: "text" | "vector", e: SearchIndexEntry | VectorIndexEntry) {
    const state = this.indexRows;
    if (!state || this.searchSegments) return;
    void state
      .update((states) => {
        if (!this.isCurrent(kind, e)) return false;
        const k = stateKey(kind, e.tablet, e.name);
        // A row that names segments (a run with a store wrote it) is left as it is: its segments, plus the log
        // since, are still this index.
        const before = states.get(k);
        if (before?.segments.length) return false;
        states.set(k, { kind, tablet: e.tablet, name: e.name, def: e.def, ts: 0, segments: [], staged: false });
        return true;
      })
      .catch(() => {});
  }

  private async backfillVector(e: VectorIndexEntry) {
    const t = this.catalog.byTablet(e.tablet);
    if (!t) return;
    if (
      await this.restoreFromSegments<Doc>(
        "vector",
        e,
        (parts) => e.index.load(parts),
        (id, doc) => this.vectorIndexes.restore(e, id, doc ? vectorEntry(e.def, doc) : null),
      )
    ) {
      this.searchStats.fromSegments++;
      this.vectorIndexes.done(e);
      this.scheduleCompaction("vector", e);
      return;
    }
    if (this.searchSegments) {
      const dims = e.def.dimensions;
      if (
        await this.backfillPaged(
          "vector",
          e,
          (doc) => vectorEntry(e.def, doc),
          () => dims * 4,
        )
      )
        this.vectorIndexes.done(e);
      return;
    }
    const at = this.committer.visibleTs;
    let last: string | null = null;
    for (;;) {
      await this.opts.beforeSearchBackfillPage?.();
      if (this.closed) return;
      const page = (await this.query(
        (db) =>
          db.asSystem(() =>
            db
              .queryDef(t)
              .withIndex("by_id", (q) => (last === null ? q : q.gt("_id", last)))
              .take(1000),
          ),
        undefined,
        undefined,
        undefined,
        at,
      )) as Doc[];
      for (const d of page) this.vectorIndexes.backfill(e, d);
      if (page.length < 1000) break;
      last = page[page.length - 1]!._id as string;
      await new Promise((r) => setImmediate(r));
    }
    this.vectorIndexes.done(e);
    this.markRowReady("vector", e);
  }

  /**
   * Convex's vector search (`Database::vector_search`, STUDY-51): the `limit` (default 10, at most 256)
   * documents of `table` nearest `vector` in index `index`, among those matching `filter` (an OR of `q.eq`s on
   * the index's filter fields), as `{_id, _score}`, best first. Against the latest visible state; a missing
   * table has no results.
   */
  vectorSearch(
    table: string,
    index: string,
    query: { vector: number[]; limit?: number; filter?: unknown },
    /** Told what the search was charged, as Convex's `bytes_searched`: its vectors × dimensions × 4 (STUDY-71). */
    charge?: (bytesSearched: number) => void,
  ): { _id: string; _score: number }[] {
    const t = this.catalog.tables.get(table);
    if (!t) return [];
    const name = `${table}.${index}`;
    const declared = this.schema.tables.get(table);
    const e = this.vectorIndexes.get(t, index);
    if (!e) {
      if (t.indexes.has(index) || declared?.searchIndexes?.[index])
        throw new Error(`Index ${name} is not a vector index`);
      throw new Error(`Index ${name} not found.`);
    }
    if (e.staged) throw new IndexStagedError(name);
    if (!e.ready) throw e.bootstrapping ? vectorIndexesUnavailable() : new IndexBackfillingError(name);
    const v = query.vector;
    const limit = query.limit ?? DEFAULT_VECTOR_LIMIT;
    if (!Number.isInteger(limit) || limit < 0)
      throw new Error(`InvalidVectorQuery: limit: invalid value: ${limit}, expected u32`);
    if (v.length > MAX_VECTOR_DIMENSIONS)
      throw new Error(`Expected a vector with dimensions ${MAX_VECTOR_DIMENSIONS}, received ${v.length}.`);
    if (limit > MAX_VECTOR_RESULTS)
      throw new Error(`Vector queries can fetch at most ${MAX_VECTOR_RESULTS} results, requested ${limit}.`);
    const filter = query.filter === undefined ? null : vectorFilter(query.filter);
    if (filter) {
      let conditions = 0;
      for (const [field, keys] of filter) {
        if (!e.def.filterFields.includes(field))
          throw new Error(
            `Vector query against ${name} contains a filter on ${JSON.stringify(field)} but that field isn't indexed for filtering in \`filterFields\`.`,
          );
        conditions += keys.size;
      }
      if (conditions > MAX_VECTOR_FILTER_CONDITIONS)
        throw new Error(
          `Vector query against ${name} has too many conditions. Max: ${MAX_VECTOR_FILTER_CONDITIONS} Actual: ${conditions}`,
        );
    }
    if (v.length !== e.def.dimensions)
      throw new Error(`Expected a vector with dimensions ${e.def.dimensions}, received ${v.length}.`);
    charge?.(e.index.size * v.length * 4);
    return this.vectorIndexes.search(e, v, limit, filter).map((h) => ({ _id: h.id, _score: h.score }));
  }

  private async backfillSearch(e: SearchIndexEntry) {
    const t = this.catalog.byTablet(e.tablet);
    if (!t) return;
    if (
      await this.restoreFromSegments<Doc>(
        "text",
        e,
        (parts) => e.index.load(parts),
        (id, doc) => this.searchIndexes.restore(e, id, doc ? indexedDoc(e.def, doc) : null),
      )
    ) {
      this.searchStats.fromSegments++;
      this.searchIndexes.done(e);
      this.scheduleCompaction("text", e);
      return;
    }
    if (this.searchSegments) {
      if (
        await this.backfillPaged(
          "text",
          e,
          (doc) => indexedDoc(e.def, doc),
          (doc) => indexedDocBytes(e.def, doc),
        )
      )
        this.searchIndexes.done(e);
      return;
    }
    const at = this.committer.visibleTs;
    let last: string | null = null;
    for (;;) {
      await this.opts.beforeSearchBackfillPage?.();
      if (this.closed) return;
      const page = (await this.query(
        (db) =>
          db.asSystem(() =>
            db
              .queryDef(t)
              .withIndex("by_id", (q) => (last === null ? q : q.gt("_id", last)))
              .take(1000),
          ),
        undefined,
        undefined,
        undefined,
        at,
      )) as Doc[];
      for (const d of page) this.searchIndexes.backfill(e, d);
      if (page.length < 1000) break;
      last = page[page.length - 1]!._id as string;
      // A background job: let the server's own work run between pages.
      await new Promise((r) => setImmediate(r));
    }
    this.searchIndexes.done(e);
    this.markRowReady("text", e);
  }

  /**
   * Build the table summaries at one snapshot: from the last checkpoint and the document log since (STUDY-72),
   * else from every table's documents (active, hidden and being deleted), page by page. Commits meanwhile
   * are queued and applied after (STUDY-52 PR 2). Then checkpoints are written as Convex's worker does.
   */
  private async buildSummaries() {
    const at = this.committer.visibleTs;
    const defs = [...this.catalog.tables.values(), ...this.catalog.hidden.values(), ...this.catalog.deleting.values()];
    const p = this.persistence;
    const checkpoints = this.opts.summaryCheckpoints !== false && canCheckpoint(p);
    const restored =
      checkpoints &&
      (await restoreSummaries(p, this.tableSummaries, at, new Set(defs.map((t) => t.id)), decodeDoc).catch((e) => {
        console.error(`bunvex: the table summary checkpoint could not be loaded, scanning: ${(e as Error).message}`);
        return false;
      }));
    this.summariesRestored = restored;
    if (!restored) await this.scanSummaries(at, defs);
    if (this.closed) return;
    this.tableSummaries.finish();
    if (checkpoints) {
      this.summaryCheckpointer = new SummaryCheckpointer(
        p,
        this.tableSummaries,
        this.opts.summaryCheckpoints || undefined,
      );
      this.summaryCheckpointer.start();
    }
  }

  /** Whether the summaries came from a checkpoint (tests, STUDY-72). */
  summariesRestored = false;
  /** @internal The checkpoint worker, once the summaries are built. */
  summaryCheckpointer: SummaryCheckpointer | null = null;

  private async scanSummaries(at: number, defs: TableDef[]) {
    this.tableSummaries.reset();
    for (const t of defs) {
      let last: string | null = null;
      for (;;) {
        if (this.closed) return;
        const page = (await this.query(
          (db) =>
            db.asSystem(() =>
              db
                .queryDef(t)
                .withIndex("by_id", (q) => (last === null ? q : q.gt("_id", last)))
                .take(1000),
            ),
          undefined,
          undefined,
          undefined,
          at,
        )) as Doc[];
        this.tableSummaries.build(at, t.id, page);
        if (page.length < 1000) break;
        last = page[page.length - 1]!._id as string;
        await new Promise((r) => setImmediate(r));
      }
    }
  }

  private readonly tableCountOf = (tablet: number, snapshot: number) => this.tableSummaries.countAt(tablet, snapshot);

  /**
   * Convex's `evaluate_schema_prediction` (STUDY-56): what pushing `next` would do, without doing it — each
   * index added, kept, enabled, disabled or dropped, whether it needs a backfill and its table's document
   * count; each declared table's validation outcome with its count and size. Needs the table summaries.
   */
  async evaluateSchema(next: SchemaDefinition): Promise<SchemaPrediction> {
    if (!this.tableSummaries.ready) throw new TableSummariesUnavailableError();
    const { value: cat } = await this.execute("query", this.committer.visibleTs, (db) => readCatalog(db), true);
    const active = activeTables(cat.tables);
    const tabletOf = (name: string) => active.find((t) => t.name === name)?.tablet;
    const docs = (table: string) => {
      const tablet = tabletOf(table);
      return tablet === undefined ? 0 : this.tableSummaries.count(tablet);
    };
    const indexes: IndexPrediction[] = [];
    const push = (
      table: string,
      name: string,
      spec: Record<string, unknown>,
      staged: boolean,
      change: IndexChange,
      needsBackfill: boolean,
    ) => indexes.push({ name: `${table}.${name}`, ...spec, staged, change, needsBackfill, numDocs: docs(table) });
    // Database indexes: the stored ones (their `_creationTime` suffix aside) against the declared ones.
    const userFields = (f: string[]) => (f.at(-1) === "_creationTime" ? f.slice(0, -1) : f);
    const tableNames = new Set([
      ...next.tables.keys(),
      ...active.filter((t) => !t.name.startsWith("_")).map((t) => t.name),
    ]);
    for (const table of [...tableNames].sort()) {
      const declared = next.tables.get(table);
      const tablet = tabletOf(table);
      const stored = cat.indexes.filter((i) => i.tablet === tablet && !(i.name in SYSTEM_INDEXES));
      const stagedNext = new Set(declared?.staged ?? []);
      for (const [name, fields] of Object.entries(declared?.indexes ?? {})) {
        const st = stored.find((i) => i.name === name);
        const spec = { type: "database", fields: [...fields] };
        const staged = stagedNext.has(name);
        if (!st || JSON.stringify(userFields(st.fields)) !== JSON.stringify(fields)) {
          push(table, name, spec, staged, "added", true);
          if (st) push(table, name, { type: "database", fields: userFields(st.fields) }, !!st.staged, "dropped", false);
        } else if (st.staged && !staged) push(table, name, spec, staged, "enabled", st.state === "backfilling");
        else if (!st.staged && staged) push(table, name, spec, staged, "disabled", false);
        else push(table, name, spec, staged, "identical", st.state === "backfilling");
      }
      for (const st of stored)
        if (!declared?.indexes[st.name])
          push(table, st.name, { type: "database", fields: userFields(st.fields) }, !!st.staged, "dropped", false);
      // Search and vector indexes: the active schema's against the pushed one's.
      const before = this.schema.tables.get(table);
      const kinds = [
        {
          now: before?.searchIndexes ?? {},
          pushed: declared?.searchIndexes ?? {},
          nowStaged: new Set(before?.stagedSearch ?? []),
          pushedStaged: new Set(declared?.stagedSearch ?? []),
          spec: (d: { searchField: string; filterFields: string[] }) => ({
            type: "search",
            searchField: d.searchField,
            filterFields: [...d.filterFields].sort(),
          }),
          ready: (n: string) =>
            tablet === undefined ? false : !!this.searchIndexes.get(this.catalog.byTablet(tablet)!, n)?.ready,
        },
        {
          now: before?.vectorIndexes ?? {},
          pushed: declared?.vectorIndexes ?? {},
          nowStaged: new Set(before?.stagedVector ?? []),
          pushedStaged: new Set(declared?.stagedVector ?? []),
          spec: (d: { vectorField: string; dimensions: number; filterFields: string[] }) => ({
            type: "vector",
            vectorField: d.vectorField,
            dimensions: d.dimensions,
            filterFields: [...d.filterFields].sort(),
          }),
          ready: (n: string) =>
            tablet === undefined ? false : !!this.vectorIndexes.get(this.catalog.byTablet(tablet)!, n)?.ready,
        },
      ] as const;
      for (const k of kinds) {
        const nowAll = k.now as Record<string, never>;
        const pushedAll = k.pushed as Record<string, never>;
        for (const [name, d] of Object.entries(pushedAll)) {
          const spec = k.spec(d);
          const old = nowAll[name];
          const staged = k.pushedStaged.has(name);
          if (old === undefined || JSON.stringify(k.spec(old)) !== JSON.stringify(spec)) {
            push(table, name, spec, staged, "added", true);
            if (old !== undefined) push(table, name, k.spec(old), k.nowStaged.has(name), "dropped", false);
          } else if (k.nowStaged.has(name) && !staged) push(table, name, spec, staged, "enabled", !k.ready(name));
          else if (!k.nowStaged.has(name) && staged) push(table, name, spec, staged, "disabled", false);
          else push(table, name, spec, staged, "identical", !staged && !k.ready(name));
        }
        for (const [name, d] of Object.entries(nowAll))
          if (pushedAll[name] === undefined) push(table, name, k.spec(d), k.nowStaged.has(name), "dropped", false);
      }
    }
    // Tables: the outcome of the schema walk bunvex will do (STUDY-35), with counts and sizes.
    const enforced = this.schema.schemaValidation ? this.schema : null;
    const tables: TablePrediction[] = [...next.tables.values()].map((t) => {
      const tablet = tabletOf(t.name);
      const s = tablet === undefined ? { count: 0, size: 0 } : this.tableSummaries.get(tablet);
      const was = enforced?.tables.get(t.name);
      const outcome: TableOutcome = !next.schemaValidation
        ? "notValidated"
        : was && JSON.stringify(was.document.json) === JSON.stringify(t.document.json)
          ? "supersetOfEnforced"
          : "mustWalk";
      return { name: t.name, outcome, numDocs: s.count, sizeBytes: s.size };
    });
    return { schemaValidation: next.schemaValidation, tables, indexes };
  }

  /** Wait until the table summaries are built (tests, and callers that need them at once). */
  async summariesReady() {
    await this.summariesBuild;
  }

  /** Wait until every search index is built (tests). */
  async searchReady() {
    while (this.searchBackfills.size) await Promise.all([...this.searchBackfills]);
  }

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
        await deleteValidationsForSchema(db, schemaId);
      },
      true,
      "schema_worker",
    );
  }

  /** Check the stored documents against a pending schema in the background (`validateExisting`). */
  private startValidation(schemaId: string, schema: SchemaDefinition, active: SchemaDefinition) {
    this.validation = this.validateExisting(schemaId, schema, active).catch((e) =>
      this.failSchemaPush(schemaId, `Schema validation failed: ${e instanceof Error ? e.message : e}`, null).catch(
        () => {},
      ),
    );
  }

  /**
   * At a start, as Convex's `reset_for_compatibility` then its `SchemaWorker` (STUDY-127): every validation
   * attempt is deleted; a schema still `pending` is checked again from the beginning with new attempts, and
   * writes are checked against a `pending` or `validated` schema meanwhile, as before the restart.
   */
  private async resumePendingSchema() {
    const row = await this.runMutation(
      async (db) => {
        await resetSchemaValidations(db);
        const rows = await db.query(SCHEMAS_TABLE).collect();
        return rows.find((r) => r.state === "pending" || r.state === "validated") ?? null;
      },
      true,
      "init_app_system_tables",
    );
    if (!row) return;
    const schema = schemaFromJson(JSON.parse(row.schema as string) as SchemaJson);
    this.pendingPush = { id: row._id as string, schema };
    this.pendingValidators = validatorsOf(schema);
    if (row.state === "pending") this.startValidation(row._id as string, schema, this.schema);
  }

  /** A table's document count for a validation's progress, or null while the table summaries are built. */
  private totalDocs(table: string): number | null {
    if (!this.tableSummaries.ready) return null;
    const t = this.catalog.tables.get(table);
    return t ? this.tableSummaries.count(t.id) : 0;
  }

  /**
   * Convex's `SchemaWorker`: walk every table whose validator the pushed schema changes (or adds) and check
   * each existing document; the first that does not match fails the schema
   * (`Document with ID "…" in table "…" does not match the schema: …`), else it becomes `validated`. Writes
   * made meanwhile are checked as they commit (`pendingValidators`). Each table walked has an attempt in
   * `_schema_validations` and its counters in `_schema_validation_progress` (STUDY-127), flushed every 5 % of
   * the table or 500 documents and when the table is done; an attempt gone (the schema failed or was
   * overwritten) stops the walk.
   */
  private async validateExisting(schemaId: string, schema: SchemaDefinition, active: SchemaDefinition) {
    const stillPending = () => this.pendingPush?.id === schemaId;
    const walk: { name: string; validator: GenericValidator }[] = [];
    if (schema.schemaValidation)
      for (const t of schema.tables.values()) {
        const validator = documentValidator(t.name, t.document);
        if (!validator) continue;
        const before = active.schemaValidation ? active.tables.get(t.name) : undefined;
        if (before && JSON.stringify(before.document.json) === JSON.stringify(t.document.json)) continue;
        walk.push({ name: t.name, validator });
      }
    if (!stillPending()) return;
    // Convex's `SchemaValidationProgressTracker::new`: every attempt first, in one commit.
    const attempts = await this.runMutation(
      async (db) => {
        const ids: string[] = [];
        for (const t of walk) ids.push(await startTableValidation(db, schemaId, t.name, this.totalDocs(t.name)));
        return ids;
      },
      true,
      "schema_validation_tracker_initialized",
    );
    for (const [k, t] of walk.entries()) {
      const attempt = attempts[k]!;
      const threshold = progressThreshold(this.totalDocs(t.name));
      let unflushed = 0;
      // One flush at a time runs while the walk goes on; the next one waits for it, and stops the walk when it
      // found the attempt gone (the walk was canceled).
      let inFlight: Promise<boolean> = Promise.resolve(true);
      /** Write the counted documents; false once the attempt is gone. */
      const flush = async () => {
        if (!(await inFlight)) return false;
        const count = unflushed;
        unflushed = 0;
        inFlight = this.runMutation(
          (db) => recordValidationProgress(db, attempt, count, this.totalDocs(t.name)),
          true,
          "schema_validation_progress_updated",
        );
        return true;
      };
      let cursor: string | null = null;
      for (;;) {
        if (!stillPending()) return;
        const page = await this.query(async (db) => db.query(t.name).paginate({ numItems: 256, cursor }));
        for (const doc of page.page) {
          const msg = checkValue(t.validator, doc as unknown as Value, (n) => this.catalog.publicNameOf(n));
          if (msg) {
            await this.failSchemaPush(
              schemaId,
              `Document with ID "${doc._id as string}" in table "${t.name}" does not match the schema: ${msg}`,
              t.name,
            );
            return;
          }
          if (++unflushed % threshold === 0 && !(await flush())) return;
        }
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
      if (!(await flush()) || !(await inFlight)) return;
      const marked = await this.runMutation(
        (db) => markValidationValid(db, attempt),
        true,
        "schema_validation_progress_finished",
      );
      if (!marked) return;
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
        const changes = planCatalog(
          declared,
          current.tables,
          current.indexes,
          true,
          current.nextIndexId,
          current.nextTablet,
        );
        for (const t of changes.insertTables) await db.insert(TABLES_TABLE, t);
        await writeNextTablet(db, changes.nextTablet);
        for (const id of changes.deleteIndexes) {
          await db.delete(INDEX_TABLE, id);
          await deleteBackfillProgress(db, id);
        }
        for (const x of changes.restageIndexes) await db.patch(INDEX_TABLE, x._id, { staged: x.staged });
        for (const i of changes.insertIndexes) await db.insert(INDEX_TABLE, i);
        await writeNextIndexId(db, changes.nextIndexId);
        // Convex's `submit_pending`: a schema equal to the active one is the active one (an unfinished push is
        // overwritten); one equal to the pending or validated one is that one; else a new pending schema.
        const json = schemaToJson(schema);
        const key = schemaKey(json);
        const rows = await db.query(SCHEMAS_TABLE).collect();
        const same = (row: Record<string, unknown>) => schemaKey(JSON.parse(row.schema as string)) === key;
        const active = rows.find((row) => row.state === "active");
        const unfinished = rows.filter((row) => row.state === "pending" || row.state === "validated");
        let schemaId: string;
        let state = "pending" as "active" | "pending" | "validated";
        const reused = active && same(active) ? active : unfinished.find(same);
        for (const row of unfinished)
          if (row !== reused) {
            await db.patch(SCHEMAS_TABLE, row._id as string, { state: "overwritten" });
            await deleteValidationsForSchema(db, row._id as string);
          }
        if (reused) {
          schemaId = reused._id as string;
          state = reused.state as typeof state;
        } else schemaId = await db.insert(SCHEMAS_TABLE, { state: "pending", schema: JSON.stringify(json) });
        const tableName = (tablet: number) =>
          current.tables.find((t) => t.tablet === tablet)?.name ??
          changes.insertTables.find((t) => t.tablet === tablet)?.name;
        const addedIndexes = changes.insertIndexes
          .filter((i) => !(i.name in SYSTEM_INDEXES))
          .map((i) => `${tableName(i.tablet)}.${i.name}`);
        return { schemaId, state, addedIndexes, after: await readCatalog(db) };
      },
      true,
      "start_push",
    );
    this.catalog = buildCatalog(r.after.tables, r.after.indexes);
    const active = this.schema;
    if (r.state === "active") {
      // Nothing to validate: the push commits the active schema again (Convex's `mark_active` no-op).
      this.pendingPush = { id: r.schemaId, schema };
      this.pendingValidators = null;
    } else if (this.pendingPush?.id !== r.schemaId) {
      this.pendingPush = { id: r.schemaId, schema };
      this.pendingValidators = validatorsOf(schema);
      this.startValidation(r.schemaId, schema, active);
    }
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
        const indexes = databaseIndexRows(await db.query(INDEX_TABLE).collect());
        const tables = (await db.query(TABLES_TABLE).collect()) as unknown as TableMeta[];
        // As Convex's `load_component_schema_status`: every application index there is now (an index the push
        // changes is there twice, the enabled one and the new one backfilling), staged ones skipped; complete
        // once not backfilling.
        const userTablets = new Set(
          activeTables(tables)
            .filter((t) => !t.name.startsWith("_"))
            .map((t) => t.tablet),
        );
        let total = 0;
        let done = 0;
        for (const i of indexes) {
          if (!userTablets.has(i.tablet) || i.name in SYSTEM_INDEXES || i.staged) continue;
          total++;
          if (i.state !== "backfilling") done++;
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
        if (!row || (row.state !== "pending" && row.state !== "validated" && row.state !== "active"))
          throw new SchemaPushError("RaceDetected", "Schema was overwritten by another push.");
        if (row.state === "pending")
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
        // Already active (a push of the same schema): Convex's `mark_active` does nothing.
        if (row.state !== "active") {
          for (const old of await db.query(SCHEMAS_TABLE).collect())
            if (old.state === "active") await db.delete(SCHEMAS_TABLE, old._id as string);
          await db.patch(SCHEMAS_TABLE, schemaId, { state: "active" });
          await deleteValidationsForSchema(db, schemaId);
        }
        const value = await body(db);
        const ids = (l: IndexMeta[]) => l.map((i) => i.indexId);
        const name = (i: IndexMeta) => `${tables.find((t) => t.tablet === i.tablet)?.name}.${i.name}`;
        db.onCommitVisible = (ts) => {
          this.installIndexChanges({ enable: ids(f.enable), disable: ids(f.disable), drop: ids(f.drop) }, ts);
          this.schema = pending.schema;
          this.installValidators(pending.schema);
          this.reconcileSearch();
          this.reconcileVector();
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

  // ---------------------------------------------------------------- hidden and deleted tables (STUDY-42)

  /**
   * Create a hidden table (an import's, as Convex's `create_empty_table`): invisible to functions, with
   * `number` (else the first free one) and the indexes of the active table `copyIndexesOf` (empty, so
   * enabled at once; writes maintain them). `number` may be the active table's of the same name, or of a
   * table in `replacing` (one the activation deletes). Its definition, once committed.
   */
  async createHiddenTable(
    name: string,
    opts: { number?: number; copyIndexesOf?: string; replacing?: string[] } = {},
  ): Promise<TableDef> {
    const source = opts.copyIndexesOf ? this.catalog.tables.get(opts.copyIndexesOf) : undefined;
    const indexes: Record<string, string[]> = {};
    for (const ix of [...(source?.indexes.values() ?? []), ...(source?.pending ?? [])])
      if (!(ix.name in SYSTEM_INDEXES))
        indexes[ix.name] = ix.fields[ix.fields.length - 1] === "_creationTime" ? ix.fields.slice(0, -1) : ix.fields;
    let def: TableDef | undefined;
    await this.runMutation(
      async (db) => {
        const { tables, indexes: stored, nextTablet, nextIndexId } = await readCatalog(db);
        // A placeholder name: planCatalog then allocates a fresh tablet, number and index ids.
        // A system table's import (`_storage`) is not a user table (Convex checks the cap for user names only).
        const plan = planCatalog(
          [{ name: `\u0000hidden`, indexes, document: v.any() }],
          tables,
          stored,
          !name.startsWith("_"),
          nextIndexId,
          nextTablet,
        );
        const meta = plan.insertTables[0]!;
        if (opts.number !== undefined) {
          const holder = tables.find(
            (t) =>
              t.number === opts.number &&
              (t.state ?? "active") !== "deleting" &&
              !((t.name === name || opts.replacing?.includes(t.name)) && (t.state ?? "active") === "active"),
          );
          if (holder) throw new Error(`Table number ${opts.number} is already used by table "${holder.name}".`);
          meta.number = opts.number;
        }
        meta.name = name;
        meta.state = "hidden";
        const metaId = await db.insert(TABLES_TABLE, meta);
        await writeNextTablet(db, plan.nextTablet);
        for (const i of plan.insertIndexes) await db.insert(INDEX_TABLE, { ...i, state: "enabled", staged: undefined });
        await writeNextIndexId(db, plan.nextIndexId);
        db.onCommitVisible = () => {
          const c = this.catalog.withTableStates({});
          def = c.add(
            name,
            meta.tablet,
            meta.number,
            plan.insertIndexes.map((i) => ({ name: i.name, fields: i.fields, id: i.indexId })),
            "hidden",
            metaId,
          );
          this.catalog = c;
        };
      },
      true,
      "_system/create_hidden_table",
    );
    return def!;
  }

  /**
   * Make hidden tables active and delete active ones, in ONE commit (Convex's `activate_tables`): a hidden
   * table replaces the active table of its name, which is deleted. Every transaction that used a replaced
   * or deleted table conflicts (it read the table's `_tables` document) and every query that read one is
   * invalidated. `body` runs in the same transaction (an import's last checks).
   */
  async activateTables(
    tablets: number[],
    deleteNames: string[] = [],
    body?: (db: Tx) => Promise<void>,
  ): Promise<{ deleted: TableDef[]; ts: number }> {
    let deleted: TableDef[] = [];
    const { ts } = await this.runMutation(
      async (db) => {
        const { tables } = await readCatalog(db);
        const toDelete = new Set<number>();
        for (const tablet of tablets) {
          const t = tables.find((x) => x.tablet === tablet);
          if (!t || t.state !== "hidden") throw new Error(`Table ${tablet} is not a hidden table.`);
          const old = activeTables(tables).find((x) => x.name === t.name);
          if (old) toDelete.add(old.tablet);
          await db.patch(TABLES_TABLE, t._id, { state: "active" });
        }
        for (const name of deleteNames) {
          const old = activeTables(tables).find((x) => x.name === name);
          if (old) toDelete.add(old.tablet);
        }
        for (const tablet of toDelete) {
          const t = tables.find((x) => x.tablet === tablet)!;
          await db.patch(TABLES_TABLE, t._id, { state: "deleting" });
        }
        if (body) await body(db);
        const deleteList = [...toDelete];
        db.onCommitVisible = () => {
          deleted = deleteList.map((tb) => this.catalog.byTablet(tb)!).filter(Boolean);
          this.catalog = this.catalog.withTableStates({ activate: tablets, delete: deleteList });
          this.cache.clear();
          this.cacheEpoch++;
          this.reconcileSearch();
          this.reconcileVector();
        };
      },
      true,
      "_system/activate_tables",
      true,
    );
    this.startTableDeletion();
    return { deleted, ts };
  }

  /**
   * Drop hidden tables older than `maxAgeMs` (Convex's `cleanup_hidden_tables`: an import's tables left behind
   * by a crash), at most 1000 per call. How many were dropped.
   */
  async dropStaleHiddenTables(maxAgeMs: number, now = Date.now()): Promise<number> {
    const stale = (await this.query((db) =>
      db.asSystem(async () =>
        ((await db.query(TABLES_TABLE).collect()) as unknown as (TableMeta & { _creationTime: number })[])
          .filter((t) => t.state === "hidden" && now - t._creationTime > maxAgeMs)
          .slice(0, 1000)
          .map((t) => t.tablet),
      ),
    )) as number[];
    if (stale.length) await this.dropHiddenTables(stale);
    return stale.length;
  }

  /** Drop hidden tables (a failed import's): invisible already, their documents removed in the background. */
  async dropHiddenTables(tablets: number[]) {
    await this.runMutation(
      async (db) => {
        const { tables } = await readCatalog(db);
        const gone: number[] = [];
        for (const tablet of tablets) {
          const t = tables.find((x) => x.tablet === tablet);
          if (!t || t.state !== "hidden") continue;
          await db.patch(TABLES_TABLE, t._id, { state: "deleting" });
          gone.push(tablet);
        }
        db.onCommitVisible = () => {
          this.catalog = this.catalog.withTableStates({ delete: gone });
        };
      },
      true,
      "_system/drop_hidden_tables",
    );
    this.startTableDeletion();
  }

  /**
   * Delete user tables in one commit (Convex's `delete_tables` / `delete_active_table`): a table that does
   * not exist is skipped; a system table is refused; one the active schema declares, or points to with
   * `v.id`, is refused with Convex's `SchemaEnforcementError` messages; a pending schema that does fails.
   */
  /** `body` runs in the deletion's transaction (the server records its audit-log event there). */
  async deleteTables(names: string[], body?: (db: Tx) => Promise<void>) {
    for (const name of names) {
      if (name.startsWith("_")) throw new Error(`cannot delete system table ${name}`);
      const refusal = deletionRefusal(this.schema, name);
      if (refusal) throw new SchemaEnforcementError(refusal);
    }
    const pending = this.pendingPush;
    await this.activateTables([], names, body);
    if (pending)
      for (const name of names) {
        const refusal = deletionRefusal(pending.schema, name);
        if (refusal) {
          await this.failSchemaPush(pending.id, refusal, name).catch(() => {});
          break;
        }
      }
  }

  /**
   * Replace tables with empty ones in one commit (Convex's `TableModel::replace_with_empty_table`): each gets a
   * new table of the same name, number and indexes, and the old one is deleted in the background. System
   * tables too (the scheduler's, STUDY-113). `body` runs in the replacing transaction.
   */
  async replaceWithEmptyTables(names: string[], body?: (db: Tx) => Promise<void>) {
    const tablets: number[] = [];
    try {
      for (const name of names) {
        const { number } = this.catalog.table(name);
        tablets.push((await this.createHiddenTable(name, { number, copyIndexesOf: name })).id);
      }
      await this.activateTables(tablets, [], body);
    } catch (e) {
      // The empty tables were never made active: drop them rather than leave them to the stale-table sweep.
      if (tablets.length) await this.dropHiddenTables(tablets).catch(() => {});
      throw e;
    }
  }

  /** Delete an active table: invisible at once, its documents removed in the background. */
  async deleteTable(name: string) {
    await this.activateTables([], [name]);
  }

  private deleting: Promise<void> | null = null;
  /**
   * The deletion worker (Convex's table deletion): empties each `deleting` table in batches of ordinary
   * deletes (retention then removes their history), then removes its `_index` and `_tables` documents.
   */
  startTableDeletion() {
    if (this.deleting || !this.catalog.deleting.size) return;
    this.deleting = (async () => {
      try {
        while (!this.closed && this.catalog.deleting.size) {
          // A background worker: let the server's own work run between batches.
          await new Promise((r) => setImmediate(r));
          const t = [...this.catalog.deleting.values()][0]!;
          const done = await this.runMutation(
            async (db) => {
              const docs = await db.queryDef(t).take(TABLE_DELETION_BATCH);
              for (const d of docs) await db.deleteFrom(t, d);
              if (docs.length) return false;
              const { tables, indexes } = await readCatalog(db);
              for (const i of indexes) if (i.tablet === t.id) await db.delete(INDEX_TABLE, i._id);
              const meta = tables.find((x) => x.tablet === t.id);
              if (meta) await db.delete(TABLES_TABLE, meta._id);
              db.onCommitVisible = () => {
                this.catalog = this.catalog.withTableStates({ gone: [t.id] });
              };
              return true;
            },
            true,
            "_system/delete_table",
          );
          void done;
        }
      } catch (e) {
        if (!this.closed) console.error(`bunvex: table deletion failed: ${(e as Error).message}`);
      } finally {
        this.deleting = null;
      }
    })();
  }

  /** Wait until no table is being deleted (tests). */
  async tablesDeleted() {
    while (this.deleting) await this.deleting;
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

  /**
   * A transaction's first `_creationTime`: the clock floored at its snapshot, past the previous transaction's
   * start and every `_creationTime` it has handed out (several documents of one transaction in the same ms
   * would otherwise sort after the next transaction's first).
   */
  private transactionStart(snapshotUs: number): number {
    const last = this.lastTx ? Math.max(this.lastStart, this.lastTx.creationCursor) : this.lastStart;
    this.lastStart = transactionStart(snapshotUs, preciseClock(), last);
    return this.lastStart;
  }

  /** Run `body` in a new transaction at `snapshot`, as a deterministic execution frozen at its start. */
  private async execute<T>(
    kind: ExecutionKind,
    snapshot: number,
    body: TxBody<T>,
    system = false,
    caller: Caller = ANONYMOUS,
  ) {
    const now = this.transactionStart(snapshot); // the first _creationTime; Date.now() in the body is its floor
    const tx = new Tx(this.catalog, this.persistence, snapshot, kind === "mutation", now, system);
    this.lastTx = tx;
    tx.retention = this.retention;
    tx.identity = caller.identity;
    tx.request = caller.request ?? null;
    tx.cursorCodec = this.cursorCodecOf;
    tx.searchIndexes = this.searchIndexes;
    tx.vectorIndexes = this.vectorIndexes;
    tx.tableCount = this.tableCountOf;
    if (kind === "mutation") {
      tx.docValidators = this.docValidators;
      tx.pendingValidators = this.pendingValidators;
    }
    if (this.tracerOf.on) this.indexSpansOf(tx);
    const observed: Observed = { time: false };
    // Its count changes are kept while it runs (STUDY-107): a `count()` holds at its snapshot, however old.
    const unpin = this.tableSummaries.pin(snapshot);
    try {
      const value = settled(observed, await runDeterministic(kind, now, () => body(tx), observed));
      return { tx, value, observed, now };
    } finally {
      tx.indexSpans?.finish();
      unpin();
    }
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
    // Why the result found was not served, for the miss's reason (STUDY-131 AD-25).
    let dropped: MissReason | undefined;
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
      } else {
        this.cache.noteMiss(keys, e === undefined ? dropped : "snapshot");
        return this.runCached(body, ts, keys, key, e === undefined, companion, caller);
      }
      dropped = this.stillValid(key, r, ts);
      if (dropped !== undefined) continue;
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
  private stillValid(key: string, r: CachedResult, ts: number): MissReason | undefined {
    if (ts < r.originalTs) return "snapshot";
    let why: MissReason | undefined = this.committer.changedBetween(r.reads, r.tokenTs, ts) ? "invalidated" : undefined;
    if (
      why === undefined &&
      r.observedTime &&
      Math.abs((this.opts.cacheClock ?? wallClock)() - r.unixMs) > MAX_CACHE_AGE_MS
    )
      why = "expired";
    if (why !== undefined) this.cache.removeReady(key, r.originalTs);
    // A hit moves the entry's token to `ts`, so the next check only walks the commits after it: what
    // Convex's step 4 says a hit does ("this will bump the cache result's token"), though its guard only
    // writes back a fresh run's result (STUDY-08 §1.1). Not observable: the result is the same.
    else if (r.tokenTs < ts) r.tokenTs = ts;
    return why;
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
      /** What it read (STUDY-131 AD-25). */
      documentsRead: number;
      bytesRead: number;
    }
  > {
    const snapshot = at === undefined ? this.committer.visibleTs : Math.min(at, this.committer.visibleTs);
    const now = this.transactionStart(snapshot); // as in execute(): the first _creationTime; Date.now() is its floor
    const tx = new Tx(this.catalog, this.persistence, snapshot, false, now);
    this.lastTx = tx;
    tx.retention = this.retention;
    tx.cursorCodec = this.cursorCodecOf;
    tx.identity = caller.identity;
    tx.searchIndexes = this.searchIndexes;
    tx.vectorIndexes = this.vectorIndexes;
    tx.tableCount = this.tableCountOf;
    tx.request = caller.request ?? null;
    // Reactive pagination: a re-run ends its page where the previous run ended (Convex's QueryJournal).
    tx.prevEndCursor = journal.endCursor ?? null;
    const out = () => ({
      reads: tx.reads,
      ts: snapshot,
      journal: { endCursor: tx.nextEndCursor },
      identityObserved: tx.identityObserved,
      documentsRead: tx.usage.documentsRead,
      bytesRead: tx.usage.bytesRead,
    });
    if (this.tracerOf.on) this.indexSpansOf(tx);
    const unpin = this.tableSummaries.pin(snapshot); // as in execute()
    try {
      const observed: Observed = { time: false };
      const value = settled(observed, await runDeterministic("query", now, () => body(tx), observed));
      return { ok: true, value, ...out() };
    } catch (error) {
      return { ok: false, error, ...out() };
    } finally {
      tx.indexSpans?.finish();
      unpin();
    }
  }

  /**
   * A read-write transaction, re-run on conflict with Convex's retry budget and backoff; an `OccError`
   * once the budget is spent. `source` names the mutation (e.g. "messages:send") in the conflict errors of
   * the transactions it beats.
   */
  mutation<T>(body: TxBody<T>, source?: string, caller?: Caller, opts?: MutationOptions): Promise<T> {
    return this.runMutation(body, false, source, false, caller, opts?.throttled);
  }

  /**
   * The same, with the commit timestamp (the snapshot, for a mutation that wrote nothing): what the sync
   * protocol's MutationResponse carries so a client can wait for its queries to reflect the write.
   */
  mutationWithTs<T>(
    body: TxBody<T>,
    source?: string,
    caller?: Caller,
    opts?: MutationOptions,
  ): Promise<{ value: T; ts: number }> {
    return this.runMutation(body, false, source, true, caller, opts?.throttled);
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
    opts?: MutationOptions,
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
      opts?.throttled,
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
    throttled?: boolean,
  ): Promise<T>;
  private runMutation<T>(
    body: TxBody<T>,
    system: boolean,
    source: string | undefined,
    withTs: true,
    caller?: Caller,
    throttled?: boolean,
  ): Promise<{ value: T; ts: number }>;
  // `withTs` rather than a wrapper, so the common path costs no extra promise.
  private async runMutation<T>(
    body: TxBody<T>,
    system: boolean,
    source?: string,
    withTs = false,
    caller: Caller = ANONYMOUS,
    throttled = false,
  ): Promise<unknown> {
    const maxRetries = this.opts.maxRetries ?? OCC_MAX_RETRIES;
    const initialMs = this.opts.occInitialBackoffMs ?? OCC_INITIAL_BACKOFF_MS;
    const maxMs = this.opts.occMaxBackoffMs ?? OCC_MAX_BACKOFF_MS;
    for (let failures = 0; ; ) {
      // Each attempt of a mutation first checks the write throughput limit (STUDY-78), as Convex's
      // `run_mutation_no_udf_log`; refused, it is retried within the OCC budget and backoff, then fails.
      if (throttled && !this.writeThroughput.allowsNow()) {
        if (failures >= maxRetries)
          throw new TooManyWritesError(this.writeThroughput.maxBytesPerSecond, this.writeThroughput.windowMs);
        const sleep = occBackoffMs(failures, initialMs, maxMs);
        failures++;
        this.stats.writeThroughputRetries++;
        await new Promise((r) => setTimeout(r, sleep));
        continue;
      }
      const { tx, value: raw } = await this.execute("mutation", this.committer.visibleTs, body, system, caller);
      // `db.vars.commitTs` in the result resolves to the commit's timestamp (STUDY-53): in nanoseconds.
      const resolved = (ts: number) => (hasCommitTs(raw) ? resolveCommitTs(raw, BigInt(ts) * 1000n) : raw);
      if (!tx.hasWrites) {
        const value = resolved(tx.snapshot);
        return withTs ? { value, ts: tx.snapshot } : value;
      }
      this.checkMemoryIndexSizes(tx);
      const { docs, idx } = tx.toWrites();
      try {
        const pending: Parameters<Committer["commit"]>[0] = {
          snapshot: tx.snapshot,
          reads: tx.reads,
          docs,
          idx,
          source,
          ...this.searchCommit(tx, this.withPendingCheck(tx)),
          ...(tx.hasCommitTs
            ? {
                atTs: (ts: number) => {
                  tx.resolveCommitTs(BigInt(ts) * 1000n);
                  return tx.toWrites();
                },
              }
            : {}),
        };
        if (this.tracerOf.on) {
          const parent = this.tracerOf.current();
          if (parent) pending.trace = new CommitSpans(parent, docs.length, idx.length);
        }
        const ts = await this.committer.commit(pending);
        const value = resolved(ts);
        // Tables the mutation created exist for everyone from now on (their _tables/_index documents are
        // durable; a transaction that raced to create the same table conflicted on _tables and retries).
        for (const [name, c] of tx.createdTables)
          if (!this.catalog.tables.has(name))
            this.catalog.add(
              name,
              c.meta.tablet,
              c.meta.number,
              c.indexes.map((i) => ({ name: i.name, fields: i.fields, id: i.indexId })),
              "active",
              c.def.metaId,
            );
        return withTs ? { value, ts } : value;
      } catch (e) {
        // Only an OCC conflict is retried. An OutOfRetentionError (the snapshot fell out of the write log)
        // is a system error, as in Convex's `run_mutation`, which retries `occ_info()` errors only.
        if (!(e instanceof ConflictError)) throw e;
        const lost = Object.assign(this.occError(e.conflict, source, failures), { attempt: { value: raw } });
        if (failures >= maxRetries) throw lost;
        const sleep = occBackoffMs(failures, initialMs, maxMs);
        this.onOccRetry?.(lost, failures + 1);
        failures++;
        this.stats.retries++;
        await new Promise((r) => setTimeout(r, sleep));
        // As Convex: wait for the write we lost to, so the next snapshot contains it.
        await this.committer.waitForVisible(e.conflict.writeTs);
      }
    }
  }

  /** The OCC error for `conflict`, worded as Convex's (without its documentation link). */
  private occError(conflict: Conflict, source: string | undefined, retries: number): OccError {
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
      { table, documentId, writeSource, writeTs: conflict.writeTs, retries },
    );
  }
}

/**
 * A transaction's first `_creationTime` (ms), as Convex's `CreationTime::for_transaction`
 * (crates/common/src/document.rs): the clock, but never below the snapshot's timestamp rounded up to the
 * millisecond. Commit timestamps are wall-clock microseconds resumed from the store (STUDY-06 D9), so after a
 * restart with the clock behind, the snapshot is ahead of the clock: without the floor a new document would
 * sort before ones it read, and `Date.now()` (floored from this) would go back. Unlike Convex, two
 * transactions of an engine never share a start (`last`, the engine's previous one): bunvex's sub-ms creation
 * times keep same-ms transactions in commit order (parity B5).
 */
export function transactionStart(snapshotUs: number, clockMs: number, last: number): number {
  const t = Math.max(clockMs, Math.ceil(snapshotUs / 1000));
  return t > last ? t : nextUp(last);
}

/** MAX_BYTES_WRITTEN_PER_SECOND (bytes) and WRITE_THROUGHPUT_WINDOW (ms), as Convex's knobs, else defaults. */
function writeThroughputFromEnv(): WriteThroughputOptions {
  const knob = (name: string) => {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name}: not a number of at least 0: ${raw}`);
    return n;
  };
  const maxBytesPerSecond = knob("MAX_BYTES_WRITTEN_PER_SECOND");
  const windowMs = knob("WRITE_THROUGHPUT_WINDOW");
  return {
    ...(maxBytesPerSecond === undefined ? {} : { maxBytesPerSecond }),
    ...(windowMs === undefined ? {} : { windowMs }),
  };
}

/** How a mutation runs: `throttled`, an app's mutation, checks the write throughput limit (STUDY-78). */
export type MutationOptions = { throttled?: boolean };

/** UDF_CACHE_MAX_SIZE (bytes), as Convex's knob, else its default. */
function cacheMaxBytesFromEnv(): number {
  const n = Number(process.env.UDF_CACHE_MAX_SIZE);
  return Number.isFinite(n) && n > 0 ? n : QUERY_CACHE_MAX_BYTES;
}

/** A schema refusing to lose a table (Convex's `SchemaEnforcementError`). */
export class SchemaEnforcementError extends Error {
  readonly code = "SchemaEnforcementError";
}

/** Why `schema` refuses the deletion of `table` (Convex's `check_delete_table`), or null. */
function deletionRefusal(schema: SchemaDefinition, table: string): string | null {
  if (schema.tables.has(table)) return `Failed to delete table "${table}" because it appears in the schema`;
  for (const name of [...schema.tables.keys()].sort())
    if (referencedTables(schema.tables.get(name)!.document.json).has(table))
      return `Failed to delete table "${table}" because \`v.id("${table}")\` appears in the schema of table "${name}"`;
  return null;
}

async function readCatalog(db: Tx) {
  return {
    tables: (await db.query(TABLES_TABLE).collect()) as unknown as TableMeta[],
    indexes: databaseIndexRows(await db.query(INDEX_TABLE).collect()),
    nextTablet: await readNextTablet(db),
    nextIndexId: await readNextIndexId(db),
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

/**
 * The search and vector indexes' states, from their `_index` rows read straight from a store at its latest commit
 * (tests and tools, STUDY-111).
 */
export async function readSearchIndexStates(persistence: Persistence): Promise<{ indexes: IndexSegmentsState[] }> {
  const ts = (await persistence.maxTs?.()) ?? 0;
  const tx = new Tx(bootstrapCatalog(), persistence, ts, false, wallClock(), true);
  const rows = (await tx.query(INDEX_TABLE).collect()) as Record<string, unknown>[];
  return { indexes: rows.filter(isSearchIndexRow).flatMap((r) => rowToState(r) ?? []) };
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

/**
 * A vector search filter (Convex's `VectorSearchExpression`, STUDY-51): `{$eq: [{$field}, {$literal}]}`
 * and `{$or: [...]}`, flattened to each field's set of values (their sort keys).
 */
function vectorFilter(x: unknown, out: VectorFilter = new Map()): VectorFilter {
  const o = x as Record<string, unknown>;
  if (o && typeof o === "object" && Array.isArray(o.$or) && Object.keys(o).length === 1) {
    for (const e of o.$or) vectorFilter(e, out);
    return out;
  }
  if (o && typeof o === "object" && Array.isArray(o.$eq) && Object.keys(o).length === 1) {
    const [f, l] = o.$eq as [Record<string, unknown>, Record<string, unknown>];
    if (!f || typeof f.$field !== "string" || !l || !("$literal" in l))
      throw new Error("`q.eq` must take a field path as its first argument and a value as its second");
    const keys = out.get(f.$field) ?? new Set<string>();
    keys.add(filterKey(l.$literal as never));
    out.set(f.$field, keys);
    return out;
  }
  throw new Error("Filters should be a combination of `q.eq` and `q.or`.");
}

/** A schema prediction (STUDY-56), as Convex's `ComponentSchemaPrediction` for the root component. */
export type IndexChange = "added" | "identical" | "enabled" | "disabled" | "dropped";
export type IndexPrediction = {
  name: string;
  staged: boolean;
  change: IndexChange;
  needsBackfill: boolean;
  numDocs: number;
} & Record<string, unknown>;
export type TableOutcome = "notValidated" | "supersetOfEnforced" | "supersetOfShape" | "mustWalk";
export type TablePrediction = { name: string; outcome: TableOutcome; numDocs: number; sizeBytes: number };
export type SchemaPrediction = { schemaValidation: boolean; tables: TablePrediction[]; indexes: IndexPrediction[] };

// Printed by name only: `console.log` of one never shows the engine's state (inspect.ts).
opaqueToInspect(Engine);

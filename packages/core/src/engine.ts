// The engine: runs transactions against a snapshot, retries mutations on conflict, and caches query
// results by read-set. It executes ANONYMOUS transaction bodies (`db => …`); naming, registering and
// exposing functions is the server's job (@bunvex/server).

import { hostname } from "node:os";
import {
  fromJsonValue,
  type GenericValidator,
  hasCommitTs,
  resolveCommitTs,
  toJsonValue,
  type ValidatorJSON,
  type Value,
  v,
} from "@bunvex/values";
import { BackendStateCache, initializeBackendState } from "./backend-state.ts";
import {
  BOOTSTRAP_GLOBALS,
  BOOTSTRAP_TABLES,
  bootstrapStore,
  loadCatalog,
  loadCatalogRows,
  readBootstrapIds,
} from "./bootstrap.ts";
import {
  type Call,
  type CallHost,
  CallRunner,
  callsRoundTripByDefault,
  inSession,
  isCall,
  outcomeOf,
  REFUSED,
  runTransaction,
  type TxStart,
} from "./call-runner.ts";
import { type CallOutcome, type CallRequest, decodeCallOutcome, encodeCallRequest } from "./call-wire.ts";
import {
  AUTH_TABLE,
  activeTables,
  BACKEND_STATE_TABLE,
  backfillMeta,
  backfillRow,
  bootstrapCatalog,
  buildCatalog,
  CANONICAL_URLS_TABLE,
  Catalog,
  COMPONENTS_TABLE,
  CRON_JOB_LOGS_TABLE,
  CRON_JOBS_TABLE,
  CRON_NEXT_RUN_TABLE,
  DATA_SYNC_PROGRESS_TABLE,
  DATABASE_GLOBALS_TABLE,
  DEPLOYMENT_AUDIT_LOG_TABLE,
  databaseIndexRows,
  EMPTY_CLOUD_SYSTEM_TABLES,
  ENVIRONMENT_VARIABLES_TABLE,
  EXPORTS_TABLE,
  EXTERNAL_DEPS_PACKAGES_TABLE,
  FILE_STORAGE_TABLE,
  type FinishChanges,
  FUNCTION_HANDLES_TABLE,
  finishCatalog,
  HIDDEN_TABLE_PLACEHOLDER,
  hasChanges,
  hasFinishChanges,
  INDEX_BACKFILLS_INDEX,
  INDEX_BACKFILLS_TABLE,
  INDEX_TABLE,
  INDEX_WORKER_METADATA_TABLE,
  INSTANCE_TABLE,
  IndexBackfillingError,
  type IndexMeta,
  IndexStagedError,
  indexStatePatch,
  indexTooLarge,
  LOG_SINKS_TABLE,
  MODULES_TABLE,
  planCatalog,
  S3_EXPORT_STATE_INDEX,
  S3_EXPORT_STATE_TABLE,
  SCHEDULED_JOB_ARGS_TABLE,
  SCHEDULED_JOBS_TABLE,
  SCHEMAS_TABLE,
  SESSION_REQUESTS_TABLE,
  SNAPSHOT_IMPORTS_TABLE,
  SOURCE_PACKAGES_TABLE,
  SYSTEM_TO_VIRTUAL_TABLE,
  TABLES_TABLE,
  type TableMeta,
  tableMeta,
  UDF_CONFIG_TABLE,
  USAGE_LIMITS_TABLE,
  vectorIndexesUnavailable,
} from "./catalog.ts";
import { writeCatalogChanges } from "./catalog-writes.ts";
import {
  Committer,
  type Conflict,
  ConflictError,
  type FlushRetryOptions,
  type Interval,
  MAX_REPEATABLE_TS_GLOBAL,
  type WriteBatchLimits,
  type WriteLogRetention,
} from "./committer.ts";
import { COMPONENT_NAMESPACE_TABLES, type ComponentMeta, componentMeta, componentPath } from "./components.ts";
import type { CursorCodec } from "./cursor.ts";
import {
  checkDatabaseVersion,
  DATABASE_VERSION,
  initializeDatabaseGlobals,
  initializeStorageType,
  type StorageTagInitializer,
  type StorageType,
} from "./database-globals.ts";
import { DeploymentJwtKeys } from "./deployment-jwt.ts";
import {
  installDeterminism,
  type LongTimer,
  longInterval,
  longSleep,
  nextUp,
  outsideExecution,
  timerDelay,
  wallClock,
} from "./determinism.ts";
import { EnvironmentVariables } from "./environment-variables.ts";
import { INDEX_CACHE_MAX_BYTES, IndexCache } from "./index-cache.ts";
import { readNextIndexId } from "./index-ids.ts";
import { INDEX_BACKFILL_DEFAULTS, type IndexBackfillOptions, IndexWorker } from "./index-worker.ts";
import { opaqueToInspect } from "./inspect.ts";
import { indexIdOf, internalIdOf } from "./internal-id.ts";
import { canonicalInstanceSecret, instanceSecretBytes, kbkdfCtrHmacSha256 } from "./kbkdf.ts";
import { knob } from "./knobs.ts";
import {
  hasLease,
  hasRetention,
  type IndexId,
  type Lease,
  LeaseHeldError,
  LeaseLostError,
  type Persistence,
  type TabletId,
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
  checkDocument,
  type DeclaredTable,
  type Doc,
  declaredTables,
  defineSchema,
  documentValidator,
  type EngineSchema,
  MAX_VECTOR_DIMENSIONS,
  maintainedIndexes,
  pushOrder,
  referencedTables,
  type SearchIndexDef,
  SYSTEM_INDEXES,
  type TableDef,
  type VectorIndexDef,
} from "./schema.ts";
import {
  type SchemaJson,
  schemaFailureOf,
  schemaFromJson,
  schemaJsonText,
  schemaKey,
  schemaStateOf,
  schemaToJson,
  stagedValidatorsOf,
} from "./schema-json.ts";
import {
  canReuseFor,
  deleteEnforcedValidationsForSchema,
  deleteValidationsForSchema,
  initializeStagedValidators,
  markStagedValidationFailed,
  markValidationValid,
  markWalkFailed,
  pendingStagedValidations,
  progressThreshold,
  recordValidationProgress,
  retryFailedStagedValidators,
  type StagedCarryOver,
  type StagedValidator,
  stagedValidationsWithProgress,
  startStagedWalk,
  startTableValidation,
  validStagedValidators,
} from "./schema-validations.ts";
import { filterKey, indexedDoc, indexedDocBytes, type SearchIndexEntry, SearchIndexes } from "./search-indexes.ts";
import {
  canPersistSegments,
  changedSince,
  type IndexRowWrite,
  type IndexSegmentsState,
  isSearchIndexRow,
  readSavedStates,
  SEGMENTS_GLOBAL,
  type SearchCompactionConfig,
  type SearchSegmentLimits,
  type SearchSegmentStore,
  SearchSegmentsState,
  type SearchWorkerOptions,
  SegmentFiles,
  SegmentReplay,
  sameSpec,
  searchCompactionFromEnv,
  indexRow as searchIndexRow,
  searchSegmentLimitsFromEnv,
  searchWorkersFromEnv,
  segmentRefs,
  segmentsToCompact,
  stateKey,
} from "./search-segments.ts";
import {
  deleteSessionRequestsBefore,
  SESSION_CLEANUP_CHUNK,
  SESSION_REQUESTS_INDEX,
  type SessionRequestId,
  type SessionRequestOutcome,
} from "./session-requests.ts";
import { NEVER } from "./shapes.ts";
import { TableSummaries, TableSummariesUnavailableError } from "./table-summaries.ts";
import {
  canCheckpoint,
  restoreSummaries,
  SummaryCheckpointer,
  type SummaryCheckpointOptions,
} from "./table-summary-checkpoint.ts";
import { CommitSpans, IndexReadSpans, NO_TRACER, type Tracer } from "./tracing.ts";
import { decodeDoc, type StagedCheck, Tx } from "./tx.ts";
import {
  isSubset,
  documentValidator as subsetDocument,
  type TableOutcome,
  tableValidationOutcome,
} from "./validator-subset.ts";
import {
  DEFAULT_VECTOR_LIMIT,
  MAX_VECTOR_FILTER_CONDITIONS,
  MAX_VECTOR_RESULTS,
  type VectorFilter,
  type VectorIndexEntry,
  VectorIndexes,
  vectorEntry,
} from "./vector-indexes.ts";
import {
  MAX_BYTES_WRITTEN_PER_SECOND,
  MAX_ROWS_WRITTEN_PER_SECOND,
  WRITE_THROUGHPUT_WINDOW_MS,
  WriteThroughputLimiter,
  type WriteThroughputOptions,
} from "./write-throughput.ts";

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
export const OCC_MAX_RETRIES = knob("UDF_EXECUTOR_OCC_MAX_RETRIES", 4);
export const OCC_INITIAL_BACKOFF_MS = knob("UDF_EXECUTOR_OCC_INITIAL_BACKOFF_MS", 100);
export const OCC_MAX_BACKOFF_MS = knob("UDF_EXECUTOR_OCC_MAX_BACKOFF_MS", 2000);
/**
 * A push's `finish_push` retries more (Convex's FINISH_PUSH_MAX_OCC_FAILURES = 8): it reads the `_index` rows
 * the push wrote, which the index backfills keep writing (STUDY-147).
 */
export const FINISH_PUSH_MAX_OCC_FAILURES = knob("FINISH_PUSH_MAX_OCC_FAILURES", 8);
/**
 * Documents a page while a text or vector index is built (Convex's VECTOR_INDEX_WORKER_PAGE_SIZE = 128, which
 * its search flusher uses for both kinds; STUDY-147).
 */
export const SEARCH_BACKFILL_PAGE_SIZE = knob("VECTOR_INDEX_WORKER_PAGE_SIZE", 128, "positive");

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
    readonly info: {
      table?: string;
      /** The component whose table it is; null for the app's (Convex's `OccInfo.component_path`). */
      componentId?: string | null;
      documentId?: string;
      writeSource?: string;
      writeTs: bigint;
      retries: number;
    },
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
export type RequestMetadata = {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
  /** The user's raw token; null for an admin key or none. */
  authToken: string | null;
  /** The scheduled function this execution belongs to, if any. */
  scheduledFunctionId: string | null;
  /**
   * The component whose namespace that job lives in (its `_components` id; null or absent for the app's), as
   * Convex's `parent_scheduled_job` pairs it with the id. Not part of `getRequestMetadata()`.
   */
  scheduledFunctionComponent?: string | null;
};
/**
 * Who runs a transaction. `systemIdentity`: an admin or the system acting as itself, not as a user (Convex's
 * `identity.is_admin() || identity.is_system()`): only it reaches the `_system/` functions.
 */
export type Caller = { identity: unknown; key: string; request?: RequestMetadata; systemIdentity?: boolean };
const ANONYMOUS: Caller = { identity: null, key: "" };
/** Separates a cache key from its identity part; `*` is the identity-free entry. */
const ID_SEP = "\u0001";

/**
 * What a caller keeps with a cached query result and gets back on a hit: the server stores the execution's
 * log lines there, so a cache hit answers them too, as Convex's cache entries do (STUDY-20 D2).
 */
/** A result in the query cache and the key it is stored under, as a subscription's run found or stored it. */
export type CachedEntryRef = { key: string; result: CachedResult };

export type CacheCompanion = {
  /**
   * On a miss: the run to make instead (a transaction body, or the call boundary's dispatch), and what to store with
   * its result afterwards.
   */
  wrap<A extends unknown[], R>(run: (...args: A) => R): { body: (...args: A) => R; capture(): unknown };
  /** On a hit: hand back what was stored. */
  replay(extra: unknown): void;
};

export class Engine {
  readonly committer: Committer;
  /** The index cache (STUDY-136): persistence index reads of every transaction; null when off. */
  readonly indexCache: IndexCache | null;
  /** The resolved tables and indexes (ids from `_tables` / `_index`), loaded by `init()`. */
  catalog: Catalog = new Catalog();
  /** Signs pagination cursors: INSTANCE_SECRET, or the one stored in `_instance` (set by init()). */
  private instanceSecret = "";
  /** The deployment's name (Convex's INSTANCE_NAME): admin keys carry it (STUDY-34). Set by `init()`. */
  instanceName = "";
  /** Document validators of the declared tables (empty when `schemaValidation` is off). */
  private docValidators = new Map<string, GenericValidator>();
  /** The active schema's `_schemas` id (a stored schema), for its staged validations. */
  private activeSchemaId: string | null = null;
  /** The staged validators writes are checked against: the active schema's, then the in-progress one's. */
  private stagedChecks: StagedCheck[] | null = null;
  /** Query results by function, arguments and (when read) identity: an LRU bounded by bytes (STUDY-08 D8). */
  readonly cache: QueryCache;
  /** Bumped when the catalog changes under the cache: a run begun before is not stored. */
  private cacheEpoch = 0;
  /** The last transaction's first `_creationTime` (see `transactionStart`). */
  private lastStart = 0;
  /** The last mutation begun: its creation cursor bounds the next start. */
  private lastTx: Tx | null = null;
  /**
   * The call boundary's in-thread side (STUDY-194, STUDY-190 PR 2a): the services a call's transaction reaches,
   * and the body runner on them. The ids number this engine's requests.
   */
  private readonly inThread: CallHost = {
    begin: (start) => this.beginTx(start),
    pin: (ts) => this.tableSummaries.pin(ts),
    finish: (tx) => this.finishTx(tx),
  };
  private readonly runner = new CallRunner(this.inThread);
  /**
   * Whether calls round-trip through the codec in the thread (STUDY-194 Q7): the `callCodec` option, else on only
   * where the tests turned it on (`roundTripCallsByDefault`).
   */
  readonly callCodec: boolean;
  private callIds = 0;
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
    public schema: EngineSchema,
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
      /** When `max_repeatable_ts` is written (Convex's knobs: 5 s after a commit, every 1–2 h when idle). */
      repeatableTs?: { commitDelayMs?: number; idleMs?: number };
      /** Table summary checkpoints' knobs (STUDY-72); `false`: none, the summaries scanned on every start. */
      summaryCheckpoints?: SummaryCheckpointOptions | false;
      /**
       * Where the search and vector indexes' segments are kept (the `search` blob use case, STUDY-111): flushed
       * as their memory parts grow and at a clean shutdown, loaded at start with the log since. None: the
       * indexes are in memory only, read from their tables at every start.
       */
      searchStorage?: SearchSegmentStore;
      /**
       * Where segments are cached as local files to be read from disk (memory-mapped) when the store does not
       * keep them as local files itself (S3). With neither, segments are held in memory (STUDY-111 PR 9).
       */
      searchCacheDir?: string;
      /** The memory parts' flush thresholds (default: SEARCH_INDEX_SIZE_SOFT_LIMIT / VECTOR_INDEX_SIZE_SOFT_LIMIT). */
      searchSegmentLimits?: Partial<SearchSegmentLimits>;
      /** The compactor's thresholds (default: Convex's, from MIN_COMPACTION_SEGMENTS and the others). */
      searchCompaction?: Partial<SearchCompactionConfig>;
      /** The search index workers' pacing (default: Convex's knobs from the environment). */
      searchWorkers?: Partial<SearchWorkerOptions>;
      /** `false`: staged validators are not walked in the background (tests that look at the rows a push makes). */
      stagedWalk?: boolean;
      /** Awaited between a compaction's build and its commit (tests interleave flushes there). */
      beforeSearchCompactionCommit?: () => Promise<void>;
      /** The background index backfill's knobs (Convex's INDEX_BACKFILL_*; STUDY-29). */
      indexBackfill?: IndexBackfillOptions;
      /**
       * The index cache (STUDY-136): `false` turns it off. By default it is on, sized by INDEX_CACHE_SIZE
       * (512 MiB) with INDEX_CACHE_VERIFY_PERCENT of its hits re-read and compared (0); off for the memory
       * driver (DV-434) unless INDEX_CACHE_SIZE is set; INDEX_CACHE_SIZE=0 turns it off everywhere.
       */
      indexCache?: false | { maxBytes?: number; verifyPercent?: number };
      /**
       * Whether calls round-trip through the call boundary's codec in the thread (STUDY-194 Q7): by default only
       * under the tests (`roundTripCallsByDefault`).
       */
      callCodec?: boolean;
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
    // Commit timestamps from the engine's clock: a test's virtual one moves them too (STUDY-159).
    const runtime = this.runtime;
    this.committer = new Committer(
      persistence,
      opts.writeLogRetention,
      () => runtime.nowNs(),
      opts.flushRetry,
      opts.writeBatch,
    );
    this.cache = new QueryCache(opts.cacheMaxBytes ?? cacheMaxBytesFromEnv());
    this.indexCache = indexCacheOf(persistence, opts.indexCache, this.committer);
    this.callCodec = opts.callCodec ?? callsRoundTripByDefault();
    this.writeThroughput = new WriteThroughputLimiter(opts.writeThroughput ?? writeThroughputFromEnv(), () =>
      runtime.nowNs(),
    );
    this.committer.writeThroughput = this.writeThroughput;
    // A count at an older snapshot (STUDY-107) needs the changes since: kept as long as the write log keeps them.
    this.tableSummaries.retainedAfter = () => this.committer.logStartTs;
    // The table exists once `init()` reconciled the catalog; before that, no commit can write it (-1).
    const backendStateTable = () => this.catalog.tables.get(BACKEND_STATE_TABLE);
    this.backendState = new BackendStateCache(() => backendStateTable()?.byId.id);
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
    // A new store gets its bootstrap rows at ts 0 (Convex's `Database::initialize`); then the start reads its
    // catalog from the bootstrap globals (`Database::load`).
    await bootstrapStore(this.persistence);
    this.catalog = bootstrapCatalog(await readBootstrapIds(this.persistence));
    // A store whose data version bunvex cannot read is refused before anything is written to it (DV-418),
    // `max_repeatable_ts` included, and before the committer starts its bumps.
    const globals = (await readSystemRows(this.persistence, DATABASE_GLOBALS_TABLE))[0];
    if (typeof globals?.version === "bigint") checkDatabaseVersion(globals.version);
    // As Convex's `new_idle_repeatable_ts` at load: every commit of this start is above the store's newest
    // commit, its `max_repeatable_ts` and the clock, and the store records that bound first.
    const m = (await this.persistence.maxTs?.()) ?? 0n;
    const repeatable = await this.persistence.getGlobal(MAX_REPEATABLE_TS_GLOBAL);
    let start = this.committer.clockNow();
    if (m > start) start = m;
    if (typeof repeatable === "bigint" && repeatable > start) start = repeatable;
    await this.persistence.setGlobal(MAX_REPEATABLE_TS_GLOBAL, start);
    this.committer.resume(start);
    this.committer.startRepeatableBumps(async (ts) => {
      await this.persistence.setGlobal(MAX_REPEATABLE_TS_GLOBAL, ts);
    }, this.opts.repeatableTs);
    // A deployable deployment's schema is the last one pushed (STUDY-35): read before reconciling, or the
    // constructor's (empty) schema would drop every index.
    if (this.opts.storedSchema) {
      const active = (await readSystemRows(this.persistence, SCHEMAS_TABLE)).find((r) => schemaStateOf(r) === "active");
      if (active) {
        this.schema = schemaFromJson(JSON.parse(active.schema as string) as SchemaJson);
        this.activeSchemaId = active._id as string;
        this.installValidators(this.schema);
      }
    }
    const backfilling = await this.reconcileCatalog();
    // Each component's schemas too, before the search indexes: its search and vector indexes restore with the
    // app's (STUDY-157 PR 5).
    if (this.opts.storedSchema) await this.loadComponentSchemas();
    // The search and vector indexes of the schema the process starts on existed before it: each loads its
    // segments and replays the log since (STUDY-111), or is read from its table, and searches meanwhile are
    // Convex's bootstrapping answer (STUDY-79).
    await this.loadSearchSegments();
    this.reconcileSearch(true);
    this.reconcileVector(true);
    // A push still waiting builds its new indexes again.
    this.reconcilePendingSearch();
    this.startSearchWorkers();
    // The log since the segments is held only while the indexes it restores are being built.
    void Promise.allSettled([...this.searchBackfills]).then(() => {
      this.segmentReplay = null;
    });
    // The run state's one document, as Convex writes it with the table at the store's first start (`running`).
    await this.runMutation((db) => initializeBackendState(db), true);
    await this.loadInstanceSecret();
    await this.loadInstanceName();
    await this.loadDatabaseGlobals();
    if (this.opts.storedSchema) {
      await this.resumePendingSchema();
      this.kickStagedWalk();
    }
    // The worker belongs to the process that holds the lease: the one that writes (STUDY-24 §4.6).
    if (backfilling) this.startIndexWorker();
    this.summariesBuild = this.buildSummaries().catch((err) => {
      if (!this.closed) console.error(`bunvex: table summaries failed to build: ${err.message}`);
    });
    // So does retention (STUDY-33, Convex's leader-only `LeaderRetentionManager`), on a store that has it.
    if (hasRetention(this.persistence)) {
      this.retention = new Retention(this.persistence, this.committer, this.opts.retention, (tablet) => {
        const t = this.catalog.anyTablet(tablet);
        return t ? maintainedIndexes(t) : [];
      });
      this.retention.onTabletPurged = (tablet) => this.finishTableDeletion(tablet);
      await this.retention.start();
      // Tables left being deleted by an earlier run: purged once the document window passes them (STUDY-195 §1).
      await this.startTableDeletion();
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

  private lease: { store: Lease; timer: LongTimer } | null = null;

  /**
   * The store's lease as this process holds it, for the dashboard's topology (STUDY-131 §11): the holder it was
   * taken as, its scope, when it was taken (wall-clock ms) and how long the last renewal's round trip to the
   * store took (ms; null before the first, and for a "process" lease, whose renewal does not reach the store).
   * Null on a store without a lease. Read only by that route: nothing here is on a hot path.
   */
  leaseState: {
    holder: string;
    scope: "ttl" | "process" | "newest";
    ttlMs: number;
    acquiredAt: number;
    renewalMs: number | null;
  } | null = null;

  private async acquireLease(store: Persistence & Lease) {
    const ttlMs = this.opts.lease?.ttlMs ?? 5000;
    const deadline = Date.now() + (this.opts.lease?.waitMs ?? 0);
    const random = Buffer.from(outsideExecution(() => crypto.getRandomValues(new Uint8Array(4)))).toString("hex");
    const holder = `${hostname()}:${process.pid}:${random}`;
    for (;;) {
      const r = await store.acquireLease({ holder, ttlMs });
      if ("epoch" in r) break;
      if (Date.now() >= deadline) throw new LeaseHeldError(r.heldBy, r.expiresInMs);
      await new Promise((ok) => setTimeout(ok, timerDelay(Math.min(250, Math.max(10, deadline - Date.now())))));
    }
    const state = {
      holder,
      scope: store.leaseScope ?? "ttl",
      ttlMs,
      acquiredAt: Date.now(),
      renewalMs: null as number | null,
    };
    this.leaseState = state;
    // Renew every TTL/3. A lost lease, or renewals failing until the TTL runs out (the store may then give it
    // to another process), stops the committer: fail-stop, as a failed flush. So does a renewal still waiting
    // for the store when the TTL runs out (a hung connection; drivers bound a renewal by a quarter of the TTL,
    // STUDY-25 L3, but a driver without timeouts could wait forever): the lease may already be another
    // process's, and this one must not keep serving as the writer.
    let renewedAt = Date.now();
    let renewing = false;
    const timer = longInterval(async () => {
      if (this.committer.stopped) return;
      if (renewing) {
        if (Date.now() - renewedAt >= ttlMs)
          this.committer.fail(new LeaseLostError("the store did not answer a lease renewal within the lease's TTL"));
        return;
      }
      renewing = true;
      try {
        const began = performance.now();
        await store.renewLease();
        renewedAt = Date.now();
        if (state.scope !== "process") state.renewalMs = performance.now() - began;
      } catch (e) {
        if (e instanceof LeaseLostError) this.committer.fail(e);
        else if (Date.now() - renewedAt >= ttlMs)
          this.committer.fail(new LeaseLostError(`could not renew the store's lease within its TTL: ${e}`));
      } finally {
        renewing = false;
      }
    }, ttlMs / 3).unref();
    this.lease = { store, timer };
  }

  /** Stop writing and hand the store over: let the last group land, release the lease, close the store. */
  private closed = false;
  private closing: Promise<void> | null = null;
  /**
   * Mutations still running (their attempts, each with the operations it left in flight, `Tx.settle`, and its retries'
   * backoff): a close waits for them, so one begun before the close commits before the store closes.
   */
  private readonly runningMutations = new Set<Promise<unknown>>();

  /**
   * Once: a second call (the server's shutdown closes the engine, and so may its owner) waits for the first
   * instead of flushing the search indexes again after the lease is gone (STUDY-133 §12 M15).
   */
  close(): Promise<void> {
    this.closing ??= this.closeOnce();
    return this.closing;
  }

  private async closeOnce() {
    this.closed = true;
    this.untilClosed.reject(new Error("the engine closed"));
    await this.stagedWalk?.catch(() => {});
    await Promise.allSettled([...this.validationWalks]);
    await this.deletedTablesWrite.catch(() => {});
    await this.indexWorker?.stop();
    await this.retention?.stop();
    await this.summaryCheckpointer?.stop();
    this.settleReady(new Error("the engine closed before its indexes were ready"));
    this.committer.stopRepeatableBumps();
    // Until none is left: a background worker's last mutation (a validation walk's progress) may start meanwhile.
    while (this.runningMutations.size) await Promise.allSettled([...this.runningMutations]);
    await this.committer.idle();
    this.workerTimer?.clear();
    // A compaction in progress stops; then every index is flushed.
    await Promise.allSettled([...this.compacting.values()]);
    await this.flushSearchSegments();
    if (this.lease) {
      this.lease.timer.clear();
      if (!this.committer.stopped) await this.lease.store.releaseLease();
      this.lease = null;
    }
    await this.persistence.close();
  }

  /**
   * The secret that signs pagination cursors, as Convex's self-hosted image does it
   * (self-hosted/docker-build/read_credentials.sh): the configured INSTANCE_SECRET wins; otherwise the one
   * stored with the data; otherwise a random one, generated once and stored (in `_instance`, since the data
   * may live in a remote database rather than a directory). It is kept in one spelling (`0x`-prefixed or
   * uppercase hex as the bare lowercase digits, STUDY-172 §7): `secretKey` hashes its text.
   */
  private async loadInstanceSecret() {
    if (this.opts.instanceSecret) {
      this.instanceSecret = canonicalInstanceSecret(this.opts.instanceSecret);
      return;
    }
    const stored = await this.runMutation(async (db) => {
      const stored = (await db.query(INSTANCE_TABLE).first()) as { instanceSecret?: string } | null;
      if (stored?.instanceSecret) return stored.instanceSecret;
      const secret = Buffer.from(outsideExecution(() => crypto.getRandomValues(new Uint8Array(32)))).toString("hex");
      await db.insert(INSTANCE_TABLE, { instanceSecret: secret });
      return secret;
    }, true);
    this.instanceSecret = canonicalInstanceSecret(stored);
  }

  /**
   * The database's globals (`_db`, STUDY-126), written at the store's first start as Convex's bootstrap
   * does. Its version is checked (DV-418): an older one is refused; a newer one is warned about, as Convex's
   * migration worker does.
   */
  private async loadDatabaseGlobals() {
    const uuid = outsideExecution(() => crypto.randomUUID());
    const version = await this.runMutation((db) => initializeDatabaseGlobals(db, () => uuid), true);
    if (checkDatabaseVersion(version) === "newer")
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

  private deploymentJwtKeysCache: { secret: string; keys: DeploymentJwtKeys } | null = null;
  /**
   * The deployment's JWT signing keys (`ctx.auth.signJwt`, `/.well-known/jwks.json`, STUDY-192): derived from the
   * instance secret as Convex's keybroker derives them, so the same secret signs and publishes the same keys.
   */
  get deploymentJwtKeys(): DeploymentJwtKeys {
    if (!this.instanceSecret) throw new Error("deploymentJwtKeys: the engine is not initialized");
    const c = this.deploymentJwtKeysCache;
    if (c && c.secret === this.instanceSecret) return c.keys;
    const keys = DeploymentJwtKeys.fromSecret(instanceSecretBytes(this.instanceSecret));
    this.deploymentJwtKeysCache = { secret: this.instanceSecret, keys };
    return keys;
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
      "_system/init_storage",
    );
  }

  /** Every table the engine declares: its own system tables, then the schema's. */
  private allDeclaredTables(schema: EngineSchema = this.schema): DeclaredTable[] {
    const systemTables: DeclaredTable[] = [
      // Convex's bootstrap tables, created with the store (bootstrap.ts), then its application system tables.
      ...BOOTSTRAP_TABLES.map((t) => ({ name: t.name, indexes: t.indexes, document: v.any() })),
      { name: INSTANCE_TABLE, indexes: {}, document: v.any() },
      { name: DATABASE_GLOBALS_TABLE, indexes: {}, document: v.any() },
      {
        name: SESSION_REQUESTS_TABLE,
        indexes: { [SESSION_REQUESTS_INDEX]: ["sessionId", "requestId"] },
        document: v.any(),
      },
      { name: SCHEDULED_JOBS_TABLE, indexes: SCHEDULED_JOBS_INDEXES, document: v.any() },
      { name: SCHEDULED_JOB_ARGS_TABLE, indexes: {}, document: v.any() },
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
      { name: ENVIRONMENT_VARIABLES_TABLE, indexes: { by_name: ["name"] }, document: v.any() },
      { name: AUTH_TABLE, indexes: {}, document: v.any() },
      {
        name: EXPORTS_TABLE,
        indexes: { by_state_and_ts: ["state", "start_ts"], by_requestor: ["requestor", "_creationTime"] },
        document: v.any(),
      },
      { name: SNAPSHOT_IMPORTS_TABLE, indexes: {}, document: v.any() },
      { name: LOG_SINKS_TABLE, indexes: {}, document: v.any() },
      {
        name: S3_EXPORT_STATE_TABLE,
        indexes: { [S3_EXPORT_STATE_INDEX]: ["configId", "_creationTime"] },
        document: v.any(),
      },
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
      // Convex's, kept empty: Convex creates them on every start (STUDY-133 §12 M1).
      { name: EXTERNAL_DEPS_PACKAGES_TABLE, indexes: {}, document: v.any() },
      ...EMPTY_CLOUD_SYSTEM_TABLES.map((name) => ({ name, indexes: {}, document: v.any() })),
    ];
    return [...systemTables, ...pushOrder(declaredTables(schema).values())];
  }

  /**
   * Reserve a new component's namespace (Convex's `initialize_component_namespace`, run by a push's start): a
   * `_components` id no row has yet, and that namespace's system tables (`COMPONENT_NAMESPACE_TABLES`) at the
   * root's numbers, their indexes enabled at once. The push writes the component's row with this id when it
   * finishes (STUDY-152 step 2). The id.
   */
  /**
   * Delete an unmounted component and every component under it (Convex's `ComponentConfigModel::delete_component`),
   * in one commit: their `_components` rows, then every table of their namespaces, system tables included, deleted
   * in the background. A component still mounted, or with a mounted one under it, is refused
   * (`ComponentMustBeUnmounted`); an id with no component is Convex's system error. `body` runs in the commit (the
   * server records its audit event there) and is given the component's path.
   */
  async deleteComponent(id: string, body?: (db: Tx, path: string[]) => Promise<void>) {
    const deleted: TableDef[] = [];
    let gone: string[] = [];
    await this.runMutation(
      async (db) => {
        const path = await componentPath(db, id);
        if (path === null) throw new Error(`Component Child(${id}) not found`);
        const rows = (await db.query(COMPONENTS_TABLE).collect()).map((r) =>
          componentMeta(r as Record<string, unknown>),
        );
        const start = rows.find((r) => r._id === id)!;
        if (start.parent === null) throw new Error("Cannot delete root component");
        const stack: ComponentMeta[] = [start];
        const ids: string[] = [];
        for (let c = stack.pop(); c; c = stack.pop()) {
          if (c.state !== "unmounted")
            throw new ComponentDeletionError("ComponentMustBeUnmounted", "Component must be unmounted before deletion");
          stack.push(...rows.filter((r) => r.parent === c!._id));
          ids.push(c._id);
        }
        const { tables } = await readCatalog(db);
        const deleting: TabletId[] = [];
        for (const c of ids) {
          await db.delete(COMPONENTS_TABLE, c);
          for (const t of tables)
            if (t.namespace === c && t.state !== "deleting") {
              await db.patch(TABLES_TABLE, t._id, { state: "deleting" });
              deleting.push(t.tablet);
            }
        }
        const purge = await this.dropDeletedTableIndexes(db, deleting);
        if (body) await body(db, path);
        gone = ids;
        db.onCommitVisible = (ts) => {
          this.noteDeletedTables(purge, ts);
          const next = this.catalog.withTableStates({});
          const components = new Map(next.components);
          for (const c of gone) {
            const ns = components.get(c);
            if (ns)
              for (const t of [...ns.tables.values(), ...ns.hidden.values(), ...ns.deleting.values()]) deleted.push(t);
            components.delete(c);
            this.componentSchemas.delete(c);
          }
          for (const t of deleted) next.deleting.set(t.id, t);
          next.components = components;
          this.catalog = next;
          this.cache.clear();
          this.cacheEpoch++;
          // Its search and vector indexes go with its schema (STUDY-157 PR 5).
          this.reconcileSearch();
          this.reconcileVector();
        };
      },
      true,
      "_system/delete_component",
      true,
    );
  }

  /**
   * A new `_components` id, nothing written: the app's, on its first push with components (Convex's
   * `initialize_component_namespace` for the root, whose namespace is the global one).
   */
  async allocateComponentId(): Promise<string> {
    return this.runMutation(async (db) => db.newId(COMPONENTS_TABLE), true);
  }

  async initializeComponentNamespace(): Promise<string> {
    const declared = this.allDeclaredTables().filter((t) => COMPONENT_NAMESPACE_TABLES.has(t.name));
    return this.runMutation(async (db) => {
      const id = db.newId(COMPONENTS_TABLE);
      const current = await readCatalog(db);
      const changes = planCatalog(declared, current.tables, current.indexes, false, current.nextIndexId, id);
      await writeCatalogChanges(db, changes, this.createdLowerBound(db));
      const after = await readCatalog(db);
      db.onCommitVisible = () => {
        this.catalog = buildCatalog(after.tables, after.indexes);
      };
      return id;
    }, true);
  }

  /**
   * Start the schema change (Convex's `start_push` / `prepare_new_and_mutated_indexes`): create missing
   * tables, add new indexes as `backfilling`, drop pending indexes no longer declared. If nothing is left to
   * backfill, finish it at once; otherwise the worker does once it is. Whether anything is backfilling.
   */
  private async reconcileCatalog(): Promise<boolean> {
    // The stored catalog first (Convex's `load_table_and_index_metadata`, from the bootstrap tables), so the
    // change below sees the system tables it reads.
    const stored = await this.runMutation((db) => readCatalog(db), true);
    this.catalog = buildCatalog(stored.tables, stored.indexes);
    let created: TabletId[] = [];
    let { tables, indexes } = await this.runMutation(async (db) => {
      const current = await readCatalog(db);
      const changes = planCatalog(this.allDeclaredTables(), current.tables, current.indexes, true, current.nextIndexId);
      if (!hasChanges(changes)) return current;
      const written = await writeCatalogChanges(db, changes, this.createdLowerBound(db));
      created = [...written.tables.values()].map((t) => t.tablet);
      // Read-your-own-writes: the catalog as this commit leaves it, installed as soon as the commit is visible,
      // so a mutation it made conflict (`catalogTouches`) runs again with the new indexes.
      const after = await readCatalog(db);
      db.onCommitVisible = () => {
        this.catalog = buildCatalog(after.tables, after.indexes);
      };
      return after;
    }, true);
    this.catalog = buildCatalog(tables, indexes);
    if (await this.backfillNewTables(created, indexes, true))
      ({ tables, indexes } = await this.runMutation(readCatalog, true));
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
        const f = finishCatalog(this.allDeclaredTables(), tables, indexes);
        if (!f) return false;
        if (!hasFinishChanges(f)) return true;
        for (const i of f.drop) {
          await db.delete(INDEX_TABLE, i._id);
        }
        for (const i of f.enable) await db.patch(INDEX_TABLE, i._id, indexStatePatch(i, { state: "enabled" }));
        for (const i of f.disable)
          await db.patch(INDEX_TABLE, i._id, indexStatePatch(i, { state: "backfilled", staged: true }));
        const ids = (l: IndexMeta[]) => l.map((i) => i.indexId);
        db.onCommitVisible = (ts) =>
          this.installIndexChanges({ enable: ids(f.enable), disable: ids(f.disable), drop: ids(f.drop) }, ts);
        return true;
      },
      true,
      "_system/index_finish_schema",
    );
    if (finished) this.settleReady();
    return finished;
  }

  private installValidators(schema: EngineSchema) {
    this.docValidators = validatorsOf(schema);
  }

  /**
   * The staged validators every write is checked against (Convex's `enforce_with_table_mapping`, 900fe2c): the
   * active schema's, and the in-progress (pending or validated) one's, whose staged validation runs from its push.
   */
  private refreshStagedChecks() {
    const checks: StagedCheck[] = [];
    const add = (schemaId: string, schema: EngineSchema) => {
      const validators = stagedDocumentValidatorsOf(schema);
      if (validators.size) checks.push({ schemaId, validators });
    };
    if (this.activeSchemaId) add(this.activeSchemaId, this.schema);
    const p = this.pendingPush;
    if (p && p.id !== this.activeSchemaId) add(p.id, p.schema);
    this.stagedChecks = checks.length ? checks : null;
  }

  /**
   * A new index's `indexCreatedLowerBound`, for one created in `db`: at or below the commit's ts, as Convex's
   * begin timestamp: the clock now (a commit's ts is at least the clock then), or the snapshot.
   */
  private createdLowerBound(db: Tx): bigint {
    const now = this.committer.clockNow();
    return db.snapshot > now ? db.snapshot : now;
  }

  /**
   * The user indexes of tables a schema change just created: Convex backfills them as any other
   * (`Backfilling` → `Backfilled2`, its `_index_backfills` row), and so does bunvex, at once — the tables are
   * new, so there is next to nothing to copy — so that the change can finish without waiting for the worker.
   * Whether there were any.
   */
  private async backfillNewTables(created: TabletId[], indexes: IndexMeta[], atStart = false): Promise<boolean> {
    if (!this.backfillEnabled) return false;
    const fresh = indexes.filter((i) => i.state === "backfilling" && created.includes(i.tablet));
    if (!fresh.length) return false;
    this.indexWorker ??= new IndexWorker(this.workerHost(), this.opts.indexBackfill);
    // At the engine's start nothing can write before `init` returns: a table it just created is empty, which
    // stands for its count while the table summaries are still being built.
    await this.indexWorker.backfillNow(fresh, atStart);
    return true;
  }

  /** `INDEX_BACKFILL_ENABLE`: off, no database index is backfilled, so none leaves `backfilling` (Convex's). */
  private get backfillEnabled(): boolean {
    return this.opts.indexBackfill?.enabled ?? INDEX_BACKFILL_DEFAULTS.enabled;
  }

  /** Never settles while the engine is open; rejects once it closes (what waits on a backfill that never runs). */
  private readonly untilClosed = (() => {
    const w = Promise.withResolvers<never>();
    w.promise.catch(() => {});
    return w;
  })();

  private startIndexWorker() {
    // Not once the engine is closing: its stop has run or is running, and nothing would stop a worker started now
    // (a push that lands during `close()`, STUDY-174 S4), as nothing restarts Convex's aborted worker.
    if (!this.backfillEnabled || this.closed) return;
    this.indexWorker ??= new IndexWorker(this.workerHost(), this.opts.indexBackfill);
    this.indexWorker.start();
  }

  /** The schema change a push started and has not finished: its `_schemas` row and the schema. */
  private pendingPush: { id: string; schema: EngineSchema } | null = null;
  /** The pending schema's document validators, checked on every write (but not enforced) until it finishes. */
  private pendingValidators: Map<string, GenericValidator> | null = null;
  /** The background walk of a pending schema's existing documents (STUDY-35 PR 5). */
  private validation: Promise<unknown> | null = null;
  /** The background walk of staged validators (STUDY-106 §7.3), and whether it must run again once done. */
  private stagedWalk: Promise<void> | null = null;
  private stagedWalkAgain = false;
  /**
   * Each component's schema, by its `_components` id (STUDY-153 PR 2b): the active one (its `_schemas` row in the
   * component's namespace) and the one a push started there and has not finished. The root's are `schema`,
   * `activeSchemaId` and `pendingPush`. Writes in a component are checked against its schema from step 4.
   */
  private readonly componentSchemas = new Map<string, ComponentSchemas>();

  /** The schema active in component `id`'s namespace (an empty one before any push there). */
  componentSchema(id: string): EngineSchema {
    return this.componentSchemas.get(id)?.schema ?? EMPTY_SCHEMA;
  }

  /** Component `id`'s schema state, created empty. */
  private schemasOf(id: string): ComponentSchemas {
    let c = this.componentSchemas.get(id);
    if (!c) {
      c = { schema: EMPTY_SCHEMA, validators: new Map(), activeSchemaId: null, pendingPush: null };
      this.componentSchemas.set(id, c);
    }
    return c;
  }

  /** The id of the schema a push started in a namespace (null: the root's) and has not finished. */
  private pendingIdIn(namespace: string | null): string | undefined {
    return namespace === null ? this.pendingPush?.id : this.componentSchemas.get(namespace)?.pendingPush?.id;
  }

  /** A namespace's catalog: the root's (null), or a component's (empty when it has no table). */
  private catalogIn(namespace: string | null): Catalog {
    return namespace === null ? this.catalog : (this.catalog.components.get(namespace) ?? new Catalog());
  }

  /**
   * Each component's schemas at a start: its active one, and a push's pending (or validated) one, whose walk of the
   * existing documents starts again as the root's does (`resumePendingSchema`).
   */
  private async loadComponentSchemas() {
    const ids = [...this.catalog.components.keys()];
    const rows = await this.runMutation(
      async (db) => {
        const out: [string, Record<string, unknown>[]][] = [];
        for (const id of ids) out.push([id, await db.inComponent(id, () => db.query(SCHEMAS_TABLE).collect())]);
        return out;
      },
      true,
      "_system/init_app_system_tables",
    );
    for (const [id, schemas] of rows) {
      const active = schemas.find((r) => schemaStateOf(r) === "active");
      const pending = schemas.find((r) => {
        const state = schemaStateOf(r);
        return state === "pending" || state === "validated";
      });
      if (!active && !pending) continue;
      const c = this.schemasOf(id);
      if (active) {
        c.schema = schemaFromJson(JSON.parse(active.schema as string) as SchemaJson);
        c.validators = validatorsOf(c.schema);
        c.activeSchemaId = active._id as string;
      }
      if (pending) {
        const schema = schemaFromJson(JSON.parse(pending.schema as string) as SchemaJson);
        c.pendingPush = { id: pending._id as string, schema };
        if (schemaStateOf(pending) === "pending") this.startValidation(pending._id as string, schema, c.schema, id);
      }
    }
  }

  /**
   * A commit's search part (STUDY-45 PR 3): its versions and their read-set keys. Its searches to check come with
   * the call's outcome (`CallOutcome.searchReads`).
   */
  private searchCommit(tx: Tx, own: ((ts: bigint) => void) | undefined) {
    const writes = tx.writtenDocs();
    const { docs, keys, indexed } = this.searchIndexes.commitWrites(writes);
    // A commit timestamp (STUDY-53) is written into the documents at `atTs`, after this commit is built: the
    // indexes then take the resolved versions. The OCC and log keys above keep the placeholder's, which no
    // search can name before the commit has its timestamp.
    const resolvesLater = tx.hasCommitTs;
    return {
      // The search indexes are brought up to date with the commit as it becomes visible, in commit order.
      onVisible: (ts: bigint) => {
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
      ...(docs.length ? { searchDocs: docs, logExtra: keys } : {}),
    };
  }

  /**
   * Each active table with its declaration in its namespace's active schema: the app's, then each component's
   * (STUDY-157 PR 5), whose search and vector indexes are built and served as the app's.
   */
  private *declaredActiveTables(): Iterable<[TableDef, DeclaredTable]> {
    for (const [name, declared] of declaredTables(this.schema)) {
      const t = this.catalog.tables.get(name);
      if (t) yield [t, declared];
    }
    for (const [id, c] of this.componentSchemas) {
      const space = this.catalog.components.get(id);
      if (!space) continue;
      for (const [name, declared] of declaredTables(c.schema)) {
        const t = space.tables.get(name);
        if (t) yield [t, declared];
      }
    }
  }

  /**
   * The search and vector indexes a pending schema push adds, by active table (STUDY-195 §2): the app's pending
   * schema's, then each component's, each index whose name its table's active schema does not declare. A redefined
   * index is rebuilt when the push commits, as before.
   */
  private *pendingSearchDeclared(): Iterable<{
    t: TableDef;
    search: [string, SearchIndexDef, boolean][];
    vector: [string, VectorIndexDef, boolean][];
  }> {
    const spaces: [EngineSchema, EngineSchema, Catalog["tables"]][] = [];
    if (this.pendingPush) spaces.push([this.pendingPush.schema, this.schema, this.catalog.tables]);
    for (const [id, c] of this.componentSchemas) {
      const space = this.catalog.components.get(id);
      if (c.pendingPush && space) spaces.push([c.pendingPush.schema, c.schema, space.tables]);
    }
    for (const [pushed, active, tables] of spaces) {
      const activeTables = declaredTables(active);
      for (const [name, declared] of declaredTables(pushed)) {
        const t = tables.get(name);
        if (!t) continue;
        const now = activeTables.get(name);
        const stagedSearch = new Set(declared.stagedSearch ?? []);
        const stagedVector = new Set(declared.stagedVector ?? []);
        const search = Object.entries(declared.searchIndexes ?? {})
          .filter(([n]) => !now?.searchIndexes?.[n])
          .map(([n, d]) => [n, d, stagedSearch.has(n)] as [string, SearchIndexDef, boolean]);
        const vector = Object.entries(declared.vectorIndexes ?? {})
          .filter(([n]) => !now?.vectorIndexes?.[n])
          .map(([n, d]) => [n, d, stagedVector.has(n)] as [string, VectorIndexDef, boolean]);
        if (search.length || vector.length) yield { t, search, vector };
      }
    }
  }

  /**
   * Build the search and vector indexes a pending schema push adds while the push waits (Convex's pending indexes,
   * STUDY-195 §2): `schemaPushStatus` stays in progress until they are, and the commit enables them as they are.
   */
  private reconcilePendingSearch() {
    const search = [];
    const vector = [];
    for (const { t, search: s, vector: v } of this.pendingSearchDeclared()) {
      for (const [name, def, staged] of s) search.push({ table: t, name, def, staged });
      for (const [name, def, staged] of v) vector.push({ table: t, name, def, staged });
    }
    for (const e of this.searchIndexes.reconcilePending(search, this.committer.visibleTs)) {
      const p = this.backfillSearch(e).catch((err) => {
        if (!this.closed) console.error(`bunvex: search index ${e.table}.${e.name} failed to build: ${err.message}`);
      });
      this.searchBackfills.add(p);
      void p.finally(() => this.searchBackfills.delete(p));
    }
    for (const e of this.vectorIndexes.reconcilePending(vector)) {
      const p = this.backfillVector(e).catch((err) => {
        if (!this.closed) console.error(`bunvex: vector index ${e.table}.${e.name} failed to build: ${err.message}`);
      });
      this.searchBackfills.add(p);
      void p.finally(() => this.searchBackfills.delete(p));
    }
    this.scheduleIndexRowsSync();
  }

  /**
   * Make the search indexes the active schema's (STUDY-45): after the schema or the tables change. A new
   * index is backfilled from its table at one snapshot; commits meanwhile are applied as they land.
   */
  private reconcileSearch(bootstrapping = false) {
    const wanted = [];
    for (const [t, declared] of this.declaredActiveTables()) {
      if (!declared.searchIndexes) continue;
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
    for (const [t, declared] of this.declaredActiveTables()) {
      if (!declared.vectorIndexes) continue;
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
    if (blobs) {
      const files = new SegmentFiles(blobs, this.opts.searchCacheDir ?? null);
      if (files.enabled) state.files = files;
    }
    state.load(
      await this.runMutation((db) => db.query(INDEX_TABLE).collect() as Promise<Record<string, unknown>[]>, true),
      store ? readSavedStates(await store.getGlobal(SEGMENTS_GLOBAL)) : null,
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
    const oldest = new Map<TabletId, bigint>();
    for (const s of state.all()) {
      const ts = state.currentTs(s);
      const o = oldest.get(s.tablet);
      oldest.set(s.tablet, o !== undefined && o < ts ? o : ts);
    }
    this.segmentReplay = new SegmentReplay(store, this.committer.visibleTs, decodeDoc, oldest, (tablet) => {
      const t = this.catalog.anyTablet(tablet);
      if (!t) throw new Error(`no table has tablet ${tablet}`);
      return t.number;
    });
  }

  /** The search index workers' pacing. */
  private get workers(): SearchWorkerOptions {
    return { ...searchWorkersFromEnv(), ...this.opts.searchWorkers };
  }
  private workerTimer: LongTimer | null = null;
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
    // Any length: DATABASE_WORKERS_POLL_INTERVAL is a knob.
    this.workerTimer = longInterval(() => {
      void this.searchWorkersTick().catch((err) => {
        if (!this.closed) console.error(`bunvex: search index workers failed: ${err.message}`);
      });
    }, this.workers.pollIntervalMs).unref();
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
      if (!e.ready || !s || !e.index.changed.size) continue;
      if (now - state.currentTs(s) >= BigInt(Math.round(w.maxCheckpointAgeMs)) * 1_000_000n)
        this.scheduleFlush(kind, e);
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

  /** Segments mapped from local files since the start (STUDY-111 PR 9; tests and measurements). */
  get searchSegmentsMapped(): number {
    return this.searchSegments?.files?.mapped ?? 0;
  }

  /** A segment just written, mapped from its local file when segments are read from disk (else null). */
  private async mapSegment(key: string, bytes: Uint8Array): Promise<Uint8Array | null> {
    const files = this.searchSegments?.files;
    return files ? files.map(key, bytes) : null;
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
    const t = this.catalog.anyTablet(e.tablet);
    if (!t) return false;
    return kind === "text"
      ? this.searchIndexes.holds(e as SearchIndexEntry)
      : this.vectorIndexes.holds(e as VectorIndexEntry);
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
        if (e.ready && e.index.memoryBytes >= limits.textHardLimitBytes) {
          this.scheduleFlush("text", e);
          throw indexTooLarge("text", `${e.table}.${e.name}`);
        }
      for (const e of this.vectorIndexes.forTablet(t.id))
        if (e.ready && e.index.memoryBytes >= limits.vectorHardLimitBytes) {
          this.scheduleFlush("vector", e);
          throw indexTooLarge("vector", `${e.table}.${e.name}`);
        }
    }
  }

  /** After a commit: the ready indexes of its tables whose memory part passed the soft limit are flushed. */
  private flushFull(writes: readonly { table: TableDef }[]) {
    if (!this.searchSegments || this.closed) return;
    let last: TabletId | null = null;
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
    if (!state || !this.isCurrent(kind, e)) return;
    const ts = this.committer.visibleTs;
    // Prepared at once: the memory part and the deletes as of `ts`.
    const index = e.index as SearchIndexEntry["index"] & VectorIndexEntry["index"];
    const f = index.prepareFlush();
    const before = state.get(kind, e.tablet, e.name);
    // Nothing to write: the ts moves by a fast-forward instead (`searchWorkersTick`), as Convex's.
    if (!f.segment && !f.deletes.length && before && !before.backfill) return;
    const added = f.segment ? await this.storeSegment(kind, e, f.segment) : null;
    // Read from its file from now on, when segments are read from disk.
    const mapped = added && f.segment ? await this.mapSegment(added.keys.segment, f.segment) : null;
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
          staged: e.staged,
        };
        states.set(stateKey(kind, e.tablet, e.name), s);
        return true;
      },
      () => {
        f.deletes.forEach((d, i) => {
          d.part.keys = { segment: d.part.keys!.segment, deletes: deletes[i]! };
        });
        if (mapped) f.segment = mapped;
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
   * (Convex's writer `merge_deletes`), the state names it in their place; their blobs are kept (DV-370). True when
   * it compacted.
   */
  private async compactIndex(kind: "text" | "vector", e: SearchIndexEntry | VectorIndexEntry): Promise<boolean> {
    const state = this.searchSegments;
    if (!state || !this.isCurrent(kind, e)) return false;
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
    const mapped = segment && c.segment ? await this.mapSegment(segment, c.segment) : null;
    if (mapped) c.segment = mapped;
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
    const t = this.catalog.anyTablet(e.tablet);
    if (!t) return false;
    const index = e.index as unknown as {
      load(parts: NonNullable<Awaited<ReturnType<SearchSegmentsState["fetch"]>>>): void;
      buildSegment(docs: [string, Doc2][]): Uint8Array | null;
      deleteFromAll(ids: Iterable<string>): void;
      changedDeletes(): { part: unknown; version: number; bytes: Uint8Array }[];
      commitBackfill(
        segment: Uint8Array | null,
        deletes: { part: unknown; version: number; bytes: Uint8Array }[],
        ts: bigint,
        keys?: { segment: string; deletes: string | null },
      ): unknown;
      segments: Parameters<typeof segmentRefs>[0];
    };
    const threshold = kind === "text" ? this.segmentLimits.textSoftLimitBytes : this.segmentLimits.vectorSoftLimitBytes;
    // An interrupted build resumes from its stored cursor (Convex's `Backfilling { cursor, segments }`).
    let cursor: string | null = null;
    let lastTs: bigint | null = null;
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
    // Its `_index_backfills` row, once its `_index` row is written (the first step writes it, if not before).
    const fresh = cursor === null;
    let progress: ((docs: number) => Promise<void>) | null = null;
    for (;;) {
      const ts = this.committer.visibleTs;
      // The table from the cursor, at `ts`, up to the threshold.
      const docs: [string, Doc2][] = [];
      let size = 0;
      let next = cursor;
      let end = false;
      let read = 0;
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
                .take(SEARCH_BACKFILL_PAGE_SIZE),
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
        read += k;
        if (k === page.length && page.length < SEARCH_BACKFILL_PAGE_SIZE) {
          end = true;
          break;
        }
      }
      // The earlier pages' documents the log changed since the last step, at `ts`.
      const updates: [string, Doc | null][] = [];
      if (cursor !== null && lastTs !== null) {
        const upTo = cursor;
        const changed = await changedSince(state.store!, e.tablet, t.number, lastTs, ts, decodeDoc, (id) => id <= upTo);
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
        const mapped = added && bytes ? await this.mapSegment(added.keys.segment, bytes) : null;
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
              staged: e.staged,
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
            index.commitBackfill(mapped ?? bytes, deletes, ts, added?.keys);
          },
        );
        // Not stored (the index was dropped meanwhile): what was written stays, as every search blob (DV-370).
        if (!stored) return false;
        this.searchStats.backfillSteps++;
        return true;
      });
      if (!stepped) return false;
      progress ??= await this.searchBackfillProgress(kind, e, fresh);
      await progress?.(read);
      // Convex compacts a backfilling index's segments too.
      this.scheduleCompaction(kind, e);
      if (end) return true;
      cursor = next;
      lastTs = ts;
      // A background job: let the server's own work run between steps.
      await new Promise((r) => setImmediate(r));
    }
  }

  /**
   * A search or vector index's `_index_backfills` row, as Convex's search flusher keeps it: created (or reset)
   * when a build that started from the beginning takes its first step (`initialize_search_index_backfill`: no cursor, the build's place is
   * in the `_index` row; the table's count when the summaries have it), and counting the documents each step
   * read (`update_search_index_backfill_progress`). Returns the step's recorder; null while the index has no
   * `_index` row.
   */
  private async searchBackfillProgress(
    kind: "text" | "vector",
    e: SearchIndexEntry | VectorIndexEntry,
    fresh: boolean,
  ): Promise<((docs: number) => Promise<void>) | null> {
    const indexId = this.searchSegments?.rowId(kind, e.tablet, e.name);
    if (!indexId) return null;
    let totalDocs: number | null;
    try {
      totalDocs = this.tableSummaries.count(e.tablet);
    } catch {
      totalDocs = null; // the summaries are not built yet
    }
    const { id, done } = await this.runMutation(
      async (db) => {
        const row = await db
          .query(INDEX_BACKFILLS_TABLE)
          .withIndex(INDEX_BACKFILLS_INDEX, (q) => q.eq("indexId", indexId))
          .first();
        if (row && !fresh) return { id: row._id as string, done: backfillMeta(row).numDocsIndexed };
        const fields = backfillRow({ indexId, numDocsIndexed: 0, totalDocs, cursor: null });
        if (row) await db.replace(INDEX_BACKFILLS_TABLE, row._id as string, fields);
        return { id: row ? (row._id as string) : await db.insert(INDEX_BACKFILLS_TABLE, fields), done: 0 };
      },
      true,
      "_system/search_backfill_initialization",
    );
    let total = done;
    return async (docs: number) => {
      if (docs === 0) return;
      total += docs;
      // A total the summaries did not know at the start is taken from them once they do, as Convex's.
      if (totalDocs === null)
        try {
          totalDocs = this.tableSummaries.count(e.tablet);
        } catch {}
      const patch = { numDocsIndexed: BigInt(total), ...(totalDocs === null ? {} : { totalDocs: BigInt(totalDocs) }) };
      await this.runMutation(
        (db) => db.patch(INDEX_BACKFILLS_TABLE, id, patch),
        true,
        "_system/search_backfill_progress",
      );
    };
  }

  /**
   * Once a search or vector index is built: its `_index_backfills` row written once more (created when a build
   * without segments never wrote one), as Convex's writer replaces it in the transaction that marks the index
   * backfilled. bunvex's `_index` row of the index does not change then (DV-415), so this write is what tells a
   * subscription to `_system/frontend/indexes` (the dashboard's index list, STUDY-149 "Index list") to read the
   * index's state again. Nothing while the index has no `_index` row: writing it does that.
   */
  private async noteSearchIndexBuilt(kind: "text" | "vector", e: SearchIndexEntry | VectorIndexEntry) {
    const indexId = this.indexRows?.rowId(kind, e.tablet, e.name);
    if (!indexId || this.closed || !this.isCurrent(kind, e)) return;
    let count: number | null = null;
    try {
      count = this.tableSummaries.count(e.tablet);
    } catch {} // the summaries are not built yet
    await this.runMutation(
      async (db) => {
        const row = await db
          .query(INDEX_BACKFILLS_TABLE)
          .withIndex(INDEX_BACKFILLS_INDEX, (q) => q.eq("indexId", indexId))
          .first();
        if (!row) {
          await db.insert(
            INDEX_BACKFILLS_TABLE,
            backfillRow({ indexId, numDocsIndexed: count ?? 0, totalDocs: count, cursor: null }),
          );
          return;
        }
        const m = backfillMeta(row);
        await db.replace(INDEX_BACKFILLS_TABLE, m._id, backfillRow({ ...m, totalDocs: m.totalDocs ?? count }));
      },
      true,
      "_system/search_backfill_progress",
    ).catch((err: Error) => {
      if (!this.closed) console.error(`bunvex: ${kind} index ${e.table}.${e.name}: ${err.message}`);
    });
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
      if (!e.ready) continue;
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
    // A pending push's new indexes have rows too, written in its first transaction (`startSchemaPush`).
    for (const e of this.searchIndexes.pendingAll()) wanted.set(stateKey("text", e.tablet, e.name), ["text", e]);
    for (const e of this.vectorIndexes.pendingAll()) wanted.set(stateKey("vector", e.tablet, e.name), ["vector", e]);
    void state
      .update((states) => {
        let changed = false;
        for (const [k, s] of states) {
          const w = wanted.get(k);
          if (w && sameSpec(w[1].def, s.def)) {
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
              ts: 0n,
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
        states.set(k, { kind, tablet: e.tablet, name: e.name, def: e.def, ts: 0n, segments: [], staged: e.staged });
        return true;
      })
      .catch(() => {});
  }

  private async backfillVector(e: VectorIndexEntry) {
    const t = this.catalog.anyTablet(e.tablet);
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
      ) {
        this.vectorIndexes.done(e);
        await this.noteSearchIndexBuilt("vector", e);
      }
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
              .take(SEARCH_BACKFILL_PAGE_SIZE),
          ),
        undefined,
        undefined,
        undefined,
        at,
      )) as Doc[];
      for (const d of page) this.vectorIndexes.backfill(e, d);
      if (page.length < SEARCH_BACKFILL_PAGE_SIZE) break;
      last = page[page.length - 1]!._id as string;
      await new Promise((r) => setImmediate(r));
    }
    this.vectorIndexes.done(e);
    this.markRowReady("vector", e);
    await this.noteSearchIndexBuilt("vector", e);
  }

  /**
   * Convex's vector search (`Database::vector_search`, STUDY-51): the `limit` (default 10, at most 256)
   * documents of `table` nearest `vector` in index `index`, among those matching `filter` (an OR of `q.eq`s on
   * the index's filter fields), as `{_id, _score}`, best first. Against the latest visible state; a missing
   * table has no results. In the app's namespace, or a component's.
   */
  vectorSearch(
    table: string,
    index: string,
    query: { vector: number[]; limit?: number; filter?: unknown },
    /** Told what the search was charged, as Convex's `bytes_searched`: its vectors × dimensions × 4 (STUDY-71). */
    charge?: (bytesSearched: number) => void,
    /** The namespace `table` is in: a component's `_components` id (STUDY-157 PR 5), null the app's. */
    namespace: string | null = null,
  ): { _id: string; _score: number }[] {
    const t = this.catalogIn(namespace).tables.get(table);
    if (!t) return [];
    const name = `${table}.${index}`;
    const declared = declaredTables(namespace === null ? this.schema : this.componentSchema(namespace)).get(table);
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
    const parsed = query.filter === undefined ? null : vectorFilter(query.filter);
    // A filter with no condition (`q.or()`) is no filter, as Convex's: an empty field map matches every document.
    const filter = parsed && parsed.size > 0 ? parsed : null;
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
    const t = this.catalog.anyTablet(e.tablet);
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
      ) {
        this.searchIndexes.done(e);
        await this.noteSearchIndexBuilt("text", e);
      }
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
              .take(SEARCH_BACKFILL_PAGE_SIZE),
          ),
        undefined,
        undefined,
        undefined,
        at,
      )) as Doc[];
      for (const d of page) this.searchIndexes.backfill(e, d);
      if (page.length < SEARCH_BACKFILL_PAGE_SIZE) break;
      last = page[page.length - 1]!._id as string;
      // A background job: let the server's own work run between pages.
      await new Promise((r) => setImmediate(r));
    }
    this.searchIndexes.done(e);
    this.markRowReady("text", e);
    await this.noteSearchIndexBuilt("text", e);
  }

  /**
   * Build the table summaries at one snapshot: from the last checkpoint and the document log since (STUDY-72),
   * else from every table's documents (active, hidden and being deleted), page by page. Commits meanwhile
   * are queued and applied after (STUDY-52 PR 2). Then checkpoints are written as Convex's worker does.
   */
  private async buildSummaries() {
    const at = this.committer.visibleTs;
    const defs = this.catalog.everyTable();
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
        () => this.catalog.everyTable().map((t) => t.id),
      );
      this.summaryCheckpointer.start();
    }
  }

  /** Whether the summaries came from a checkpoint (tests, STUDY-72). */
  summariesRestored = false;
  /** @internal The checkpoint worker, once the summaries are built. */
  summaryCheckpointer: SummaryCheckpointer | null = null;

  private async scanSummaries(at: bigint, defs: TableDef[]) {
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

  private readonly tableCountOf = (tablet: TabletId, snapshot: bigint) => this.tableSummaries.countAt(tablet, snapshot);

  /**
   * Convex's `evaluate_schema_prediction` (STUDY-56): what pushing `next` would do, without doing it — each
   * index added, kept, enabled, disabled or dropped, whether it needs a backfill and its table's document
   * count; each declared table's validation outcome with its count and size. Needs the table summaries. In a
   * component's namespace (`namespace`, its `_components` id; STUDY-153 PR 3d), against its tables and its active
   * schema, as Convex's `predict_component_schema`.
   */
  async evaluateSchema(next: EngineSchema, namespace: string | null = null): Promise<SchemaPrediction> {
    if (!this.tableSummaries.ready) throw new TableSummariesUnavailableError();
    const cat = ranValue(await this.execute("query", this.committer.visibleTs, (db) => readCatalog(db), true));
    const active = activeTables(cat.tables, namespace ?? undefined);
    const activeSchema = namespace === null ? this.schema : this.componentSchema(namespace);
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
      ...declaredTables(next).keys(),
      ...active.filter((t) => !t.name.startsWith("_")).map((t) => t.name),
    ]);
    for (const table of [...tableNames].sort()) {
      const declared = declaredTables(next).get(table);
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
      const before = declaredTables(activeSchema).get(table);
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
          // A component's too (STUDY-157 PR 5): indexes are keyed by tablet.
          ready: (n: string) =>
            tablet === undefined ? false : !!this.searchIndexes.get(this.catalog.anyTablet(tablet)!, n)?.ready,
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
            tablet === undefined ? false : !!this.vectorIndexes.get(this.catalog.anyTablet(tablet)!, n)?.ready,
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
    // A component has no staged validator yet (STUDY-153 PR 2b refuses them).
    const validStaged = namespace === null ? await this.activeValidStaged() : new Map<string, unknown>();
    // Convex's staged prediction (5b65aedb3): each table's staged validation, whether finishing the active schema's
    // would spare the walk, and which pending or valid staged validations the push throws away.
    const { items, activeStaged } = await this.query((db) =>
      db.asSystem(() =>
        db.inComponent(namespace, async () => {
          const rows = await db.query(SCHEMAS_TABLE).collect();
          const items: { active: boolean; c: StagedCarryOver }[] = [];
          let activeStaged = new Map<string, StagedValidator>();
          for (const state of ["active", "pending", "validated"] as const) {
            const row = rows.find((r) => schemaStateOf(r) === state);
            if (!row) continue;
            const staged = stagedValidatorsOf(JSON.parse(row.schema as string) as SchemaJson);
            if (state === "active") activeStaged = staged;
            for (const c of await stagedValidationsWithProgress(db, row._id as string, staged))
              items.push({ active: state === "active", c });
          }
          return { items, activeStaged };
        }),
      ),
    );
    const nextStaged = stagedValidatorsOf(schemaToJson(next));
    const stateOf = (c: StagedCarryOver): StagedValidatorState =>
      c.state.state === "pending"
        ? {
            state: "pending",
            numDocsValidated: Number(c.numDocsValidated),
            totalDocs: c.totalDocs === null ? null : Number(c.totalDocs),
          }
        : c.state.state === "valid"
          ? { state: "valid" }
          : { state: "failed", error: c.state.error };
    /** Convex's `most_advanced`: per key, a valid validation first, then the most documents checked. */
    const mostAdvanced = (key: (c: StagedCarryOver) => string | null) => {
      const out = new Map<string, StagedCarryOver>();
      const rank = (c: StagedCarryOver) => [c.state.state === "valid" ? 1 : 0, c.numDocsValidated] as const;
      for (const { c } of items) {
        const k = key(c);
        if (k === null) continue;
        const was = out.get(k);
        const [a, b] = rank(c);
        if (!was || a > rank(was)[0] || (a === rank(was)[0] && b > rank(was)[1])) out.set(k, c);
      }
      return out;
    };
    const stagedStates = mostAdvanced((c) => c.tableName);
    const stillValidating = new Map(
      items.filter((i) => i.active && i.c.state.state === "pending").map((i) => [i.c.tableName, i.c.validator]),
    );
    const tables: TablePrediction[] = [...declaredTables(next).values()].map((t) => {
      const tablet = tabletOf(t.name);
      const s = tablet === undefined ? { count: 0, size: 0 } : this.tableSummaries.get(tablet);
      const outcome = this.tableOutcome(next, activeSchema, t.name, tablet, validStaged, namespace);
      const staged = stagedStates.get(t.name);
      const pendingStaged = stillValidating.get(t.name);
      return {
        name: t.name,
        outcome,
        numDocs: s.count,
        sizeBytes: s.size,
        ...(staged ? { staged: stateOf(staged) } : {}),
        canSkipAfterStagedValidation:
          next.schemaValidation &&
          pendingStaged !== undefined &&
          isSubset(subsetDocument(pendingStaged), subsetDocument(t.document.json as never)),
      };
    });
    // Kept: what the push carries over (`can_reuse_for`), and the active schema's staged validators it promotes.
    const key = (table: string, hash: string) => `${table}\u0000${hash}`;
    const retained = new Set<string>();
    for (const { c } of items) {
      const v = nextStaged.get(c.tableName);
      if (v && canReuseFor(c, v)) retained.add(key(c.tableName, c.hash));
    }
    for (const t of tables) {
      const v = activeStaged.get(t.name);
      if (t.outcome === "supersetOfStagedValidated" && v) retained.add(key(t.name, v.hash));
    }
    const discardedStagedValidators: DiscardedStagedValidator[] = [];
    const byValidator = mostAdvanced((c) => (c.state.state === "failed" ? null : key(c.tableName, c.hash)));
    for (const k of [...byValidator.keys()].sort()) {
      if (retained.has(k)) continue;
      const c = byValidator.get(k)!;
      discardedStagedValidators.push({
        tableName: c.tableName,
        state: stateOf(c),
        replaced: nextStaged.has(c.tableName),
      });
    }
    return { schemaValidation: next.schemaValidation, tables, indexes, discardedStagedValidators };
  }

  /** Wait until the table summaries are built (tests, and callers that need them at once). */
  async summariesReady() {
    await this.summariesBuild;
  }

  /** Wait until the staged walk is done (tests). */
  async stagedWalkIdle() {
    while (this.stagedWalk) await this.stagedWalk;
  }

  /** Wait until every search index is built (tests). */
  async searchReady() {
    while (this.searchBackfills.size) await Promise.all([...this.searchBackfills]);
  }

  /**
   * Wait until the search and vector indexes' `_index` rows (and their states) are written for what the engine
   * has reconciled so far (tests): the sync scheduled in a microtask, then the writes queued before it.
   */
  async searchIndexRowsWritten() {
    while (this.rowsSyncScheduled) await Promise.resolve();
    await this.indexRows?.idle();
  }

  /** Mark a pending (or validated) schema `failed` (Convex's `mark_failed`), in its namespace (null: the root's). */
  private async failSchemaPush(
    schemaId: string,
    error: string,
    tableName: string | null,
    namespace: string | null = null,
  ) {
    await this.runMutation(
      (db) => markSchemaFailed(db, schemaId, error, tableName, namespace),
      true,
      "_system/schema_worker",
    );
  }

  /** Check the stored documents against a pending schema in the background (`validateExisting`). */
  private startValidation(
    schemaId: string,
    schema: EngineSchema,
    active: EngineSchema,
    namespace: string | null = null,
  ) {
    const walk = this.validateExisting(schemaId, schema, active, namespace).catch((e) =>
      this.failSchemaPush(
        schemaId,
        `Schema validation failed: ${e instanceof Error ? e.message : e}`,
        null,
        namespace,
      ).catch(() => {}),
    );
    // The staged walk waits for the root's (`kickStagedWalk`); a component's runs on its own.
    if (namespace === null) this.validation = walk;
    this.validationWalks.add(walk);
    void walk.finally(() => this.validationWalks.delete(walk));
  }

  /** The validation walks running (`startValidation`), which a close waits for. */
  private readonly validationWalks = new Set<Promise<unknown>>();

  /**
   * At a start, as Convex's `SchemaWorker` since 900fe2c (STUDY-127, STUDY-106 §7.1): the validations are kept (a
   * `valid` staged one stays true, every write since being checked); a schema still `pending` is walked again from
   * the beginning, each table's attempt replacing its old one, and writes are checked against a `pending` or
   * `validated` schema and the staged validators meanwhile, as before the restart.
   */
  private async resumePendingSchema() {
    const row = await this.runMutation(
      async (db) => {
        const rows = await db.query(SCHEMAS_TABLE).collect();
        return (
          rows.find((r) => {
            const s = schemaStateOf(r);
            return s === "pending" || s === "validated";
          }) ?? null
        );
      },
      true,
      "_system/init_app_system_tables",
    );
    if (!row) return;
    const schema = schemaFromJson(JSON.parse(row.schema as string) as SchemaJson);
    this.pendingPush = { id: row._id as string, schema };
    this.pendingValidators = validatorsOf(schema);
    this.refreshStagedChecks();
    if (schemaStateOf(row) === "pending") this.startValidation(row._id as string, schema, this.schema);
  }

  /** A table's document count for a validation's progress, or null while the table summaries are built. */
  private totalDocs(table: string, namespace: string | null = null): number | null {
    if (!this.tableSummaries.ready) return null;
    const t = this.catalogIn(namespace).tables.get(table);
    return t ? this.tableSummaries.count(t.id) : 0;
  }

  /**
   * A table's validation outcome for a push (STUDY-106 §7.4, Convex's `validation_outcome_for_validator`): the new
   * validator against the active schema's enforced one (`any` when it does not validate), then against the table's
   * shape from its summary (none while summaries build; a table that does not exist is empty).
   */
  private tableOutcome(
    next: EngineSchema,
    active: EngineSchema,
    table: string,
    tablet: TabletId | undefined,
    validStaged?: Map<string, unknown>,
    namespace: string | null = null,
  ) {
    const t = declaredTables(next).get(table);
    const was = active.schemaValidation ? declaredTables(active).get(table) : undefined;
    const shape = !this.tableSummaries.ready
      ? undefined
      : tablet === undefined
        ? NEVER
        : this.tableSummaries.get(tablet).shape;
    return tableValidationOutcome(
      next.schemaValidation,
      t?.document.json as never,
      was?.document.json as never,
      shape,
      (n) => this.catalogIn(namespace).byNumber(n)?.name,
      validStaged?.get(table) as never,
    );
  }

  /**
   * Convex's `active_schema_with_valid_staged_validators`: the active schema's staged validators its validation
   * proved, by table (a `supersetOfStagedValidated` proof, 7236c10).
   */
  private async activeValidStaged(): Promise<Map<string, unknown>> {
    return this.query((db) =>
      db.asSystem(async () => {
        const row = (await db.query(SCHEMAS_TABLE).collect()).find((r) => schemaStateOf(r) === "active");
        if (!row) return new Map();
        const staged = stagedValidatorsOf(JSON.parse(row.schema as string) as SchemaJson);
        return validStagedValidators(db, row._id as string, staged);
      }),
    ) as Promise<Map<string, unknown>>;
  }

  /**
   * Convex's `invalidate_table_references` (7236c10), when an active table is deleted or replaced: every staged
   * validation, of the active, validated and pending schema, whose validator points to it with `v.id` fails.
   */
  private async invalidateTableReferences(db: Tx, name: string) {
    for (const row of await db.query(SCHEMAS_TABLE).collect()) {
      const state = schemaStateOf(row);
      if (state !== "active" && state !== "validated" && state !== "pending") continue;
      const staged = stagedValidatorsOf(JSON.parse(row.schema as string) as SchemaJson);
      for (const [table, v] of staged)
        if (referencedTables(v.json as unknown as ValidatorJSON).has(name))
          await markStagedValidationFailed(
            db,
            row._id as string,
            table,
            `Table ${name} is referenced by the staged validator for ${table} but was deleted or replaced; redeploy to revalidate ${table}.`,
          );
    }
  }

  /** Run the staged walk (again, if it is running: a push may have added rows). */
  private kickStagedWalk() {
    if (this.opts.stagedWalk === false) return;
    if (this.stagedWalk) {
      this.stagedWalkAgain = true;
      return;
    }
    this.stagedWalk = (async () => {
      do {
        this.stagedWalkAgain = false;
        // After the pending schema's walk: a blocked push always goes first (Convex's `SchemaWorker::run`).
        await this.validation?.catch(() => {});
        if (this.closed) return;
        await this.walkStagedValidators();
      } while (this.stagedWalkAgain && !this.closed);
    })()
      .catch((err) => {
        if (!this.closed)
          console.error(`bunvex: staged validation failed: ${err instanceof Error ? err.message : err}`);
      })
      .finally(() => {
        this.stagedWalk = null;
      });
  }

  /**
   * Convex's staged walk (e049178, STUDY-106 §7.3): the active, then the validated, then the pending schema's
   * staged rows still pending, table by table in name order. A table that does not exist, or whose staged validator
   * accepts everything the schema enforces or the table's shape holds, is valid without a walk; any other is walked
   * (its counters reset, flushed every 5 % or 500 documents) and becomes valid, or failed at the first document that
   * does not match (`Document with ID "…" in table "…" does not match the schema: …`). A row that stops being pending
   * (a write failed it, a push replaced it) stops its walk. Tables fail on their own; the schema is never touched.
   */
  private async walkStagedValidators() {
    const schemas = await this.query((db) =>
      db.asSystem(async () => {
        const rows = await db.query(SCHEMAS_TABLE).collect();
        const out: { id: string; schema: EngineSchema; json: SchemaJson }[] = [];
        for (const state of ["active", "validated", "pending"] as const) {
          const row = rows.find((r) => schemaStateOf(r) === state);
          if (!row) continue;
          const json = JSON.parse(row.schema as string) as SchemaJson;
          out.push({ id: row._id as string, schema: schemaFromJson(json), json });
        }
        return out;
      }),
    );
    for (const { id: schemaId, schema, json } of schemas) {
      const staged = stagedValidatorsOf(json);
      if (staged.size === 0) continue;
      const todo = await this.query((db) => db.asSystem(() => pendingStagedValidations(db, schemaId, staged)));
      for (const { id, tableName } of todo) {
        if (this.closed) return;
        const t = declaredTables(schema).get(tableName);
        const v = staged.get(tableName);
        if (!t?.stagedDocument || !v) continue;
        const valid = () =>
          this.runMutation((db) => markValidationValid(db, id), true, "_system/schema_worker_staged_valid");
        const tablet = this.catalog.tables.get(tableName)?.id;
        // Never written: nothing to check.
        if (tablet === undefined) {
          await valid();
          continue;
        }
        const enforced = schema.schemaValidation ? t.document.json : undefined;
        const shape = this.tableSummaries.ready ? this.tableSummaries.get(tablet).shape : undefined;
        const outcome = tableValidationOutcome(
          true,
          v.json,
          enforced as never,
          shape,
          (n) => this.catalog.byNumber(n)?.name,
        );
        if (outcome !== "mustWalk") {
          await valid();
          continue;
        }
        const validator = documentValidator(tableName, t.stagedDocument);
        if (!validator) {
          await valid();
          continue;
        }
        await this.walkStagedTable(id, tableName, validator);
      }
    }
  }

  /** One staged table's walk (Convex's `walk_table`): reset, documents by id, progress, then valid or failed. */
  private async walkStagedTable(id: string, tableName: string, validator: GenericValidator) {
    const started = await this.runMutation(
      (db) => startStagedWalk(db, id, this.totalDocs(tableName)),
      true,
      "_system/schema_worker_staged_start",
    );
    if (!started) return;
    const threshold = progressThreshold(this.totalDocs(tableName));
    let unflushed = 0;
    const flush = async () => {
      const count = unflushed;
      unflushed = 0;
      return this.runMutation(
        (db) => recordValidationProgress(db, id, count, this.totalDocs(tableName)),
        true,
        "_system/schema_validation_progress_updated",
      );
    };
    let cursor: string | null = null;
    for (;;) {
      if (this.closed || !this.catalog.tables.has(tableName)) return;
      const page = await this.query(async (db) => db.query(tableName).paginate({ numItems: 256, cursor }));
      for (const doc of page.page) {
        const msg = checkDocument(validator, doc, (n) => this.catalog.publicNameOf(n));
        if (msg) {
          await this.runMutation(
            (db) =>
              markWalkFailed(
                db,
                id,
                `Document with ID "${doc._id as string}" in table "${tableName}" does not match the schema: ${msg}`,
              ),
            true,
            "_system/schema_worker_staged_failed",
          );
          return;
        }
        if (++unflushed % threshold === 0 && !(await flush())) return;
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    if (unflushed > 0 && !(await flush())) return;
    await this.runMutation((db) => markValidationValid(db, id), true, "_system/schema_validation_progress_finished");
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
  private async validateExisting(
    schemaId: string,
    schema: EngineSchema,
    active: EngineSchema,
    namespace: string | null = null,
  ) {
    // A close stops the walk (the schema stays pending; a restart walks it again from the beginning).
    const stillPending = () => !this.closed && this.pendingIdIn(namespace) === schemaId;
    const names = () => this.catalogIn(namespace);
    const walk: { name: string; validator: GenericValidator }[] = [];
    // A component's schema has no staged validator (refused at its push, `startSchemaPush`).
    const validStaged = schema.schemaValidation && namespace === null ? await this.activeValidStaged() : undefined;
    if (schema.schemaValidation)
      for (const t of declaredTables(schema).values()) {
        const validator = documentValidator(t.name, t.document);
        if (!validator) continue;
        // Convex's `table_validation_outcomes`: a table whose new validator accepts everything the active one
        // enforced, or everything its shape holds (an empty table always), is not walked and gets no attempt.
        // A staged validator the active schema proved stands in for the walk too (`supersetOfStagedValidated`).
        const tablet = names().tables.get(t.name)?.id;
        if (this.tableOutcome(schema, active, t.name, tablet, validStaged, namespace) !== "mustWalk") continue;
        // A table with no document (or none yet) has nothing to check: Convex's empty shape fits any validator,
        // so it writes no attempt for it (`table_shape_provider`, STUDY-133 §12 M13). Unknown counts are walked.
        if (this.totalDocs(t.name, namespace) === 0) continue;
        walk.push({ name: t.name, validator });
      }
    if (!stillPending()) return;
    // Convex's `SchemaValidationProgressTracker::new`: every attempt first, in one commit.
    const attempts = await this.runMutation(
      (db) =>
        db.inComponent(namespace, async () => {
          const ids: string[] = [];
          for (const t of walk)
            ids.push(await startTableValidation(db, schemaId, t.name, this.totalDocs(t.name, namespace)));
          return ids;
        }),
      true,
      "_system/schema_validation_tracker_initialized",
    );
    for (const [k, t] of walk.entries()) {
      const attempt = attempts[k]!;
      const threshold = progressThreshold(this.totalDocs(t.name, namespace));
      let unflushed = 0;
      // One flush at a time runs while the walk goes on; the next one waits for it, and stops the walk when it
      // found the attempt gone (the walk was canceled).
      let inFlight: Promise<boolean> = Promise.resolve(true);
      /** Write the counted documents; false once the attempt is gone. */
      const flush = async () => {
        // A flush left waiting on the one before it starts nothing once the engine closed.
        if (!(await inFlight) || this.closed) return false;
        const count = unflushed;
        unflushed = 0;
        inFlight = this.runMutation(
          (db) =>
            db.inComponent(namespace, () =>
              recordValidationProgress(db, attempt, count, this.totalDocs(t.name, namespace)),
            ),
          true,
          "_system/schema_validation_progress_updated",
        );
        return true;
      };
      let cursor: string | null = null;
      for (;;) {
        if (!stillPending()) return;
        const page = await this.query(async (db) =>
          db.inComponent(namespace, async () => db.query(t.name).paginate({ numItems: 256, cursor })),
        );
        for (const doc of page.page) {
          const msg = checkDocument(t.validator, doc, (n) => names().publicNameOf(n));
          if (msg) {
            await this.failSchemaPush(
              schemaId,
              `Document with ID "${doc._id as string}" in table "${t.name}" does not match the schema: ${msg}`,
              t.name,
              namespace,
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
        (db) => db.inComponent(namespace, () => markValidationValid(db, attempt)),
        true,
        "_system/schema_validation_progress_finished",
      );
      if (!marked) return;
    }
    if (!stillPending()) return;
    await this.runMutation(
      (db) =>
        db.inComponent(namespace, async () => {
          const row = (await db.get(SCHEMAS_TABLE, schemaId)) as Record<string, unknown> | null;
          if (schemaStateOf(row) === "pending")
            await db.patch(SCHEMAS_TABLE, schemaId, { state: { state: "validated" } });
        }),
      true,
      "_system/schema_worker",
    );
  }

  /**
   * Convex's guardrail in `submit_pending` (STUDY-106 §7.4): a table's enforced walk and its staged validation share
   * one row, so a schema that stages a validator on a table whose enforced change needs a walk is refused, its
   * tables in name order. As Convex's, no shape is used and a table that does not exist is empty, but a new table
   * that declares an index exists already: Convex adds the push's indexes first, creating their tables (a dry run
   * and `evaluate_push` too, in their read-only pass; checked against Convex's binary).
   */
  async stagedValidatorConflicts(schema: EngineSchema): Promise<StagedSchemaError | null> {
    const tables: string[] = [];
    // Only read when there is a staged validator (Convex's `has_staged_validators` guard).
    const hasStaged = [...declaredTables(schema).values()].some((t) => t.stagedDocument !== undefined);
    const validStaged = hasStaged ? await this.activeValidStaged() : new Map<string, unknown>();
    for (const t of [...declaredTables(schema).values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      if (t.stagedDocument === undefined) continue;
      const declaresIndex =
        Object.keys(t.indexes).length > 0 ||
        Object.keys(t.searchIndexes ?? {}).length > 0 ||
        Object.keys(t.vectorIndexes ?? {}).length > 0;
      const exists = this.catalog.tables.has(t.name) || declaresIndex;
      const was = this.schema.schemaValidation ? declaredTables(this.schema).get(t.name) : undefined;
      const outcome = tableValidationOutcome(
        schema.schemaValidation,
        t.document.json as never,
        was?.document.json as never,
        exists ? undefined : NEVER,
        (n) => this.catalog.byNumber(n)?.name,
        validStaged.get(t.name) as never,
      );
      if (outcome === "mustWalk") tables.push(t.name);
    }
    return tables.length ? new StagedSchemaError(tables) : null;
  }

  /**
   * A push's schema change, first half (Convex's `start_push` → `handle_schema_change_in_start_push`):
   * create missing tables, add new and changed indexes as `backfilling` (the worker builds them), drop
   * pending ones no longer declared, and record the schema as `pending` — an earlier pending one becomes
   * `overwritten` (its push then sees `raceDetected`). Enabled indexes keep serving the running code until
   * `commitSchemaPush`. Returns the schema's id and the indexes it added.
   *
   * `components` are the pushed components' schemas, by `_components` id (their namespaces made by
   * `initializeComponentNamespace`): each is submitted in its namespace in the same commit (Convex's
   * `start_component_schema_changes`), its existing documents walked as the root's. A component without a schema
   * (null) gets none. Each one's schema id and added indexes are in the result's `components`.
   *
   * A push without a schema (`schema` null) writes nothing for the root, as Convex's `start_component_schema_changes`
   * without one: no table, no index, no `_schemas` row (a pending schema stays pending), and its id is null; its
   * finish drops the indexes and clears the active schema (`commitSchemaPush`).
   */
  async startSchemaPush(
    schema: EngineSchema,
    components?: ReadonlyMap<string, EngineSchema | null>,
  ): Promise<StartedSchemaPush<string>>;
  async startSchemaPush(
    schema: EngineSchema | null,
    components?: ReadonlyMap<string, EngineSchema | null>,
  ): Promise<StartedSchemaPush<string | null>>;
  async startSchemaPush(
    schema: EngineSchema | null,
    components: ReadonlyMap<string, EngineSchema | null> = new Map(),
  ): Promise<StartedSchemaPush<string | null>> {
    const conflict = schema && (await this.stagedValidatorConflicts(schema));
    if (conflict) throw conflict;
    for (const [id, s] of components) {
      if (s) checkComponentSchema(s);
      if (!this.catalog.components.has(id)) throw new Error(`No namespace for component ${id}`);
    }
    const declared = schema && this.allDeclaredTables(schema);
    const json = schema && schemaToJson(schema);
    const staged = json ? stagedValidatorsOf(json) : new Map();
    // The pushed schema is checked from the commit that submits it on, by every transaction that sees it, as
    // Convex's writes read it from their snapshot's schema registry (STUDY-187 X10): installed as that commit is
    // visible, or after it when it wrote nothing. `walk`: it became pending, so its documents are walked.
    let installed = false;
    let walk = false;
    const install = (schemaId: string | null, state: SubmittedState | null) => {
      if (installed || schemaId === null || schema === null) return;
      installed = true;
      if (state === "active") {
        // Nothing to validate: the push commits the active schema again (Convex's `mark_active` no-op).
        this.pendingPush = { id: schemaId, schema };
        this.pendingValidators = null;
      } else if (this.pendingPush?.id !== schemaId) {
        this.pendingPush = { id: schemaId, schema };
        this.pendingValidators = validatorsOf(schema);
        walk = true;
      }
    };
    const r = await this.runMutation(
      async (db) => {
        let schemaId: string | null = null;
        let state: SubmittedState | null = null;
        let addedIndexes: string[] = [];
        const created: TabletId[] = [];
        if (schema && declared && json) {
          const current = await readCatalog(db);
          const changes = planCatalog(declared, current.tables, current.indexes, true, current.nextIndexId);
          const written = await writeCatalogChanges(db, changes, this.createdLowerBound(db));
          ({ schemaId, state } = await submitPending(db, schema, json, staged));
          addedIndexes = changes.insertIndexes
            .filter((i) => !(i.name in SYSTEM_INDEXES))
            .map((i) => `${i.table}.${i.name}`);
          created.push(...[...written.tables.values()].map((t) => t.tablet));
        }
        const inComponents = new Map<
          string,
          { schemaId: string | null; state: SubmittedState | null; addedIndexes: string[] }
        >();
        for (const [id, s] of components) {
          if (!s) {
            inComponents.set(id, { schemaId: null, state: null, addedIndexes: [] });
            continue;
          }
          const current = await readCatalog(db);
          // Numbered as the root's tables (#667): the indexed ones first, each group by name.
          const declared = pushOrder(declaredTables(s).values());
          const plan = planCatalog(declared, current.tables, current.indexes, true, current.nextIndexId, id);
          const made = await writeCatalogChanges(db, plan, this.createdLowerBound(db));
          created.push(...[...made.tables.values()].map((t) => t.tablet));
          const json = schemaToJson(s);
          const submitted = await db.inComponent(id, () => submitPending(db, s, json, stagedValidatorsOf(json)));
          inComponents.set(id, {
            ...submitted,
            addedIndexes: plan.insertIndexes
              .filter((i) => !(i.name in SYSTEM_INDEXES))
              .map((i) => `${i.table}.${i.name}`),
          });
        }
        const after = await readCatalog(db);
        // The search and vector indexes the push adds: their `_index` rows, backfilling, in this transaction (Convex's
        // `prepare_new_and_mutated_indexes`), taken over by the rows' writer once it is visible (STUDY-195 §2).
        const rows: [IndexSegmentsState, string][] = [];
        const addRows = async (pushed: EngineSchema, active: EngineSchema, namespace?: string) => {
          if (!this.indexRows) return;
          const now = declaredTables(active);
          for (const [name, declared] of declaredTables(pushed)) {
            const t = activeTables(after.tables, namespace).find((x) => x.name === name);
            if (!t) continue;
            const kinds = [
              ["text", declared.searchIndexes ?? {}, now.get(name)?.searchIndexes ?? {}, declared.stagedSearch],
              ["vector", declared.vectorIndexes ?? {}, now.get(name)?.vectorIndexes ?? {}, declared.stagedVector],
            ] as const;
            for (const [kind, defs, before, staged] of kinds)
              for (const [index, def] of Object.entries(defs)) {
                if ((before as Record<string, unknown>)[index] || this.indexRows.rowId(kind, t.tablet, index)) continue;
                const s: IndexSegmentsState = {
                  kind,
                  tablet: t.tablet,
                  name: index,
                  def: def as SearchIndexDef | VectorIndexDef,
                  ts: 0n,
                  segments: [],
                  backfill: { cursor: null },
                  staged: (staged ?? []).includes(index),
                };
                rows.push([s, (await db.insert(INDEX_TABLE, searchIndexRow(s) as never)) as string]);
              }
          }
        };
        if (schema && state !== "active") await addRows(schema, this.schema);
        for (const [id, s] of components)
          if (s && inComponents.get(id)?.state !== "active") await addRows(s, this.componentSchema(id), id);
        // Installed as soon as the commit is visible (see `catalogTouches`).
        db.onCommitVisible = () => {
          this.catalog = buildCatalog(after.tables, after.indexes);
          for (const [s, id] of rows) this.indexRows?.adopt(s, id);
          install(schemaId, state);
        };
        return { schemaId, state, addedIndexes, created, after, inComponents };
      },
      true,
      "_system/start_push",
    );
    this.catalog = buildCatalog(r.after.tables, r.after.indexes);
    install(r.schemaId, r.state);
    if (await this.backfillNewTables(r.created, r.after.indexes)) r.after = await this.runMutation(readCatalog, true);
    if (walk && r.schemaId !== null && schema) this.startValidation(r.schemaId, schema, this.schema);
    for (const [id, c] of r.inComponents) {
      if (c.schemaId === null) continue;
      const schemas = this.schemasOf(id);
      const pushed = components.get(id)!;
      if (c.state === "active") schemas.pendingPush = { id: c.schemaId, schema: pushed };
      else if (schemas.pendingPush?.id !== c.schemaId) {
        schemas.pendingPush = { id: c.schemaId, schema: pushed };
        this.startValidation(c.schemaId, pushed, schemas.schema, id);
      }
    }
    this.refreshStagedChecks();
    if (staged.size) this.kickStagedWalk();
    if (r.after.indexes.some((i) => i.state === "backfilling")) this.startIndexWorker();
    // Its new search and vector indexes are built while it waits (STUDY-195 §2).
    this.reconcilePendingSearch();
    return {
      schemaId: r.schemaId,
      addedIndexes: r.addedIndexes,
      components: new Map(
        [...r.inComponents].map(([id, c]) => [id, { schemaId: c.schemaId, addedIndexes: c.addedIndexes }]),
      ),
    };
  }

  /**
   * Where a push's schema change stands (Convex's `wait_for_schema` states): `raceDetected` once another
   * push replaced it; `inProgress` while an index it enables is backfilling; else `complete`. A component's
   * schema is looked up in its namespace (`namespace`, its `_components` id).
   */
  async schemaPushStatus(
    schemaId: string,
    namespace: string | null = null,
  ): Promise<
    | { type: "raceDetected" }
    | { type: "failed"; error: string; tableName: string | null }
    | { type: "inProgress"; indexesComplete: number; indexesTotal: number; schemaValidationComplete: boolean }
    | { type: "complete"; indexesTotal: number }
  > {
    return this.query((db) =>
      db.asSystem(async () => {
        const row = (await db.inComponent(namespace, () => db.get(SCHEMAS_TABLE, schemaId))) as Record<
          string,
          unknown
        > | null;
        const state = schemaStateOf(row);
        if (!row || state === "overwritten") return { type: "raceDetected" as const };
        const failed = schemaFailureOf(row);
        if (failed) return { type: "failed" as const, ...failed };
        const validated = state === "validated" || state === "active";
        const indexes = databaseIndexRows(await db.query(INDEX_TABLE).collect());
        const tables = (await db.query(TABLES_TABLE).collect()).map(tableMeta);
        // As Convex's `load_component_schema_status`: every application index there is now (an index the push
        // changes is there twice, the enabled one and the new one backfilling), staged ones skipped; complete
        // once not backfilling.
        const userTablets = new Set(
          activeTables(tables, namespace ?? undefined)
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
        // The search and vector indexes the push adds, once they are built (Convex's `wait_for_schema` counts every
        // index of the push, STUDY-195 §2). Only the push the engine holds as pending builds them.
        const holding = namespace === null ? this.pendingPush : this.componentSchemas.get(namespace)?.pendingPush;
        if (holding?.id === schemaId)
          for (const e of [...this.searchIndexes.pendingAll(), ...this.vectorIndexes.pendingAll()]) {
            if (!userTablets.has(e.tablet) || e.staged) continue;
            total++;
            if (e.ready) done++;
          }
        if (done < total || !validated)
          return {
            type: "inProgress" as const,
            indexesComplete: done,
            indexesTotal: total,
            schemaValidationComplete: validated,
          };
        // Its indexes counted too: a push of several namespaces reports each one's (Convex's `ComponentSchemaStatus`).
        return { type: "complete" as const, indexesTotal: total };
      }),
    ) as never;
  }

  /**
   * A push's schema change, second half, in ONE commit with `body` (Convex's `finish_push`): enable what is
   * backfilled, disable what became staged, drop what was replaced or removed, make the schema `active`,
   * and whatever `body` writes (the code, the crons). The engine switches to the schema — its validators,
   * its catalog — when the commit is visible. Throws if the schema was overwritten or is not complete.
   *
   * `schemaId` null is a push without a schema (Convex's `SchemaModel::apply(None)`): every user index of the root
   * is dropped and its active schema marked `overwritten`, none in its place; the engine then has no schema. So are
   * the components in `withoutSchema`, by `_components` id. A pending schema of an earlier push is left as it is.
   */
  async commitSchemaPush<T>(
    schemaId: string | null,
    body: (db: Tx) => Promise<T>,
    /** The components' schemas `startSchemaPush` submitted, by `_components` id: each finished in this commit too. */
    components: ReadonlyMap<string, string> = new Map(),
    /** The pushed components without a schema, by `_components` id: finished in this commit as the root's would be. */
    withoutSchema: ReadonlySet<string> = new Set(),
  ): Promise<{ value: T; indexDiff: IndexDiff; components: Map<string, IndexDiff> }> {
    const pushed = this.pendingPush;
    if (schemaId !== null && (!pushed || pushed.id !== schemaId))
      throw new SchemaPushError("RaceDetected", "Schema was overwritten by another push.");
    const pending = schemaId === null ? { id: null, schema: EMPTY_SCHEMA } : pushed!;
    const finishing = new Map<string, { id: string | null; schema: EngineSchema }>();
    for (const [id, componentSchemaId] of components) {
      const p = this.componentSchemas.get(id)?.pendingPush;
      if (!p || p.id !== componentSchemaId)
        throw new SchemaPushError("RaceDetected", "Schema was overwritten by another push.");
      finishing.set(id, p);
    }
    for (const id of withoutSchema) finishing.set(id, { id: null, schema: EMPTY_SCHEMA });
    const declared = this.allDeclaredTables(pending.schema);
    const r = await this.runMutation(
      async (db) => {
        const { f, tables } = await finishSchemaIn(db, schemaId, declared);
        const inComponents = new Map<string, FinishChanges & { name: (i: IndexMeta) => string }>();
        for (const [id, c] of finishing) {
          const done = await db.inComponent(id, () => finishSchemaIn(db, c.id, declaredTables(c.schema).values(), id));
          inComponents.set(id, {
            ...done.f,
            name: (i) => `${done.tables.find((t) => t.tablet === i.tablet)?.name}.${i.name}`,
          });
        }
        const value = await body(db);
        const ids = (l: IndexMeta[]) => l.map((i) => i.indexId);
        const name = (i: IndexMeta) => `${tables.find((t) => t.tablet === i.tablet)?.name}.${i.name}`;
        const all = [f, ...inComponents.values()];
        db.onCommitVisible = (ts) => {
          this.installIndexChanges(
            {
              enable: all.flatMap((c) => ids(c.enable)),
              disable: all.flatMap((c) => ids(c.disable)),
              drop: all.flatMap((c) => ids(c.drop)),
            },
            ts,
          );
          for (const [id, c] of finishing) {
            const schemas = this.schemasOf(id);
            schemas.schema = c.schema;
            schemas.validators = validatorsOf(c.schema);
            schemas.activeSchemaId = c.id;
            if (c.id !== null && schemas.pendingPush?.id === c.id) schemas.pendingPush = null;
          }
          this.schema = pending.schema;
          this.activeSchemaId = schemaId;
          this.installValidators(pending.schema);
          this.reconcileSearch();
          this.reconcileVector();
          if (schemaId !== null && this.pendingPush?.id === schemaId) {
            this.pendingPush = null;
            this.pendingValidators = null;
          }
          // What a pending push built is enabled above (`reconcileSearch` takes it over); nothing is left pending.
          this.reconcilePendingSearch();
          this.refreshStagedChecks();
        };
        return {
          value,
          indexDiff: { enabled: f.enable.map(name), disabled: f.disable.map(name), dropped: f.drop.map(name) },
          components: new Map(
            [...inComponents].map(([id, c]) => [
              id,
              { enabled: c.enable.map(c.name), disabled: c.disable.map(c.name), dropped: c.drop.map(c.name) },
            ]),
          ),
        };
      },
      true,
      "_system/finish_push",
      false,
      ANONYMOUS,
      {},
      FINISH_PUSH_MAX_OCC_FAILURES,
    );
    return r;
  }

  // ---------------------------------------------------------------- hidden and deleted tables (STUDY-42)

  /**
   * Create a hidden table (an import's, as Convex's `create_empty_table`): invisible to functions, with
   * `number` (else the first free one) and a copy of each ENABLED index of the active table `copyIndexesOf`
   * (Convex's `copy_indexes_to_table`, which refuses a table still backfilling an index). As Convex's, the
   * copies start `Backfilling`; the table is backfilled (it is empty: next to nothing to copy) and its indexes
   * enabled before it is returned (`backfill_and_enable_indexes_on_table`), so the import writes into a table
   * whose indexes are enabled. `number` may be the active table's of the same name, or of a table in
   * `replacing` (one the activation deletes). Its definition, once committed.
   */
  async createHiddenTable(
    name: string,
    opts: { number?: number; copyIndexesOf?: string; replacing?: string[] } = {},
  ): Promise<TableDef> {
    const source = opts.copyIndexesOf ? this.catalog.tables.get(opts.copyIndexesOf) : undefined;
    const indexes: Record<string, string[]> = {};
    // The ENABLED indexes only, as Convex's `copy_indexes_to_table` (staged and backfilled ones are not copied).
    for (const ix of source?.indexes.values() ?? []) if (!(ix.name in SYSTEM_INDEXES)) indexes[ix.name] = ix.fields; // as they are: the placeholder adds nothing
    const created = await this.runMutation(
      async (db) => {
        const { tables, indexes: stored, nextIndexId } = await readCatalog(db);
        if (source && stored.some((i) => i.tablet === source.id && i.state === "backfilling"))
          throw new ImportBackfillingError(opts.copyIndexesOf!);
        // A placeholder name: planCatalog then plans a new table (a fresh number) and its indexes.
        // A system table's import (`_storage`) is not a user table (Convex checks the cap for user names only).
        const plan = planCatalog(
          [{ name: HIDDEN_TABLE_PLACEHOLDER, indexes, document: v.any() }],
          tables,
          stored,
          !name.startsWith("_"),
          nextIndexId,
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
        for (const i of plan.insertIndexes) i.table = name;
        const written = await writeCatalogChanges(db, plan, this.createdLowerBound(db));
        const row = written.tables.get(name)!;
        const catalogIndexes = (state: "backfilling" | "enabled") =>
          written.indexes.map((i) => ({
            name: i.name,
            fields: i.fields,
            id: i.indexId,
            state: i.state === "enabled" ? ("enabled" as const) : state,
          }));
        db.onCommitVisible = () => {
          const c = this.catalog.withTableStates({});
          c.add(name, row.tablet, row.number, catalogIndexes("backfilling"), "hidden", row._id);
          this.catalog = c;
        };
        return { meta: row, metaId: row._id, catalogIndexes };
      },
      true,
      "_system/create_hidden_table",
    );
    const { meta, metaId, catalogIndexes } = created;
    // Convex's `backfill_and_enable_indexes_on_table`: the copies are backfilled (`Backfilled2`; a system
    // table's are enabled by the backfill itself), then enabled in one commit.
    const backfilling = (await this.runMutation(readCatalog, true)).indexes.filter(
      (i) => i.tablet === meta.tablet && i.state === "backfilling",
    );
    if (backfilling.length) {
      // Convex's `backfill_and_enable_indexes_on_table` waits for a backfill that, switched off, never comes.
      if (!this.backfillEnabled) await this.untilClosed.promise;
      this.indexWorker ??= new IndexWorker(this.workerHost(), this.opts.indexBackfill);
      await this.indexWorker.backfillNow(backfilling, true);
    }
    let def: TableDef | undefined;
    const install = () => {
      const c = this.catalog.withTableStates({});
      c.hidden.delete(meta.tablet);
      def = c.add(name, meta.tablet, meta.number, catalogIndexes("enabled"), "hidden", metaId);
      this.catalog = c;
    };
    await this.runMutation(
      async (db) => {
        const { indexes: stored } = await readCatalog(db);
        for (const i of stored)
          if (i.tablet === meta.tablet && i.state !== "enabled")
            await db.patch(INDEX_TABLE, i._id, indexStatePatch(i, { state: "enabled", staged: false }));
        db.onCommitVisible = install;
      },
      true,
      "_system/snapshot_import_enable_indexes",
    );
    // Nothing to enable (no copied index, or a system table's, enabled by its backfill): no commit to wait for.
    if (!def) install();
    return def!;
  }

  /**
   * Make hidden tables active and delete active ones, in ONE commit (Convex's `activate_tables`): a hidden
   * table replaces the active table of its name, which is deleted. Every transaction that used a replaced
   * or deleted table conflicts (it read the table's `_tables` document) and every query that read one is
   * invalidated. `body` runs in the same transaction (an import's last checks).
   */
  async activateTables(
    tablets: TabletId[],
    deleteNames: string[] = [],
    body?: (db: Tx) => Promise<void>,
  ): Promise<{ deleted: TableDef[]; ts: bigint }> {
    let deleted: TableDef[] = [];
    const { ts } = await this.runMutation(
      async (db) => {
        const { tables } = await readCatalog(db);
        const toDelete = new Set<TabletId>();
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
          // A `v.id` a staged validator holds no longer points where its validation checked (7236c10).
          if (this.opts.storedSchema)
            await this.invalidateTableReferences(db, SYSTEM_TO_VIRTUAL_TABLE[t.name] ?? t.name);
        }
        const purge = await this.dropDeletedTableIndexes(db, toDelete);
        if (body) await body(db);
        const deleteList = [...toDelete];
        db.onCommitVisible = (ts) => {
          deleted = deleteList.map((tb) => this.catalog.byTablet(tb)!).filter(Boolean);
          this.catalog = this.catalog.withTableStates({ activate: tablets, delete: deleteList });
          this.noteDeletedTables(purge, ts);
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
    return { deleted, ts };
  }

  /**
   * Drop hidden tables older than `maxAgeMs` (Convex's `cleanup_hidden_tables`: an import's tables left behind
   * by a crash), at most 1000 per call. How many were dropped.
   */
  async dropStaleHiddenTables(maxAgeMs: number, now = Date.now()): Promise<number> {
    const stale = (await this.query((db) =>
      db.asSystem(async () =>
        (
          await db.query(TABLES_TABLE).collect()
        )
          .filter(
            (t) => t.state === "hidden" && t.namespace === undefined && now - (t._creationTime as number) > maxAgeMs,
          )
          .slice(0, 1000)
          .map((t) => tableMeta(t).tablet),
      ),
    )) as TabletId[];
    if (stale.length) await this.dropHiddenTables(stale);
    return stale.length;
  }

  /** Drop hidden tables (a failed import's): invisible already, their documents removed in the background. */
  async dropHiddenTables(tablets: TabletId[]) {
    await this.runMutation(
      async (db) => {
        const { tables } = await readCatalog(db);
        const gone: TabletId[] = [];
        for (const tablet of tablets) {
          const t = tables.find((x) => x.tablet === tablet);
          if (!t || t.state !== "hidden") continue;
          await db.patch(TABLES_TABLE, t._id, { state: "deleting" });
          gone.push(tablet);
        }
        const purge = await this.dropDeletedTableIndexes(db, gone);
        db.onCommitVisible = (ts) => {
          this.catalog = this.catalog.withTableStates({ delete: gone });
          this.noteDeletedTables(purge, ts);
        };
      },
      true,
      "_system/drop_hidden_tables",
    );
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
   * tables too (the scheduler's, STUDY-113). `body` runs in the replacing transaction. With `createMissing`, a
   * name with no table gets a new empty one (Convex's `clear_tables`, STUDY-141: "This will create … tables if
   * they don't exist"); otherwise it is an error.
   */
  async replaceWithEmptyTables(
    names: string[],
    body?: (db: Tx) => Promise<void>,
    opts: { createMissing?: boolean } = {},
  ) {
    const tablets: TabletId[] = [];
    try {
      for (const name of names) {
        if (opts.createMissing && !this.catalog.tables.has(name)) {
          tablets.push((await this.createHiddenTable(name)).id);
          continue;
        }
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

  /**
   * A deleted table's `_index` rows go in its deletion's transaction, as Convex's
   * `delete_table_by_id_bypassing_schema_enforcement` drops `all_indexes_on_table` (STUDY-195 §1): its database,
   * search and vector indexes alike. Returns, by tablet, the database indexes' persistence ids, whose stored rows the
   * purge removes once document retention passes the deletion.
   */
  private async dropDeletedTableIndexes(db: Tx, tablets: Iterable<TabletId>): Promise<Map<TabletId, string[]>> {
    const wanted = new Set(tablets);
    const out = new Map<TabletId, string[]>();
    if (!wanted.size) return out;
    for (const t of wanted) out.set(t, []);
    for (const r of (await db.query(INDEX_TABLE).collect()) as Record<string, unknown>[]) {
      const tablet = r.table_id as TabletId;
      if (!wanted.has(tablet)) continue;
      await db.delete(INDEX_TABLE, r._id as string);
      if (!isSearchIndexRow(r)) out.get(tablet)!.push(indexIdOf(r._id as string));
    }
    return out;
  }

  /**
   * After tables' deletion committed at `ts`: their search rows forgotten by their writer (the rows went with the
   * deletion), their indexes recorded for the purge (a bunvex global, read again at a start), and each handed to
   * retention, which purges it once the document window passes `ts` (DV-580).
   */
  private noteDeletedTables(purge: Map<TabletId, string[]>, ts: bigint) {
    if (!purge.size) return;
    this.indexRows?.forgetTablets(new Set(purge.keys()));
    for (const [tablet, indexes] of purge) this.retention?.scheduleTabletPurge(tablet, ts, indexes);
    void this.recordDeletedTables((all) => {
      for (const [tablet, indexes] of purge) all[tablet] = indexes;
    }).catch((err: Error) => {
      if (!this.closed) console.error(`bunvex: the deleted tables' indexes could not be recorded: ${err.message}`);
    });
  }

  /** The deleted tables' indexes, by tablet, in the bunvex global `DELETED_TABLES_GLOBAL`; changes are serialized. */
  private deletedTablesWrite: Promise<void> = Promise.resolve();
  private recordDeletedTables(change: (all: Record<string, string[]>) => void): Promise<void> {
    const run = this.deletedTablesWrite.then(async () => {
      const all = readDeletedTables(await this.persistence.getGlobal(DELETED_TABLES_GLOBAL));
      change(all);
      await this.persistence.setGlobal(DELETED_TABLES_GLOBAL, all);
    });
    this.deletedTablesWrite = run.catch(() => {});
    return run;
  }

  /**
   * Hands every `deleting` table to retention's purge (Convex's `tablets_to_delete`, at a start): its deletion ts, the
   * ts of its `_tables` row's revision, and the indexes recorded for it (none for a store another binary wrote: its
   * documents go, as Convex's `delete_tablet_documents`). Each is purged once the document window passes its
   * deletion, its `_tables` row then removed (`finishTableDeletion`); until then it keeps its number.
   */
  async startTableDeletion() {
    const retention = this.retention;
    if (!retention || !this.catalog.deleting.size) return;
    const recorded = readDeletedTables(await this.persistence.getGlobal(DELETED_TABLES_GLOBAL));
    const waiting = retention.waitingTablets();
    const tablesTablet = this.catalog.tables.get(TABLES_TABLE)?.id;
    const rows = (await this.runMutation(
      (db) => db.query(TABLES_TABLE).collect() as Promise<Record<string, unknown>[]>,
      true,
    )) as Record<string, unknown>[];
    for (const t of this.catalog.deleting.values()) {
      if (waiting.has(t.id)) continue;
      const row = rows.find((r) => tableMeta(r).tablet === t.id);
      if (!row || !tablesTablet) continue;
      const version = await this.persistence.get(tablesTablet, internalIdOf(row._id as string), MAX_TS);
      if (!version) continue;
      retention.scheduleTabletPurge(t.id, version.ts, recorded[t.id] ?? []);
    }
  }

  /** Retention purged a deleted table's rows: its `_tables` row goes (Convex's `hard_delete_tablet_document`). */
  private async finishTableDeletion(tablet: TabletId) {
    await this.runMutation(
      async (db) => {
        const { tables } = await readCatalog(db);
        const meta = tables.find((x) => x.tablet === tablet);
        if (meta && meta.state !== "deleting")
          throw new Error(`Cannot hard-delete tablet ${tablet} in state ${meta.state}, expected Deleting`);
        if (meta) await db.delete(TABLES_TABLE, meta._id);
        db.onCommitVisible = () => {
          this.catalog = this.catalog.withTableStates({ gone: [tablet] });
        };
      },
      true,
      "_system/cleanup_deleted_tablets",
    );
    await this.recordDeletedTables((all) => {
      delete all[tablet];
    });
  }

  /**
   * Runs retention's purge of the deleted tables past the document window now and waits for it (tests); a table
   * deleted inside the window is kept.
   */
  async tablesDeleted() {
    await this.retention?.purgeTablets();
  }

  /**
   * Install a committed `_index` change: a new catalog object (transactions already running keep theirs,
   * as Convex's index registry belongs to a snapshot), and an empty query cache — a cached result may have
   * read an index that is gone and will never be invalidated by a write again. Runs under way are not
   * stored either (`cacheEpoch`).
   */
  private installIndexChanges(changes: { enable: IndexId[]; disable: IndexId[]; drop: IndexId[] }, ts: bigint) {
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
      installIndexChanges: (c: { enable: IndexId[]; disable: IndexId[]; drop: IndexId[] }, ts: bigint) =>
        this.installIndexChanges(c, ts),
      finishSchema: () => this.finishSchema(),
      minSnapshotTs: () => this.retention?.minIndexTs ?? 0n,
      tableCount: (tablet: TabletId) => {
        try {
          return this.tableSummaries.count(tablet);
        } catch {
          return null; // the summaries are not built yet
        }
      },
    };
  }

  /**
   * A transaction's first `_creationTime`: the clock floored at its snapshot, past the previous transaction's
   * start and every `_creationTime` it has handed out (several documents of one transaction in the same ms
   * would otherwise sort after the next transaction's first).
   */
  private transactionStart(snapshot: bigint): number {
    const last = this.lastTx ? Math.max(this.lastStart, this.lastTx.creationCursor) : this.lastStart;
    this.lastStart = transactionStart(snapshot, this.runtime.preciseNow(), last);
    return this.lastStart;
  }

  /** A transaction for a call or the engine's own body, wired to the engine's store and services (`CallHost.begin`). */
  private beginTx(s: TxStart): Tx {
    const tx = new Tx(this.catalog, this.persistence, s.ts, s.kind === "mutation", s.now, s.system);
    // Only a mutation hands out creation times: a query begun meanwhile must not hide its cursor.
    if (s.kind === "mutation") this.lastTx = tx;
    tx.retention = this.retention;
    // A subscription's run never used the index cache.
    if (!s.tracked) tx.indexCache = this.indexCache;
    tx.identity = s.identity;
    tx.systemIdentity = s.systemIdentity;
    tx.request = s.request;
    tx.cursorCodec = this.cursorCodecOf;
    tx.searchIndexes = this.searchIndexes;
    tx.vectorIndexes = this.vectorIndexes;
    tx.tableCount = this.tableCountOf;
    // Reactive pagination: a re-run ends its page where the previous run ended (Convex's QueryJournal).
    if (s.tracked) tx.prevEndCursor = s.journal;
    if (s.kind === "mutation") {
      tx.docValidators = this.docValidators;
      tx.componentValidators = (ns) => this.componentSchemas.get(ns)?.validators;
      tx.pendingValidators = this.pendingValidators;
      tx.pendingSchemaId = this.pendingValidators ? (this.pendingPush?.id ?? null) : null;
      tx.stagedChecks = this.stagedChecks;
    }
    if (this.tracerOf.on) this.indexSpansOf(tx);
    return tx;
  }

  /** What a mutation's transaction writes in itself once its body returned (`CallHost.finish`). */
  private async finishTx(tx: Tx): Promise<void> {
    // A write a staged validator refused fails its validation in this same transaction (900fe2c).
    for (const v of tx.stagedViolations.values()) await markStagedValidationFailed(tx, v.schemaId, v.table, v.error);
    // A write the pending (or validated) schema refused fails it in this same transaction, as Convex's `enforce`
    // (`mark_failed`): a push that commits it conflicts, and the transaction that wrote it commits with it.
    const pv = tx.pendingViolation;
    if (pv && tx.pendingSchemaId !== null) await markSchemaFailed(tx, tx.pendingSchemaId, pv.error, pv.table, null);
  }

  /**
   * Run `body` in a new transaction at `snapshot`, as a deterministic execution frozen at its start: the engine's
   * own body in the thread, or a call through the boundary (`dispatch`). Settles instead of throwing.
   */
  private async execute<T>(
    kind: "query" | "mutation",
    snapshot: bigint,
    body: TxBody<T> | Call,
    system = false,
    caller: Caller = ANONYMOUS,
    opts: ExecuteOptions = {},
  ): Promise<Ran<T>> {
    const start: TxStart = {
      kind,
      ts: snapshot,
      now: this.transactionStart(snapshot), // the first _creationTime; Date.now() in the body is its floor
      system,
      identity: caller.identity,
      systemIdentity: caller.systemIdentity === true,
      request: caller.request ?? null,
      tracked: opts.tracked === true,
      journal: opts.journal ?? null,
    };
    if (isCall(body)) return this.retained(start, await this.dispatch<T>(body, start, opts));
    const run = await runTransaction(this.inThread, start, opts.wrap ? opts.wrap(body) : body);
    return this.retained(start, {
      ...run,
      now: start.now,
      outcome: outcomeOf(0, kind, run, run.ok ? "ok" : "failed", null),
    });
  }

  /**
   * Convex's `validate_run_function_result` (crates/function_runner/src/server.rs): once a function's query or
   * mutation ran, its snapshot must still be inside the retention window, whichever runner ran it (Convex's
   * in-process runner checks too). A run the window passed fails with `OutOfRetentionError` instead of its
   * result, and a mutation's writes are dropped. The engine's own transactions are not functions' runs.
   */
  private retained<T>(start: TxStart, ran: Ran<T>): Ran<T> {
    if (start.system || !this.retention) return ran;
    try {
      this.retention.check(start.ts);
      return ran;
    } catch (error) {
      return { ...ran, ok: false, error, outcome: { ...ran.outcome, status: "failed", result: null, writes: null } };
    }
  }

  /**
   * The dispatcher's side of a call (STUDY-194 §4.4, §4.5): a query's permit, the request as text to the body
   * runner, and its outcome back as text. What the engine then does with the run (the cache, the subscriptions, OCC
   * and the commit) reads the decoded outcome; `CallLocal` holds the rest for now.
   */
  private async dispatch<T>(call: Call, start: TxStart, opts: ExecuteOptions): Promise<Ran<T>> {
    const id = ++this.callIds;
    let release: (() => void) | undefined;
    try {
      release = call.permit ? await call.permit() : undefined;
    } catch (error) {
      // No permit: the call fails without running, having read nothing.
      return { ok: false, error, observedTime: false, now: start.now, outcome: notRun(id) };
    }
    try {
      const request: CallRequest = {
        ...call.spec,
        id,
        ts: start.ts,
        now: start.now,
        // In-thread without the codec the identity object goes beside the request instead (`runRequest`).
        identity: start.identity == null || !this.callCodec ? null : JSON.stringify(start.identity),
        systemIdentity: start.systemIdentity,
        request: start.request,
        tracked: start.tracked,
        journal: start.journal,
        refused: opts.refused === true,
      };
      // Through the codec under the tests; as objects otherwise (STUDY-194 Q7).
      const run = this.callCodec
        ? async () => {
            const r = await this.runner.run(encodeCallRequest(request), call.bodies, call.local);
            return { outcome: decodeCallOutcome(r.wire), local: r.local };
          }
        : () => this.runner.runRequest(request, start.identity ?? null, call.bodies, call.local);
      const { outcome, local } = await (opts.wrap ? opts.wrap(run) : run)();
      if (outcome.id !== request.id) throw new Error(`call ${request.id} was answered as call ${outcome.id}`);
      const ran = { tx: local.tx, observedTime: outcome.observedTime, now: start.now, outcome };
      if (outcome.status === "failed") return { ...ran, ok: false, error: local.error };
      const value =
        outcome.status === "refused"
          ? REFUSED
          : outcome.status === "replayed"
            ? { replayed: JSON.parse(outcome.result ?? "null") }
            : local.value;
      return { ...ran, ok: true, value: value as T };
    } finally {
      release?.();
    }
  }

  /**
   * A read-only transaction. With a `cacheKey`, through the query cache (STUDY-08 D8). `at`: the snapshot
   * (≤ the visible ts) instead of the latest.
   */
  async query<T>(
    body: TxBody<T> | Call,
    cacheKey?: string,
    companion?: CacheCompanion,
    caller?: Caller,
    at?: bigint,
  ): Promise<T> {
    const r = await this.cachedQuery(body, cacheKey, companion, caller, at);
    return "value" in r ? r.value : (parseValue(r.json) as T);
  }

  /**
   * The same, as the result's JSON: a cache hit goes straight to the transport without a parse or a
   * stringify (the HTTP API).
   */
  async queryJson(
    body: TxBody<unknown> | Call,
    cacheKey?: string,
    companion?: CacheCompanion,
    caller?: Caller,
    at?: bigint,
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
    body: TxBody<T> | Call,
    cacheKey: string | undefined,
    companion: CacheCompanion | undefined,
    caller: Caller = ANONYMOUS,
    at?: bigint,
  ): Promise<{ json: string } | { value: T; json?: string }> {
    const visible = this.committer.visibleTs;
    const ts = at === undefined || at > visible ? visible : at;
    if (cacheKey === undefined) {
      const ran = await this.execute("query", ts, body, false, caller);
      return { value: ranValue(ran), json: ran.outcome.result ?? undefined };
    }
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
    body: TxBody<T> | Call,
    ts: bigint,
    keys: readonly [precise: string, shared: string],
    key: string,
    coordinate: boolean,
    companion: CacheCompanion | undefined,
    caller: Caller,
  ): Promise<{ value: T; json?: string }> {
    this.stats.cacheMisses++;
    const waiting = coordinate ? this.cache.putWaiting(key, ts) : undefined;
    const epoch = this.cacheEpoch;
    let wrapped: ReturnType<CacheCompanion["wrap"]> | undefined;
    const wrap =
      waiting && companion
        ? <F extends (...args: never[]) => unknown>(run: F): F => {
            wrapped = companion.wrap(run as unknown as (...args: unknown[]) => unknown);
            return wrapped.body as unknown as F;
          }
        : undefined;
    let run: Ran<T>;
    try {
      run = await this.execute("query", ts, body, false, caller, { wrap });
      if (!run.ok) throw run.error;
    } catch (error) {
      // Errors are not cached; whoever waited plans again.
      if (waiting) {
        this.cache.removeWaiting(key, waiting.id);
        waiting.settle(null);
      }
      throw error;
    }
    const { value, outcome, now } = run;
    if (!waiting) return { value, json: outcome.result ?? undefined };
    this.cache.removeWaiting(key, waiting.id);
    if (epoch !== this.cacheEpoch) {
      waiting.settle(null);
      return { value, json: outcome.result ?? undefined };
    }
    // Keyed by the caller only if the run read the identity (STUDY-27 §1.4). The cache keeps its own
    // serialized copy; the caller keeps `value`.
    const stored = outcome.identityObserved ? keys[0] : keys[1];
    const json = outcome.result ?? stringifyValue(value);
    const result: CachedResult = {
      json,
      extra: wrapped?.capture(),
      originalTs: ts,
      tokenTs: ts,
      reads: outcome.reads,
      observedTime: outcome.observedTime,
      unixMs: Math.floor(now),
      identityObserved: outcome.identityObserved,
      endCursor: outcome.endCursor,
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
  private stillValid(key: string, r: CachedResult, ts: bigint): MissReason | undefined {
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
   * A subscription's run through the query cache, as Convex's sync worker asks `CacheManager::get` (STUDY-08 §7):
   * the same entries as `cachedQuery` (`cacheKey` with the caller's key, or `*` for a run that did not read the
   * identity), with the journal in the key when it is not empty. A hit answers with the stored result, its reads
   * valid at the snapshot (the token, refreshed) and its journal, its lines replayed through `companion` as a
   * hit. A miss runs as `queryTracked` and stores a successful result, under the request's journal and the
   * outcome's (Convex's `cache_keys_after_execution`). A failure is not stored, and still returns its reads.
   * Without a `cacheKey`, `queryTracked`.
   */
  async cachedQueryTracked<T>(
    body: TxBody<T> | Call,
    cacheKey: string | undefined,
    companion: CacheCompanion | undefined,
    journal: QueryJournal = {},
    at?: bigint,
    caller: Caller = ANONYMOUS,
  ): Promise<Awaited<ReturnType<Engine["queryTracked"]>> & { cached?: boolean; entry?: CachedEntryRef }> {
    if (cacheKey === undefined) return this.queryTracked<T>(body, journal, at, caller);
    const visible = this.committer.visibleTs;
    const ts = at === undefined || at > visible ? visible : at;
    const keyed = (j: string | null | undefined) => (j ? `${cacheKey}\u0000j:${j}` : cacheKey);
    const base = keyed(journal.endCursor);
    const keys = [`${base}${ID_SEP}${caller.key}`, `${base}${ID_SEP}*`] as const;
    let hint: string | undefined;
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
        return this.runCachedTracked<T>(body, ts, keys, key, e === undefined, companion, caller, journal, keyed);
      }
      dropped = this.stillValid(key, r, ts);
      if (dropped !== undefined) continue;
      this.stats.cacheHits++;
      companion?.replay(r.extra);
      return {
        ok: true,
        value: parseValue(r.json) as T,
        json: r.json,
        reads: r.reads,
        ts,
        journal: { endCursor: r.endCursor ?? null },
        identityObserved: r.identityObserved,
        documentsRead: 0,
        bytesRead: 0,
        cached: true,
        entry: { key, result: r },
      };
    }
  }

  /** `runCached` for a subscription: `queryTracked`'s run and answer, its successful result stored. */
  private async runCachedTracked<T>(
    body: TxBody<T> | Call,
    ts: bigint,
    keys: readonly [precise: string, shared: string],
    key: string,
    coordinate: boolean,
    companion: CacheCompanion | undefined,
    caller: Caller,
    journal: QueryJournal,
    keyed: (j: string | null | undefined) => string,
  ): Promise<Awaited<ReturnType<Engine["queryTracked"]>> & { entry?: CachedEntryRef }> {
    this.stats.cacheMisses++;
    const waiting = coordinate ? this.cache.putWaiting(key, ts) : undefined;
    const epoch = this.cacheEpoch;
    let wrapped: ReturnType<CacheCompanion["wrap"]> | undefined;
    // Always through the companion: the session keeps the run's lines for those who reuse it, stored or not.
    const wrap = companion
      ? <F extends (...args: never[]) => unknown>(run: F): F => {
          wrapped = companion.wrap(run as unknown as (...args: unknown[]) => unknown);
          return wrapped.body as unknown as F;
        }
      : undefined;
    let run: Ran<T>;
    try {
      run = await this.execute("query", ts, body, false, caller, {
        tracked: true,
        journal: journal.endCursor ?? null,
        wrap,
      });
    } catch (error) {
      if (waiting) {
        this.cache.removeWaiting(key, waiting.id);
        waiting.settle(null);
      }
      throw error;
    }
    // Captured whether or not it is stored: the companion keeps the run's lines for those who reuse it.
    const extra = wrapped?.capture();
    const o = run.outcome;
    const out = {
      reads: o.reads,
      ts,
      journal: { endCursor: o.endCursor },
      identityObserved: o.identityObserved,
      documentsRead: o.documentsRead,
      bytesRead: o.bytesRead,
    };
    // Errors are not cached (Convex: "We do not cache JSErrors"); whoever waited plans again.
    if (!run.ok || !waiting || epoch !== this.cacheEpoch) {
      if (waiting) {
        this.cache.removeWaiting(key, waiting.id);
        waiting.settle(null);
      }
      return run.ok
        ? { ok: true, value: run.value, ...(o.result === null ? {} : { json: o.result }), ...out }
        : { ok: false, error: run.error, ...out };
    }
    this.cache.removeWaiting(key, waiting.id);
    const json = o.result ?? stringifyValue(run.value);
    const result: CachedResult = {
      json,
      extra,
      originalTs: ts,
      tokenTs: ts,
      reads: o.reads,
      observedTime: o.observedTime,
      unixMs: Math.floor(run.now),
      identityObserved: o.identityObserved,
      endCursor: o.endCursor,
    };
    const stored = o.identityObserved ? keys[0] : keys[1];
    this.cache.putReady(stored, result);
    // Also under the outcome's journal: the same caller's next request asks with it (Convex's
    // `cache_keys_after_execution`).
    if ((o.endCursor ?? null) !== (journal.endCursor ?? null)) {
      const id = stored === keys[0] ? caller.key : "*";
      this.cache.putReady(`${keyed(o.endCursor)}${ID_SEP}${id}`, result);
    }
    waiting.settle(stored === key ? result : null);
    return { ok: true, value: run.value, json, ...out, entry: { key: stored, result } };
  }

  /**
   * Drops a cached result its owner knows a commit at `commitTs` wrote into (a subscription's sync hub matched it):
   * what `stillValid` would find, without walking the write log. Only if it is still the entry at `key`.
   */
  dropCachedResult(ref: CachedEntryRef, commitTs: bigint) {
    if (ref.result.originalTs >= commitTs) return;
    const found = this.cache.find([ref.key]);
    if (found?.entry.kind === "ready" && found.entry.result === ref.result)
      this.cache.removeReady(ref.key, ref.result.originalTs);
  }

  /**
   * A read-only transaction for a SUBSCRIPTION: never touches the cache, and settles instead of throwing.
   * A failed run still returns what it read before failing — as in Convex, an error is a result that is
   * re-evaluated when those reads change (e.g. a query that throws until a document exists).
   */
  async queryTracked<T>(
    body: TxBody<T> | Call,
    journal: QueryJournal = {},
    /** Run at this snapshot (≤ visibleTs) instead of the latest: a sync transition runs all at one ts. */
    at?: bigint,
    caller: Caller = ANONYMOUS,
  ): Promise<
    ({ ok: true; value: T; json?: string } | { ok: false; error: unknown }) & {
      reads: Interval[];
      ts: bigint;
      journal: QueryJournal;
      /** Whether the run read the identity: its result is then the caller's alone. */
      identityObserved: boolean;
      /** What it read (STUDY-131 AD-25). */
      documentsRead: number;
      bytesRead: number;
    }
  > {
    const visible = this.committer.visibleTs;
    const snapshot = at === undefined || at > visible ? visible : at;
    const run = await this.execute("query", snapshot, body, false, caller, {
      tracked: true,
      journal: journal.endCursor ?? null,
    });
    const o = run.outcome;
    const out = {
      reads: o.reads,
      ts: snapshot,
      journal: { endCursor: o.endCursor },
      identityObserved: o.identityObserved,
      documentsRead: o.documentsRead,
      bytesRead: o.bytesRead,
    };
    return run.ok
      ? { ok: true, value: run.value, ...(o.result === null ? {} : { json: o.result }), ...out }
      : { ok: false, error: run.error, ...out };
  }

  /**
   * A read-write transaction, re-run on conflict with Convex's retry budget and backoff; an `OccError`
   * once the budget is spent. `source` names the mutation (e.g. "messages:send") in the conflict errors of
   * the transactions it beats.
   */
  mutation<T>(body: TxBody<T> | Call, source?: string, caller?: Caller, opts?: MutationOptions): Promise<T> {
    return this.runMutation(body, false, source, false, caller, opts);
  }

  /**
   * The same, with the commit timestamp (the snapshot, for a mutation that wrote nothing): what the sync
   * protocol's MutationResponse carries so a client can wait for its queries to reflect the write.
   */
  mutationWithTs<T>(
    body: TxBody<T> | Call,
    source?: string,
    caller?: Caller,
    opts?: MutationOptions,
  ): Promise<{ value: T; ts: bigint }> {
    return this.runMutation(body, false, source, true, caller, opts);
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
    body: TxBody<T> | Call,
    source: string | undefined,
    request: SessionRequestId,
    outcome: (value: T) => SessionRequestOutcome,
    caller?: Caller,
    opts?: MutationOptions,
  ): Promise<{ ts: bigint } & ({ value: T } | { replayed: SessionRequestOutcome })> {
    // Whether this attempt's permit was refused: a recorded outcome is still answered (`inSession`).
    const attempt = { refused: false };
    const run: TxBody<unknown> | Call = isCall(body)
      ? {
          ...body,
          spec: { ...body.spec, session: request },
          bodies: { body: (r, local) => body.bodies.body(r, local), record: (v) => outcome(v as T) },
        }
      : (db) => inSession(db, request, attempt.refused, async () => body(db), outcome);
    const r = (await this.runMutation(run, false, source, true, caller, opts, undefined, attempt)) as {
      value: { value: T } | { replayed: SessionRequestOutcome };
      ts: bigint;
    };
    return { ...r.value, ts: r.ts };
  }

  /** Delete one chunk of session requests created before `cutoffMs` (retention); how many it deleted. */
  deleteSessionRequests(cutoffMs: number, limit = SESSION_CLEANUP_CHUNK): Promise<number> {
    return this.runMutation(
      (db) => deleteSessionRequestsBefore(db, cutoffMs, limit),
      true,
      "_system/session_requests_cleanup",
    );
  }

  private runMutation<T>(
    body: TxBody<T> | Call,
    system: boolean,
    source?: string,
    withTs?: false,
    caller?: Caller,
    opts?: MutationOptions,
    maxRetries?: number,
  ): Promise<T>;
  private runMutation<T>(
    body: TxBody<T> | Call,
    system: boolean,
    source: string | undefined,
    withTs: true,
    caller?: Caller,
    opts?: MutationOptions,
    maxRetries?: number,
    session?: { refused: boolean },
  ): Promise<{ value: T; ts: bigint }>;
  // `withTs` rather than a wrapper, so the common path costs no extra promise.
  /** `attempts`, counted in `runningMutations` until it settles: a close waits for it to reach the committer. */
  private runMutation<T>(
    body: TxBody<T> | Call,
    system: boolean,
    source?: string,
    withTs = false,
    caller: Caller = ANONYMOUS,
    opts: MutationOptions = {},
    retries?: number,
    session?: { refused: boolean },
  ): Promise<unknown> {
    const running = this.attempts(body, system, source, withTs, caller, opts, retries, session);
    this.runningMutations.add(running);
    void running.finally(() => this.runningMutations.delete(running)).catch(() => {});
    return running;
  }

  /**
   * A mutation's attempts. With `opts.permit`, each attempt takes its permit before its transaction begins, so its
   * snapshot has what committed during the wait (Convex's d328f85, STUDY-186 A11); the engine's own mutations, and
   * scheduled and cron ones (whose body takes it, in Convex's old order), have none here.
   */
  private async attempts<T>(
    body: TxBody<T> | Call,
    system: boolean,
    source?: string,
    withTs = false,
    caller: Caller = ANONYMOUS,
    opts: MutationOptions = {},
    retries?: number,
    session?: { refused: boolean },
  ): Promise<unknown> {
    const maxRetries = retries ?? this.opts.maxRetries ?? OCC_MAX_RETRIES;
    const initialMs = this.opts.occInitialBackoffMs ?? OCC_INITIAL_BACKOFF_MS;
    const maxMs = this.opts.occMaxBackoffMs ?? OCC_MAX_BACKOFF_MS;
    const throttled = opts.throttled === true;
    for (let failures = 0; ; ) {
      // Each attempt of a mutation first checks the write throughput limit (STUDY-78), as Convex's
      // `acquire_mutation_permit`; refused, it is retried within the OCC budget and backoff, then fails.
      let limit = throttled ? this.writeThroughput.exceededNow() : null;
      // Each attempt after the first starts only on an open engine: a retry after the close would read a closed store.
      if (!limit && failures > 0 && this.closed) throw new Error("the engine closed");
      let release: (() => void) | undefined;
      let refused: { error: unknown } | undefined;
      if (!limit && opts.permit) {
        try {
          release = await opts.permit();
        } catch (error) {
          refused = { error };
        }
        // Checked again once the permit is held, as Convex's `run_mutation_inner`.
        limit = release && throttled ? this.writeThroughput.exceededNow() : null;
        if (limit) release?.();
      }
      if (limit) {
        if (failures >= maxRetries) throw this.writeThroughput.error(limit);
        const sleep = occBackoffMs(failures, initialMs, maxMs);
        failures++;
        this.stats.writeThroughputRetries++;
        await longSleep(sleep); // UDF_EXECUTOR_OCC_MAX_BACKOFF_MS is a knob
        continue;
      }
      // Without a permit only a session's recorded outcome can still answer (Convex runs the attempt's replay check).
      if (refused && !session) throw refused.error;
      if (session) session.refused = refused !== undefined;
      let ran: Ran<T>;
      try {
        ran = await this.execute("mutation", this.committer.visibleTs, body, system, caller, {
          refused: refused !== undefined,
        });
      } finally {
        // Held for the run only, as Convex's (dropped when `function_runner_execute` returns), not the commit.
        release?.();
      }
      if (!ran.ok) throw ran.error;
      if (ran.value === REFUSED) throw refused?.error;
      const raw = ran.value;
      // What the commit still takes from the transaction itself, in-thread until the runner sends it (PR 3).
      const tx = ran.tx as Tx;
      const snapshot = tx.snapshot;
      const writes = ran.outcome.writes;
      // `db.vars.commitTs` in the result resolves to the commit's timestamp (STUDY-53): in nanoseconds.
      const resolved = (ts: bigint) => (hasCommitTs(raw) ? resolveCommitTs(raw, ts) : raw);
      if (!writes) {
        const value = resolved(snapshot);
        runAfterCommit(tx);
        return withTs ? { value, ts: snapshot } : value;
      }
      this.checkMemoryIndexSizes(tx);
      const { docs, idx } = writes;
      try {
        const pending: Parameters<Committer["commit"]>[0] = {
          snapshot,
          reads: ran.outcome.reads,
          docs,
          idx,
          source,
          ...this.searchCommit(tx, tx.onCommitVisible ?? undefined),
          ...(ran.outcome.searchReads.length ? { searchReads: ran.outcome.searchReads } : {}),
          ...(tx.hasCommitTs
            ? {
                atTs: (ts: bigint) => {
                  tx.resolveCommitTs(ts);
                  return tx.toWrites();
                },
              }
            : {}),
        };
        const touches = writes.touches;
        if (touches.length) pending.logExtra = [...(pending.logExtra ?? []), ...touches];
        if (this.tracerOf.on) {
          const parent = this.tracerOf.current();
          if (parent) pending.trace = new CommitSpans(parent, docs.length, idx.length);
        }
        const ts = await this.committer.commit(pending);
        const value = resolved(ts);
        // Tables the mutation created exist for everyone from now on (their _tables/_index documents are
        // durable; a transaction that raced to create the same table conflicted on _tables and retries).
        for (const { def } of tx.createdTables.values()) {
          let space = this.catalog;
          if (def.namespace !== undefined) {
            space = this.catalog.components.get(def.namespace) ?? new Catalog();
            this.catalog.components.set(def.namespace, space);
          }
          if (space.tables.has(def.name)) continue;
          const added = space.add(
            def.name,
            def.id,
            def.number,
            [...def.indexes.values()].map((i) => ({ name: i.name, fields: i.fields, id: i.id })),
            "active",
            def.metaId,
          );
          if (def.namespace !== undefined) added.namespace = def.namespace;
        }
        runAfterCommit(tx);
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
        await longSleep(sleep); // UDF_EXECUTOR_OCC_MAX_BACKOFF_MS is a knob
        // As Convex: wait for the write we lost to, so the next snapshot contains it.
        await this.committer.waitForVisible(e.conflict.writeTs);
      }
    }
  }

  /** The OCC error for `conflict`, worded as Convex's (without its documentation link). */
  private occError(conflict: Conflict, source: string | undefined, retries: number): OccError {
    let table: string | undefined;
    // The component whose table it is (Convex's `OccInfo.component_path`): null for the app's.
    let componentId: string | null = null;
    if (conflict.index !== undefined) {
      for (const t of this.catalog.tables.values())
        for (const ix of t.indexes.values()) if (ix.id === conflict.index) table = t.name;
      if (table === undefined)
        for (const [id, space] of this.catalog.components)
          for (const t of space.tables.values())
            for (const ix of t.indexes.values())
              if (ix.id === conflict.index) {
                table = t.name;
                componentId = id;
              }
    }
    const documentId = conflict.id ?? undefined;
    const writeSource = conflict.source;
    // Convex names the document only when it knows which mutation changed it.
    let changedBy = "";
    if (writeSource !== undefined && documentId !== undefined) {
      const who = writeSource === source ? "Another call to this mutation" : writerDescription(writeSource);
      changedBy = ` ${who} changed the document with ID "${documentId}".`;
    }
    const where = table === undefined ? "some table" : `the "${table}" table`;
    return new OccError(
      `Documents read from or written to ${where} changed while this mutation was being run and on every subsequent retry.${changedBy}`,
      { table, componentId, documentId, writeSource, writeTs: conflict.writeTs, retries },
    );
  }
}

/**
 * Convex's `SchemaModel::mark_failed`: a pending or validated schema becomes `failed` with `error`, and its
 * validations are deleted; one in another state is left as it is. In `namespace` (null: the root's).
 */
async function markSchemaFailed(
  db: Tx,
  schemaId: string,
  error: string,
  tableName: string | null,
  namespace: string | null,
) {
  await db.inComponent(namespace, () =>
    db.asSystem(async () => {
      const row = (await db.get(SCHEMAS_TABLE, schemaId)) as Record<string, unknown> | null;
      const state = schemaStateOf(row);
      if (state === "pending" || state === "validated")
        await db.patch(SCHEMAS_TABLE, schemaId, { state: { state: "failed", error, table_name: tableName } });
      // As Convex's `mark_failed`: even when it was failed or overwritten already (STUDY-187 X3).
      await deleteOldFailedAndOverwrittenSchemas(db);
      await deleteValidationsForSchema(db, schemaId);
    }),
  );
}

/**
 * Run what `tx` registered with `afterCommit`, in order; one that throws (or returns a promise that rejects) is
 * logged and the rest still run.
 */
function runAfterCommit(tx: Tx) {
  const failed = (e: unknown) =>
    console.error(`bunvex: an after-commit callback failed: ${e instanceof Error ? e.message : String(e)}`);
  for (const fn of tx.afterCommitCallbacks)
    try {
      const r = fn() as unknown;
      if (r && typeof (r as PromiseLike<unknown>).then === "function") (r as Promise<unknown>).then(undefined, failed);
    } catch (e) {
      failed(e);
    }
}

/**
 * Who changed a document an OCC conflict names (Convex's `occ_write_source_string`, b352fab; DV-435): a call to
 * the app's function by its path; bunvex's own writers (every source under `_system/`, which no app function
 * can use) by what was done, as Convex's `convex_writer_description` in bunvex's words.
 */
export function writerDescription(source: string): string {
  if (!source.startsWith("_system/")) return `A call to "${source}"`;
  const label = source.slice("_system/".length);
  if (label.startsWith("frontend/")) return "An edit in the dashboard";
  if (label.includes("fivetran")) return "A Fivetran sync";
  if (label.includes("airbyte")) return "An Airbyte sync";
  if (label.startsWith("snapshot_import")) return "A data import";
  return "A system operation";
}

/**
 * A transaction's first `_creationTime` (ms), as Convex's `CreationTime::for_transaction`
 * (crates/common/src/document.rs): the clock, but never below the snapshot's timestamp rounded up to the
 * millisecond. Commit timestamps are wall-clock nanoseconds resumed from the store (STUDY-06 D9), so after a
 * restart with the clock behind, the snapshot is ahead of the clock: without the floor a new document would
 * sort before ones it read, and `Date.now()` (floored from this) would go back. Unlike Convex, two
 * transactions of an engine never share a start (`last`, the engine's previous one): bunvex's sub-ms creation
 * times keep same-ms transactions in commit order (parity B5).
 */
export function transactionStart(snapshot: bigint, clockMs: number, last: number): number {
  const t = Math.max(clockMs, Number((snapshot + 999_999n) / 1_000_000n));
  return t > last ? t : nextUp(last);
}

/**
 * MAX_BYTES_WRITTEN_PER_SECOND (bytes), MAX_ROWS_WRITTEN_PER_SECOND (rows, 0 for none) and
 * WRITE_THROUGHPUT_WINDOW (ms), as Convex's knobs, else defaults.
 */
function writeThroughputFromEnv(): WriteThroughputOptions {
  return {
    maxBytesPerSecond: knob("MAX_BYTES_WRITTEN_PER_SECOND", MAX_BYTES_WRITTEN_PER_SECOND),
    maxRowsPerSecond: knob("MAX_ROWS_WRITTEN_PER_SECOND", MAX_ROWS_WRITTEN_PER_SECOND),
    windowMs: knob("WRITE_THROUGHPUT_WINDOW", WRITE_THROUGHPUT_WINDOW_MS),
  };
}

/** How a mutation runs: `throttled`, an app's mutation, checks the write throughput limit (STUDY-78). */
export type MutationOptions = {
  throttled?: boolean;
  /**
   * The mutation's permit (STUDY-68), taken by each attempt before its transaction begins (Convex's d328f85); resolves
   * to its release, which the attempt calls once its run returned, before the commit.
   */
  permit?: () => Promise<() => void>;
};

/** A run as the engine sees it once it settled: its outcome, and the transaction while it stays in the thread. */
type Ran<T> = { tx?: Tx; observedTime: boolean; outcome: CallOutcome; now: number } & (
  | { ok: true; value: T }
  | { ok: false; error: unknown }
);

type ExecuteOptions = {
  /** A subscription's run (`queryTracked`), with its journal. */
  tracked?: boolean;
  journal?: string | null;
  /** What the run is wrapped in: the query cache's companion, which keeps the log lines a hit replays. */
  wrap?: <F extends (...args: never[]) => unknown>(run: F) => F;
  /** This mutation attempt's permit was refused (`CallRequest.refused`). */
  refused?: boolean;
};

function ranValue<T>(ran: Ran<T>): T {
  if (!ran.ok) throw ran.error;
  return ran.value;
}

/** The outcome of a call that never ran (its permit refused). */
const notRun = (id: number): CallOutcome => ({
  id,
  status: "failed",
  result: null,
  reads: [],
  searchReads: [],
  identityObserved: false,
  observedTime: false,
  endCursor: null,
  documentsRead: 0,
  bytesRead: 0,
  writes: null,
});

/**
 * The engine's index cache (STUDY-136), from its option and Convex's knobs: INDEX_CACHE_SIZE (bytes, default
 * 512 MiB; 0 turns it off) and INDEX_CACHE_VERIFY_PERCENT (default 0, DV-433; Convex's is 100). The memory
 * driver already reads in memory: its engine has none unless INDEX_CACHE_SIZE or the option asks (DV-434).
 */
function indexCacheOf(
  persistence: Persistence,
  opt: false | { maxBytes?: number; verifyPercent?: number } | undefined,
  committer: Committer,
): IndexCache | null {
  if (opt === false) return null;
  const sizeSet = process.env.INDEX_CACHE_SIZE !== undefined;
  const maxBytes = opt?.maxBytes ?? knob("INDEX_CACHE_SIZE", INDEX_CACHE_MAX_BYTES);
  if (maxBytes === 0) return null;
  if (opt === undefined && !sizeSet && persistence.readsInMemory === true) return null;
  // Past 100 verifies every hit, as Convex's `random_range(0..100) < percent`.
  const verify = opt?.verifyPercent ?? Math.min(100, knob("INDEX_CACHE_VERIFY_PERCENT", 0));
  return new IndexCache(committer, maxBytes, verify);
}

/** UDF_CACHE_MAX_SIZE (bytes), as Convex's knob, else its default. */
function cacheMaxBytesFromEnv(): number {
  return knob("UDF_CACHE_MAX_SIZE", QUERY_CACHE_MAX_BYTES);
}

/** A schema refusing to lose a table (Convex's `SchemaEnforcementError`). */
export class SchemaEnforcementError extends Error {
  readonly code = "SchemaEnforcementError";
}

/** Why `schema` refuses the deletion of `table` (Convex's `check_delete_table`), or null. */
function deletionRefusal(schema: EngineSchema, table: string): string | null {
  if (declaredTables(schema).has(table)) return `Failed to delete table "${table}" because it appears in the schema`;
  for (const name of [...declaredTables(schema).keys()].sort())
    if (referencedTables(declaredTables(schema).get(name)!.document.json).has(table))
      return `Failed to delete table "${table}" because \`v.id("${table}")\` appears in the schema of table "${name}"`;
  return null;
}

async function readCatalog(db: Tx) {
  return {
    tables: (await db.query(TABLES_TABLE).collect()).map(tableMeta),
    indexes: databaseIndexRows(await db.query(INDEX_TABLE).collect()),
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
  // A store never started has no catalog yet, so no rows.
  if ((await persistence.getGlobal(BOOTSTRAP_GLOBALS.tablesById)) === null) return [];
  const ts = (await persistence.maxTs?.()) ?? 0n;
  const catalog = await loadCatalog(persistence, ts);
  if (!catalog.tables.has(table)) return [];
  return (await new Tx(catalog, persistence, ts, false, wallClock(), true).query(table).collect()) as Record<
    string,
    unknown
  >[];
}

/**
 * The search and vector indexes' states, from their `_index` rows read straight from a store at its latest commit
 * (tests and tools, STUDY-111).
 */
export async function readSearchIndexStates(persistence: Persistence): Promise<{ indexes: IndexSegmentsState[] }> {
  const ts = (await persistence.maxTs?.()) ?? 0n;
  const { indexRows } = await loadCatalogRows(persistence, await readBootstrapIds(persistence), ts);
  const saved = readSavedStates(await persistence.getGlobal(SEGMENTS_GLOBAL));
  const ids = new Set(indexRows.filter(isSearchIndexRow).map((r) => r._id as string));
  return { indexes: [...(saved?.values() ?? [])].filter((e) => ids.has(e.rowId)).map((e) => e.state) };
}

/** Schema enforcement (STUDY-14): each declared table's validator, with the system fields added. */
/** Each table's staged validator as a document validator; checked whether or not the schema validates. */
function stagedDocumentValidatorsOf(schema: EngineSchema): Map<string, GenericValidator> {
  const out = new Map<string, GenericValidator>();
  for (const t of declaredTables(schema).values()) {
    if (t.stagedDocument === undefined) continue;
    const dv = documentValidator(t.name, t.stagedDocument);
    if (dv) out.set(t.name, dv);
  }
  return out;
}

function validatorsOf(schema: EngineSchema): Map<string, GenericValidator> {
  const out = new Map<string, GenericValidator>();
  if (schema.schemaValidation)
    for (const t of declaredTables(schema).values()) {
      const dv = documentValidator(t.name, t.document);
      if (dv) out.set(t.name, dv);
    }
  return out;
}

/**
 * An import that would replace a table still backfilling an index: Convex's `InvalidImport` from
 * `copy_indexes_to_table`, in its words.
 */
export class ImportBackfillingError extends Error {
  readonly code = "InvalidImport";
  constructor(table: string) {
    super(`${table} is still backfilling indexes, so it cannot be replaced. Wait for indexes to complete backfilling`);
    this.name = "ImportBackfillingError";
  }
}

/** Convex's `MAX_TIME_TO_KEEP_FAILED_AND_OVERWRITTEN_SCHEMAS`: one hour, in ns. */
const KEEP_FAILED_AND_OVERWRITTEN_SCHEMAS_NS = 60n * 60n * 1_000_000_000n;

/**
 * Convex's `delete_old_failed_and_overwritten_schemas` (crates/database/src/bootstrap_model/schema/mod.rs), in
 * `db`'s current namespace only: delete every `failed` and `overwritten` schema created at least an hour before the
 * transaction's begin timestamp (its snapshot), so that `_schemas` stays small. It runs each time a schema is marked
 * `overwritten` or `failed`, so the row just marked goes at once when it is that old. Their validations went when
 * they were marked.
 */
async function deleteOldFailedAndOverwrittenSchemas(db: Tx) {
  const begin = db.snapshot - KEEP_FAILED_AND_OVERWRITTEN_SCHEMAS_NS;
  // As Convex's `timestamp_to_ms`: whole ms, then the rest as a fraction.
  const cutoff = Number(begin / 1_000_000n) + Number(begin % 1_000_000n) * 1e-6;
  for (const row of await db.query(SCHEMAS_TABLE).collect()) {
    const state = schemaStateOf(row);
    if (state !== "failed" && state !== "overwritten") continue;
    if ((row._creationTime as number) > cutoff) continue;
    await db.delete(SCHEMAS_TABLE, row._id as string);
  }
}

/** Convex's `mark_overwritten`: the state, then the old failed and overwritten schemas go, then its validations. */
async function markOverwritten(db: Tx, schemaId: string) {
  await db.patch(SCHEMAS_TABLE, schemaId, { state: { state: "overwritten" } });
  await deleteOldFailedAndOverwrittenSchemas(db);
  await deleteValidationsForSchema(db, schemaId);
}

/** A push's schema change that cannot finish (Convex's `RaceDetected`, or indexes not ready). */
/** What a schema becomes when a push submits it (Convex's `submit_pending`): a new or reused pending one, or the active one. */
type SubmittedState = "active" | "pending" | "validated";

/**
 * Submit a push's schema in `db`'s current namespace (Convex's `SchemaModel::submit_pending`, per namespace).
 */
async function submitPending(
  db: Tx,
  schema: EngineSchema,
  json: SchemaJson,
  staged: ReturnType<typeof stagedValidatorsOf>,
): Promise<{ schemaId: string; state: SubmittedState }> {
  // Convex's `submit_pending`: a schema equal to the active one is the active one (an unfinished push is
  // overwritten); one equal to the pending or validated one is that one; else a new pending schema. A push
  // of an unchanged schema retries its failed staged validations; a new schema's staged validations take
  // over what the outgoing schemas' proved (STUDY-106 §7.1).
  const key = schemaKey(json);
  const rows = await db.query(SCHEMAS_TABLE).collect();
  const rowJson = (row: Record<string, unknown>) => JSON.parse(row.schema as string) as SchemaJson;
  const same = (row: Record<string, unknown>) => schemaKey(rowJson(row)) === key;
  const active = rows.find((row) => schemaStateOf(row) === "active");
  const unfinished = rows.filter((row) => {
    const s = schemaStateOf(row);
    return s === "pending" || s === "validated";
  });
  let schemaId: string;
  let state = "pending" as SubmittedState;
  const reused = active && same(active) ? active : unfinished.find(same);
  const carryOver: StagedCarryOver[] = [];
  if (staged.size && active && !reused)
    carryOver.push(
      ...(await stagedValidationsWithProgress(db, active._id as string, stagedValidatorsOf(rowJson(active)))),
    );
  for (const row of unfinished)
    if (row !== reused) {
      if (staged.size && !reused)
        carryOver.push(
          ...(await stagedValidationsWithProgress(db, row._id as string, stagedValidatorsOf(rowJson(row)))),
        );
      await markOverwritten(db, row._id as string);
    }
  if (reused) {
    schemaId = reused._id as string;
    state = schemaStateOf(reused) as typeof state;
    await retryFailedStagedValidators(db, schemaId, staged);
  } else {
    schemaId = await db.insert(SCHEMAS_TABLE, { state: { state: "pending" }, schema: schemaJsonText(schema) });
    await initializeStagedValidators(db, schemaId, staged, carryOver);
  }
  return { schemaId, state };
}

/**
 * What a component's schema may not have yet (STUDY-153 PR 2b): a staged validator, whose walk and checks are the
 * root's only, and search and vector indexes, which the engine builds for the root's tables. Each is refused at the
 * push until it is built for components. (Staged database indexes are only catalog state: they work.)
 */
/** A component deletion refused, as Convex's `delete_component` (a 400). */
export class ComponentDeletionError extends Error {
  readonly status = 400;
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ComponentDeletionError";
  }
}

function checkComponentSchema(schema: EngineSchema) {
  for (const t of declaredTables(schema).values()) {
    if (t.stagedDocument !== undefined)
      throw new Error(`Table "${t.name}": staged validators in a component's schema are not supported yet`);
  }
}

/** What `startSchemaPush` answers: the root's schema id (null for a push without a schema), each component's. */
type StartedSchemaPush<Id> = {
  schemaId: Id;
  addedIndexes: string[];
  components: Map<string, { schemaId: string | null; addedIndexes: string[] }>;
};

/** The indexes a push's finish changed, by `table.index` (`commitSchemaPush`). */
type IndexDiff = { enabled: string[]; disabled: string[]; dropped: string[] };

/**
 * A push's finish in `db`'s current namespace (Convex's `commit_indexes_for_schema` and `SchemaModel::apply`): the
 * schema must be validated (or active already); enable what is backfilled, disable what became staged, drop what
 * was replaced or removed, and make the schema `active`. A push without a schema (`schemaId` null, Convex's
 * `apply(None)`) declares no user table, so every user index goes, and the active schema is marked `overwritten`
 * with none in its place (`clear_active`); a pending one is left as it is.
 */
async function finishSchemaIn(
  db: Tx,
  schemaId: string | null,
  declared: Iterable<DeclaredTable>,
  namespace?: string,
): Promise<{ f: FinishChanges; tables: TableMeta[] }> {
  let state: ReturnType<typeof schemaStateOf> | null = null;
  if (schemaId !== null) {
    const row = (await db.get(SCHEMAS_TABLE, schemaId)) as Record<string, unknown> | null;
    state = schemaStateOf(row);
    const failed = schemaFailureOf(row);
    if (failed) throw new SchemaPushError("SchemaNotReady", `Schema validation failed: ${failed.error}`);
    if (!row || (state !== "pending" && state !== "validated" && state !== "active"))
      throw new SchemaPushError("RaceDetected", "Schema was overwritten by another push.");
    if (state === "pending")
      throw new SchemaPushError("SchemaNotReady", "The existing documents are still being checked against the schema.");
  }
  const { tables, indexes } = await readCatalog(db);
  const f = finishCatalog(declared, tables, indexes, namespace, true);
  if (!f) throw new SchemaPushError("SchemaNotReady", "The schema's indexes are still backfilling.");
  for (const i of f.drop) {
    await db.delete(INDEX_TABLE, i._id);
  }
  for (const i of f.enable) await db.patch(INDEX_TABLE, i._id, indexStatePatch(i, { state: "enabled" }));
  for (const i of f.disable)
    await db.patch(INDEX_TABLE, i._id, indexStatePatch(i, { state: "backfilled", staged: true }));
  // Already active (a push of the same schema): Convex's `mark_active` does nothing.
  if (state !== "active") {
    // Convex's `clear_active`: the active schema is kept, `overwritten`.
    for (const old of await db.query(SCHEMAS_TABLE).collect())
      if (schemaStateOf(old) === "active") await markOverwritten(db, old._id as string);
    if (schemaId !== null) {
      await db.patch(SCHEMAS_TABLE, schemaId, { state: { state: "active" } });
      // Convex's `mark_active`: the enforced walk's rows go; the staged ones keep running under this schema.
      await deleteEnforcedValidationsForSchema(db, schemaId);
    }
  }
  return { f, tables };
}

/** A component's schemas (`Engine.componentSchemas`). */
type ComponentSchemas = {
  schema: EngineSchema;
  /** Its document validators, which a write in the namespace is checked against (STUDY-154). */
  validators: Map<string, GenericValidator>;
  activeSchemaId: string | null;
  pendingPush: { id: string; schema: EngineSchema } | null;
};

/** The schema of a namespace no push gave one: no table, so nothing to check. */
const EMPTY_SCHEMA = defineSchema({});

export class SchemaPushError extends Error {
  constructor(
    readonly code: "RaceDetected" | "SchemaNotReady",
    message: string,
  ) {
    super(message);
    this.name = "SchemaPushError";
  }
}

/**
 * Convex's `StagedSchemaWithEnforcedValidatorChanges` (400, STUDY-106 §7.4): the schema stages validators on tables
 * whose enforced validator change needs their documents walked.
 */
export class StagedSchemaError extends Error {
  readonly code = "StagedSchemaWithEnforcedValidatorChanges";
  constructor(readonly tables: string[]) {
    super(
      `Cannot stage validators on tables whose enforced validator change needs their documents walked: ${tables.join(", ")}. Put the whole change in the staged validator instead, so the table is walked once, in the background.`,
    );
    this.name = "StagedSchemaError";
  }
}

/**
 * The bunvex-only global holding each deleted table's database indexes (by tablet, their persistence ids), whose
 * rows the purge removes once document retention passes the deletion (STUDY-195 §1): its `_index` rows go with
 * the deletion, so a start reads them here. A table missing (a store another binary wrote) loses its documents only.
 */
export const DELETED_TABLES_GLOBAL = "bunvex_deleted_tables";
const readDeletedTables = (v: unknown): Record<string, string[]> =>
  v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, string[]>) } : {};
/** The highest timestamp: a read of a row's newest version. */
const MAX_TS = (1n << 63n) - 1n;

/** Drop the backfill checkpoint of a dropped index, if it has one. */

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
export type { TableOutcome } from "./validator-subset.ts";
/** How far a staged validator's validation has got (Convex's `StagedValidatorState`). */
export type StagedValidatorState =
  | { state: "pending"; numDocsValidated: number; totalDocs: number | null }
  | { state: "valid" }
  | { state: "failed"; error: string };
export type TablePrediction = {
  name: string;
  outcome: TableOutcome;
  numDocs: number;
  sizeBytes: number;
  /** The table's staged validation, under the active or an in-progress schema, whichever is further along. */
  staged?: StagedValidatorState;
  /** The active schema's staged validator is still validating, and once valid it would spare this push the walk. */
  canSkipAfterStagedValidation: boolean;
};
/** A staged validation, pending or valid, that the push throws away; `replaced` when it stages another validator. */
export type DiscardedStagedValidator = { tableName: string; state: StagedValidatorState; replaced: boolean };
export type SchemaPrediction = {
  schemaValidation: boolean;
  tables: TablePrediction[];
  indexes: IndexPrediction[];
  discardedStagedValidators: DiscardedStagedValidator[];
};

// Printed by name only: `console.log` of one never shows the engine's state (inspect.ts).
opaqueToInspect(Engine);

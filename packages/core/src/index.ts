// Package @bunvex/core — the engine. See ARCHITECTURE.md for what lives where.
export { IndexBackfillingError, IndexStagedError, type IndexState } from "./catalog.ts";
export {
  Committer,
  CommitterStoppedError,
  type Conflict,
  ConflictError,
  type FlushRetryOptions,
  firstOverlap,
  type Interval,
  type LogEntry,
  logEntryBytes,
  MAX_TRANSACTION_WINDOW_US,
  OutOfRetentionError,
  overlaps,
  WRITE_LOG_HARD_MAX_BYTES,
  WRITE_LOG_MAX_RETENTION_US,
  WRITE_LOG_MIN_RETENTION_US,
  WRITE_LOG_SOFT_MAX_SIZE_BYTES,
  WRITE_RETRY_INITIAL_BACKOFF_MS,
  WRITE_RETRY_MAX_BACKOFF_MS,
  type WriteLogRetention,
} from "./committer.ts";
export { type ExecutionKind, wallClock } from "./determinism.ts";
export {
  type CacheCompanion,
  type Caller,
  Engine,
  INDEX_BACKFILL_DEFAULTS,
  type IndexBackfillOptions,
  OCC_INITIAL_BACKOFF_MS,
  OCC_MAX_BACKOFF_MS,
  OCC_MAX_RETRIES,
  OccError,
  occBackoffMs,
  parseValue,
  type QueryJournal,
  stringifyValue,
  type TxBody,
} from "./engine.ts";
export { Expression, type ExpressionOrValue, type FilterBuilder, filterBuilder } from "./filter.ts";
export { compareKeys, encodeKey, type KeyValue, prefixEnd } from "./keyenc.ts";
export {
  DatabaseTimeoutError,
  type DocWrite,
  hasLease,
  type IndexWrite,
  LAYOUT_VERSION,
  LayoutError,
  type Lease,
  type LeaseAcquire,
  LeaseHeldError,
  LeaseLostError,
  type LogCommit,
  type OpenOptions,
  type Persistence,
  ReadOnlyError,
  type ReadOnlyFlag,
  type ScanDocs,
  UnsureCommitError,
} from "./persistence/index.ts";
export {
  type DeclaredTable,
  type Doc,
  defineSchema,
  defineTable,
  type FieldValue,
  type IndexDef,
  indexKey,
  type SchemaDefinition,
  type TableDef,
  TableDefinition,
} from "./schema.ts";
export {
  SESSION_CLEANUP_CHUNK,
  SESSION_CLEANUP_ROWS_PER_SECOND,
  SESSION_REQUEST_RETENTION_MS,
  type SessionRequestId,
  type SessionRequestOutcome,
} from "./session-requests.ts";
export { IndexRangeBuilder, type PaginationOptions, type PaginationResult, Tx, type TxQuery } from "./tx.ts";

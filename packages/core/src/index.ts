// Package @bunvex/core — the engine. See ARCHITECTURE.md for what lives where.
export {
  Committer,
  CommitterStoppedError,
  type Conflict,
  ConflictError,
  firstOverlap,
  type Interval,
  type LogEntry,
  overlaps,
} from "./committer.ts";
export { type ExecutionKind, wallClock } from "./determinism.ts";
export {
  type CacheCompanion,
  type Caller,
  Engine,
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
  type DocWrite,
  hasLease,
  type IndexWrite,
  type Lease,
  type LeaseAcquire,
  LeaseHeldError,
  LeaseLostError,
  type LogCommit,
  type Persistence,
  type ScanDocs,
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
export { type FormatError, type Publish, type SubResult, Subscriptions } from "./subscriptions.ts";
export { IndexRangeBuilder, type PaginationOptions, type PaginationResult, Tx, type TxQuery } from "./tx.ts";

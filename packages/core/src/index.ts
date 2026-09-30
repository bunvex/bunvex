// Package @bunvex/core — the engine. See ARCHITECTURE.md for what lives where.
export {
  Committer,
  CommitterStoppedError,
  ConflictError,
  type Interval,
  type LogEntry,
  overlaps,
} from "./committer.ts";
export { type ExecutionKind, wallClock } from "./determinism.ts";
export { Engine, parseValue, type QueryJournal, stringifyValue, type TxBody } from "./engine.ts";
export { Expression, type ExpressionOrValue, type FilterBuilder, filterBuilder } from "./filter.ts";
export { compareKeys, encodeKey, type KeyValue, prefixEnd } from "./keyenc.ts";
export type { DocWrite, IndexWrite, Persistence, ScanDocs } from "./persistence/index.ts";
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
export { type Publish, Subscriptions } from "./subscriptions.ts";
export { IndexRangeBuilder, type PaginationOptions, type PaginationResult, Tx, type TxQuery } from "./tx.ts";

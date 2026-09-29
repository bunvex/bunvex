// Package @bunvex/core — the engine. See ARCHITECTURE.md for what lives where.
export { Committer, ConflictError, type Interval, type LogEntry, overlaps } from "./committer.ts";
export { Engine, type TxBody } from "./engine.ts";
export { compareKeys, encodeKey, type KeyValue, prefixEnd } from "./keyenc.ts";
export type { DocWrite, IndexWrite, Persistence, ScanDocs } from "./persistence/index.ts";
export { type Doc, type FieldValue, type IndexDef, indexKey, Schema, type TableDef } from "./schema.ts";
export { type Publish, Subscriptions } from "./subscriptions.ts";
export { IndexRangeBuilder, Tx } from "./tx.ts";

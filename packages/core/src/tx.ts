// A transaction: reads at a snapshot, records its read-set, buffers its writes, and turns them into
// persistence rows (document versions + the index entries that changed).
//
// Read-your-own-writes (as Convex's TransactionIndex does): every write also updates, per index, an
// ordered map of PENDING entries — `key → doc` for the version this transaction wrote, `key → null` for
// an entry it removed (a delete, or a patch that moved the indexed value). A range read merges the
// snapshot with the pending entries of that range, in key order; on an equal key the pending entry wins.

import { MAX_CANDIDATE_REVISIONS, MAX_QUERY_TERMS, tokenize } from "@bunvex/search";
import {
  type CommitTsPlaceholder,
  checkValue,
  commitTsPlaceholder,
  copyValue,
  decodeId,
  encodeId,
  fromJsonValue,
  type GenericValidator,
  isCommitTsPlaceholder,
  isSimpleObject,
  keyBytesLength,
  MAX_COMMIT_TS,
  MAX_VALUE_NESTING,
  rawValueSize,
  TOO_NESTED_MESSAGE,
  toJsonValue,
  type Value,
  v,
  valueNesting,
} from "@bunvex/values";
import { BTree } from "./btree.ts";
import {
  Catalog,
  databaseIndexRows,
  INDEX_TABLE,
  IndexBackfillingError,
  type IndexMeta,
  IndexStagedError,
  planCatalog,
  searchIndexesUnavailable,
  TABLES_TABLE,
  type TableMeta,
  VIRTUAL_TO_SYSTEM_TABLE,
} from "./catalog.ts";
import { type Interval, OutOfRetentionError, type SearchRead } from "./committer.ts";
import { type CursorCodec, type CursorPosition, decodeCursor, encodeCursor, queryFingerprint } from "./cursor.ts";
import { failExecution, monotonicNow, nextUp, outsideExecution, storeCall, wallClock } from "./determinism.ts";
import { engineOwned } from "./engine-owned.ts";
import { type ExpressionOrValue, type FilterBuilder, filterBuilder } from "./filter.ts";
import { readNextIndexId, writeNextIndexId } from "./index-ids.ts";
import { opaqueToInspect } from "./inspect.ts";
import { afterValues, compareKeys, encodeKey, type KeyValue, prefixEnd } from "./keyenc.ts";
import {
  DanglingReferenceError,
  type DocWrite,
  type IndexWrite,
  type Persistence,
  type ScanDocs,
} from "./persistence/index.ts";
import {
  checkOps,
  MAX_QUERY_OPERATORS,
  Pipeline,
  type QueryOp,
  serializeOps,
  TOO_MANY_OPERATORS,
} from "./query-ops.ts";
import {
  checkIdentifier,
  type Doc,
  type IndexDef,
  indexKey,
  indexKeySize,
  indexKeyValues,
  isReservedIndex,
  maintainedIndexes,
  SYSTEM_INDEXES,
  type TableDef,
} from "./schema.ts";
import { filterKey, indexedDocBytes, type SearchIndexes, searchReadIntervals } from "./search-indexes.ts";
import { rememberStagedSize, sizeOfVersion } from "./staged-size.ts";
import { SystemReader, VirtualQuery } from "./system-reader.ts";
import { TableReader, TableWriter } from "./table-scope.ts";
import { TableSummariesUnavailableError } from "./table-summaries.ts";
import type { IndexReadSpans } from "./tracing.ts";
import { inVectorIndex, type VectorIndexes } from "./vector-indexes.ts";

const ANY = v.any();

type Range = { lo: Uint8Array; hi: Uint8Array };
const FULL: Range = { lo: new Uint8Array(0), hi: Uint8Array.from([0xff, 0xff, 0xff, 0xff]) };

type RangeExpr = { op: "eq" | "gt" | "gte" | "lt" | "lte"; field: string; value: KeyValue };

/** `withIndex(name, q => q.eq(…).gt(…))`: records the expressions; `compile` checks them against the index. */
export class IndexRangeBuilder {
  readonly exprs: RangeExpr[] = [];
  eq(field: string, value: KeyValue) {
    this.exprs.push({ op: "eq", field, value });
    return this;
  }
  gt(field: string, value: KeyValue) {
    this.exprs.push({ op: "gt", field, value });
    return this;
  }
  gte(field: string, value: KeyValue) {
    this.exprs.push({ op: "gte", field, value });
    return this;
  }
  lt(field: string, value: KeyValue) {
    this.exprs.push({ op: "lt", field, value });
    return this;
  }
  lte(field: string, value: KeyValue) {
    this.exprs.push({ op: "lte", field, value });
    return this;
  }
}

const COMPARATOR = { eq: "==", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;
const quoted = (f: string) => JSON.stringify(f);
const list = (fs: string[]) => `[${fs.map(quoted).join(", ")}]`;

/**
 * Turn range expressions into a key interval, with Convex's rules and errors (`IndexRange::compile` in
 * crates/common/src/query.rs): equalities on distinct fields, at most one lower and one upper bound, both
 * on the same field, and together a prefix of the index's fields in order (the trailing `_id` included).
 */
export function compileRange(ix: IndexDef, exprs: RangeExpr[]): Range {
  const indexName = `${ix.table}.${ix.name}`;
  const indexed = ix.name === "by_id" ? [] : ix.fields; // the fields Convex lists; `_id` is implicit
  const withId = [...indexed, "_id"];
  const eqs = new Map<string, KeyValue>();
  let ineqField: string | null = null;
  let lower: { v: KeyValue; incl: boolean } | null = null;
  let upper: { v: KeyValue; incl: boolean } | null = null;
  for (const e of exprs) {
    if (e.op === "eq") {
      if (eqs.has(e.field))
        throw new Error(
          `Already defined equality bound in index range. Can't add ${quoted(e.field)} == ${JSON.stringify(e.value)}.`,
        );
      eqs.set(e.field, e.value);
      continue;
    }
    const isUpper = e.op === "lt" || e.op === "lte";
    if ((isUpper ? upper : lower) !== null)
      throw new Error(
        `Already defined ${isUpper ? "upper" : "lower"} bound in index range. Can't add ${quoted(e.field)} ${COMPARATOR[e.op]} ${JSON.stringify(e.value)}.`,
      );
    if (ineqField !== null && ineqField !== e.field)
      throw new Error(
        `Upper and lower bounds in \`range\` can only be applied to a single index field. This query against index ${indexName} attempted to set a range bound on both ${quoted(ineqField)} and ${quoted(e.field)}. Consider using \`filter\` instead.`,
      );
    ineqField = e.field;
    const bound = { v: e.value, incl: e.op === "lte" || e.op === "gte" };
    if (isUpper) upper = bound;
    else lower = bound;
  }
  const rank = new Map(withId.map((f, i) => [f, i]));
  for (const f of [...eqs.keys(), ...(ineqField ? [ineqField] : [])])
    if (!rank.has(f))
      throw new Error(
        `The index range included a comparison with ${quoted(f)}, but ${indexName} with fields ${list(indexed)} doesn't index this field.`,
      );
  const eqFields = [...eqs.keys()].sort((a, b) => rank.get(a)! - rank.get(b)!);
  const used = [...eqFields, ...(ineqField ? [ineqField] : [])];
  used.forEach((f, i) => {
    if (withId[i] !== f)
      throw new Error(
        `Tried to query index ${indexName} but the query didn't use the index fields in order.\nIndex fields: ${list(indexed)}\nQuery fields: ${list(used)}\nFirst incorrect field: ${quoted(f)}`,
      );
  });
  const keyValue = (_f: string, v: KeyValue): KeyValue => v;
  const prefixVals = eqFields.map((f) => keyValue(f, eqs.get(f)!));
  if (prefixVals.length === 0 && !lower && !upper) return FULL;
  const prefix = encodeKey(prefixVals);
  let lo = prefixVals.length ? prefix : FULL.lo;
  let hi = prefixVals.length ? afterValues(prefix) : FULL.hi;
  if (lower) {
    const k = encodeKey([...prefixVals, keyValue(ineqField!, lower.v)]);
    lo = lower.incl ? k : afterValues(k);
  }
  if (upper) {
    const k = encodeKey([...prefixVals, keyValue(ineqField!, upper.v)]);
    hi = upper.incl ? afterValues(k) : k;
  }
  return { lo, hi };
}

/** Convex's document and write limits (crates/common/src/document.rs, knobs.rs). */
export const MAX_USER_SIZE = 1 << 20; // 1 MiB, the size of the whole document (system fields included)
export const MAX_DOCUMENT_NESTING = 16;
export const TRANSACTION_MAX_NUM_USER_WRITES = 16_000;
export const TRANSACTION_MAX_USER_WRITE_SIZE_BYTES = 1 << 24; // 16 MiB

/** A byte count as binary units, as the limit messages print it: "16 MiB", "1.05 MiB", "512 B". */
export function formatBytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let i = 0;
  let x = n;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${i === 0 ? x : Number(x.toFixed(2))} ${units[i]}`;
}

/** Convex's per-transaction read limits (crates/common/src/knobs.rs). System transactions are exempt. */
export const TRANSACTION_MAX_READ_SIZE_ROWS = 32_000;
export const TRANSACTION_MAX_READ_SIZE_BYTES = 1 << 24; // 16 MiB
export const TRANSACTION_MAX_READ_SET_INTERVALS = 4096;
/** Convex's TRANSACTION_MAX_NUM_SCHEDULED and TRANSACTION_MAX_SCHEDULED_TOTAL_ARGUMENT_SIZE_BYTES. */
export const TRANSACTION_MAX_NUM_SCHEDULED = 1000;
export const TRANSACTION_MAX_SCHEDULED_TOTAL_ARGUMENT_SIZE_BYTES = 1 << 24;
export const OVER_LIMIT_HELP =
  "Consider using smaller limits in your queries, paginating your queries, or using indexed queries with a selective index range expressions.";

/**
 * The transaction limit errors Convex tags `ErrorMetadata::pagination_limit` (database/src/reads.rs,
 * writes.rs: too many documents, bytes or reads read; too many writes or bytes written), which `paginate` ends
 * its page at (STUDY-108). Convex hands the tag to no function: an app sees a plain Error with the message,
 * so the mark stays here, out of the error.
 */
const paginationLimits = new WeakSet<Error>();
function paginationLimit(message: string): Error {
  const e = new Error(message);
  paginationLimits.add(e);
  return e;
}
const isPaginationLimit = (e: unknown): boolean => e instanceof Error && paginationLimits.has(e);

type QState = {
  t: TableDef | undefined;
  ix: IndexDef | undefined;
  range: Range;
  desc: boolean;
  orderSet: boolean;
  /** The operators (`filter`, `limit`) in chain order (STUDY-66 §1). */
  ops: QueryOp[];
  closed: boolean;
  iterated: boolean;
  /** A `withSearchIndex` query (STUDY-45): the index and the builder's filters, in order. */
  search?: SearchSpec;
  /**
   * A virtual table's query (`db.system`, STUDY-125): each system document read is mapped to the virtual
   * shape before the operators see it, so filters run on the virtual fields, as Convex's.
   */
  virtual?: (d: Doc) => Doc | Promise<Doc>;
};

type SearchFilter = { type: "Search"; field: string; value: string } | { type: "Eq"; field: string; value: unknown };
type SearchSpec = { name: string; filters: SearchFilter[] };

/** Convex's `SearchQueryScannedTooManyDocumentsError`. */
const SCANNED_TOO_MANY = `Search query scanned too many documents (fetched ${MAX_CANDIDATE_REVISIONS}). Consider using a smaller limit, paginating the query, or using a filter field to limit the number of documents pulled from the search index.`;
/** Convex's MAX_FILTER_CONDITIONS: `eq`s in one search query. */
const MAX_SEARCH_FILTER_CONDITIONS = 8;

/**
 * A query after its first operator (Convex's `QueryImpl`, for its Query and OrderedQuery stages): it has no
 * `withIndex`, `withSearchIndex` or `fullTableScan`, so calling one is the engine's own TypeError, as in Convex.
 */
export type TxQueryChained = {
  order(dir: "asc" | "desc"): TxQueryChained;
  filter(predicate: (q: FilterBuilder) => ExpressionOrValue<boolean>): TxQueryChained;
  /** Convex's `limit(n)` (internal in its published types): at most `n` documents from here on. */
  limit(n: number): TxQueryChained;
  take(n: number): Promise<Doc[]>;
  first(): Promise<Doc | null>;
  unique(): Promise<Doc | null>;
  collect(): Promise<Doc[]>;
  paginate(opts: PaginationOptions): Promise<PaginationResult>;
  [Symbol.asyncIterator](): AsyncIterator<Doc>;
};

/** `db.query(table)` (Convex's `QueryInitializerImpl`): the only stage that picks an index or a scan. */
export type TxQuery = TxQueryChained & {
  withIndex(name: string, range?: (b: IndexRangeBuilder) => IndexRangeBuilder): TxQueryChained;
  withSearchIndex(name: string, filter: (q: SearchFilterBuilder) => SearchFilterBuilder): TxQueryChained;
  fullTableScan(): TxQueryChained;
  /** The number of documents in the table (STUDY-107). Internal, as Convex's: not in the public types. */
  count(): Promise<number>;
};

/** Convex's `PaginationOptions`. */
export type PaginationOptions = {
  numItems: number;
  cursor: string | null;
  endCursor?: string | null;
  id?: number;
  maximumRowsRead?: number;
  maximumBytesRead?: number;
};
/** Convex's `PaginationResult`. */
export type PaginationResult = {
  page: Doc[];
  isDone: boolean;
  continueCursor: string;
  splitCursor: string | null;
  pageStatus: "SplitRecommended" | "SplitRequired" | null;
};

/** A transaction's read and write limits, and its usage against them. */
export type TxLimits = {
  documentsRead: number;
  bytesRead: number;
  documentsWritten: number;
  bytesWritten: number;
  /** Read-set intervals (Convex's `database_queries`). */
  databaseQueries: number;
  functionsScheduled: number;
  scheduledFunctionArgsBytes: number;
};

/** What `Tx.rollback` restores (see `Tx.begin`). */
export type Savepoint = {
  writes: Map<string, { table: TableDef; old: Doc | null; next: Doc | null }>;
  pending: Map<number, BTree<Uint8Array, Doc | null>>;
  createdTables: Tx["createdTables"];
  docsWritten: number;
  bytesWritten: number;
  pendingViolation: { table: string; error: string } | null;
  commitTs: Map<string, Path[]>;
};

/** A field's place in a document: object keys and array positions (STUDY-53). */
type Path = (string | number)[];

/**
 * `value` with each commit timestamp placeholder replaced by the largest int64, and where they were. It is
 * the first walk of a written value, so it checks Convex's nesting limit on it too (STUDY-109): an array or
 * object deeper than `max` throws ``Invalid argument `value` for `db.<method>`: …`` before going further down.
 */
function extractCommitTs(
  value: unknown,
  max: number,
  method: string,
  at: Path = [],
  paths: Path[] = [],
): { value: unknown; paths: Path[] } {
  if (isCommitTsPlaceholder(value)) {
    paths.push(at);
    return { value: MAX_COMMIT_TS, paths };
  }
  if (Array.isArray(value)) {
    if (at.length >= max) throw tooNestedWrite(method);
    const out = value.map((x, i) => extractCommitTs(x, max, method, [...at, i], paths).value);
    return { value: out, paths };
  }
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    if (at.length >= max) throw tooNestedWrite(method);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(value)) out[k] = extractCommitTs(x, max, method, [...at, k], paths).value;
    return { value: out, paths };
  }
  return { value, paths };
}

/** Convex's message for a written value past the nesting limit (`with_argument_error`, the syscall's `value`). */
const tooNestedWrite = (method: string) =>
  new Error(`Invalid argument \`value\` for \`db.${method}\`: ${TOO_NESTED_MESSAGE}`);

/** A copy of `doc` with `by` at each of `paths`. */
function setAt(doc: Doc, paths: Path[], by: unknown): Doc {
  const out = structuredClone(doc) as Record<string | number, unknown>;
  for (const p of paths) {
    let o = out;
    for (let i = 0; i < p.length - 1; i++) o = o[p[i]!] as Record<string | number, unknown>;
    o[p[p.length - 1]!] = by;
  }
  return out as Doc;
}

/** An imported document's `_id` refused (STUDY-42), with Convex's code. */
export class ImportIdError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ImportIdError";
  }
}

export class Tx {
  private readList: Interval[] = [];
  /** Intervals in `readList` that do not count against `databaseQueries` (`uncountedRead`). */
  private uncountedReads = 0;
  /** @internal (ScanReads) Scans that reached documents since their read-set was last brought up to date. */
  readonly unsettled: ScanReads[] = [];
  /** The read-set: the intervals of every read so far, as the committer and the invalidation index see them. */
  get reads(): Interval[] {
    if (this.unsettled.length) {
      for (const s of this.unsettled) s.settle();
      this.unsettled.length = 0;
    }
    return this.readList;
  }
  /** Seals and opens pagination cursors (cursor.ts); set by the engine. */
  cursorCodec: () => CursorCodec = () => {
    throw new Error("pagination cursors need an initialized engine");
  };
  /**
   * Reactive pagination's journal: the end cursor of this query's previous run (a subscription re-run
   * keeps its page boundary), and the one this run ends at.
   */
  prevEndCursor: string | null = null;
  nextEndCursor: string | null = null;
  private paginated = false;
  /**
   * The store's retention window (STUDY-33): every read from the store is checked against it before and
   * after (Convex's optimistic and final `validate_snapshot`), so a read that raced a prune fails too.
   */
  retention: { check(ts: number): void } | null = null;
  /**
   * Its index reads, one span per index (STUDY-131 AD-26): set by the engine when the transaction runs under
   * a traced span, else null and no read looks at the clock.
   */
  indexSpans: IndexReadSpans | null = null;
  /** Documents and bytes read from the snapshot, counted against Convex's limits. */
  private docsRead = 0;
  private bytesRead = 0;
  /**
   * The transaction's read and write ceilings: Convex's limits, lowered for a nested call by its
   * `transactionLimits` (STUDY-41) and restored after it.
   */
  limits: TxLimits = {
    documentsRead: TRANSACTION_MAX_READ_SIZE_ROWS,
    bytesRead: TRANSACTION_MAX_READ_SIZE_BYTES,
    documentsWritten: TRANSACTION_MAX_NUM_USER_WRITES,
    bytesWritten: TRANSACTION_MAX_USER_WRITE_SIZE_BYTES,
    databaseQueries: TRANSACTION_MAX_READ_SET_INTERVALS,
    functionsScheduled: TRANSACTION_MAX_NUM_SCHEDULED,
    scheduledFunctionArgsBytes: TRANSACTION_MAX_SCHEDULED_TOTAL_ARGUMENT_SIZE_BYTES,
  };
  /** Functions scheduled by this transaction and their arguments' bytes (`scheduled-jobs.ts`). */
  scheduledCount = 0;
  scheduledBytes = 0;
  /** The index key bytes the user's reads were metered (STUDY-71), beside their documents' `bytesRead`. */
  private keyBytesRead = 0;
  /** The largest single scheduled function's arguments (Convex's `max_args_size`, a limit warning's). */
  scheduledMaxBytes = 0;

  /**
   * The largest and the most nested document this transaction writes (Convex's `biggest_document_writes`, for
   * the limit warnings, STUDY-76): over its final versions in user tables; none when it writes nothing.
   */
  biggestWrites(): { maxSize: [string, number]; maxNesting: [string, number] } | null {
    let maxSize: [string, number] | null = null;
    let maxNesting: [string, number] | null = null;
    for (const [id, { table, next, measured }] of this.writes) {
      if (!next || table.name.startsWith("_")) continue;
      // Measured when it was written (the write limits' check), else now.
      const size = measured?.size ?? rawValueSize(next as unknown as Value);
      const nesting = measured?.nesting ?? valueNesting(next as unknown as Value);
      if (!maxSize || size > maxSize[1]) maxSize = [id, size];
      if (!maxNesting || nesting > maxNesting[1]) maxNesting = [id, nesting];
    }
    return maxSize && maxNesting ? { maxSize, maxNesting } : null;
  }
  /** The bytes this transaction's text searches were charged (STUDY-71). */
  private textQueryBytes = 0;

  /**
   * One document handed out of a `get`, an index range or a search, as Convex's
   * `ReadSet::record_read_document` (STUDY-71): a user table's document counts its size and one row toward
   * the read limits (checked here, the count growing even when it throws) and the metered egress, plus its
   * index key's bytes when a user-defined index returned it. A system table's is kept apart and never
   * limited (Convex's `system_tx_size`).
   */
  private countEgress(t: TableDef, doc: Doc, ix: IndexDef | null) {
    if (t.name.startsWith("_")) return;
    this.docsRead++;
    this.bytesRead += rawValueSize(doc as unknown as Value);
    if (ix && !isReservedIndex(ix)) this.keyBytesRead += keyBytesLength(indexKeyValues(ix, doc));
    if (this.systemTx) return;
    if (this.docsRead > this.limits.documentsRead)
      throw paginationLimit(
        `Too many documents read in a single function execution (limit: ${this.limits.documentsRead}). ${OVER_LIMIT_HELP}`,
      );
    if (this.bytesRead > this.limits.bytesRead)
      throw paginationLimit(
        `Too many bytes read in a single function execution (limit: ${this.limits.bytesRead} bytes). ${OVER_LIMIT_HELP}`,
      );
  }

  /**
   * The database I/O Convex meters for this transaction (STUDY-71): what it read, and — once it committed —
   * what it wrote, as Convex's `Committer::track_commit`: per written document of a user table one row, the
   * index entries it changed (a delete's too), and the bytes of its new version and of each user-defined
   * index entry it adds (`IndexKey::size`). A delete adds no bytes.
   */
  io(committed: boolean): {
    readBytes: number;
    readDocuments: number;
    writeBytes: number;
    writeDocuments: number;
    writeIndexRows: number;
    textQueryBytes: number;
    textWriteBytes: number;
    vectorWriteBytes: number;
    vectorWriteQueryBytes: number;
  } {
    let writeBytes = 0;
    let textWriteBytes = 0;
    let vectorWriteBytes = 0;
    let vectorWriteQueryBytes = 0;
    let writeDocuments = 0;
    let writeIndexRows = 0;
    if (committed)
      for (const w of this.writes.values()) {
        const { table: t, old, next } = w;
        if (t.name.startsWith("_") || (!old && !next)) continue;
        writeDocuments++;
        for (const ix of maintainedIndexes(t)) {
          const oldKey = writtenKey(w, "old", ix);
          const newKey = writtenKey(w, "next", ix);
          writeIndexRows +=
            oldKey && newKey && compareKeys(oldKey, newKey) === 0 ? 1 : (oldKey ? 1 : 0) + (newKey ? 1 : 0);
          if (next && !isReservedIndex(ix)) writeBytes += indexKeySize(ix, next);
        }
        if (!next) continue;
        const size = sizeOfVersion(next);
        writeBytes += size;
        // Convex's text and vector index write sizes (`track_commit`): the new version's estimated text bytes
        // per text index; per vector index it is in, its vector's 4-byte elements and its id's 33 bytes, and
        // then the document's size once.
        for (const e of this.searchIndexes?.forTablet(t.id) ?? []) textWriteBytes += indexedDocBytes(e.def, next);
        let vectors = 0;
        for (const e of this.vectorIndexes?.forTablet(t.id) ?? [])
          if (inVectorIndex(e.def, next)) vectors += e.def.dimensions * 4 + 33;
        if (vectors > 0) {
          vectorWriteQueryBytes += vectors;
          vectorWriteBytes += size;
        }
      }
    return {
      readBytes: this.bytesRead + this.keyBytesRead,
      readDocuments: this.docsRead,
      writeBytes,
      writeDocuments,
      writeIndexRows,
      textQueryBytes: this.textQueryBytes,
      textWriteBytes,
      vectorWriteBytes,
      vectorWriteQueryBytes,
    };
  }

  /** What has been read, written and scheduled so far, against the limits. */
  get usage(): TxLimits {
    return {
      documentsRead: this.docsRead,
      bytesRead: this.bytesRead,
      documentsWritten: this.docsWritten,
      bytesWritten: this.bytesWritten,
      databaseQueries: this.readList.length - this.uncountedReads,
      functionsScheduled: this.scheduledCount,
      scheduledFunctionArgsBytes: this.scheduledBytes,
    };
  }
  private writes = new Map<
    string,
    {
      table: TableDef;
      old: Doc | null;
      next: Doc | null;
      measured?: { size: number; nesting: number };
      /** The index keys `stage` computed, per index id, for `old` and `next` (null: none); reused at commit. */
      keys?: { old?: Map<number, Uint8Array | null>; next?: Map<number, Uint8Array | null> };
    }
  >();
  /** Per index id: this transaction's pending entries, `key → doc` (written) or `null` (removed). */
  private pending = new Map<number, BTree<Uint8Array, Doc | null>>();
  /**
   * Where each written document holds `db.vars.commitTs` (STUDY-53): stored as the largest int64 until the
   * commit, handed back to the function as the placeholder, replaced by the commit timestamp at commit.
   */
  private commitTs = new Map<string, Path[]>();

  /** Convex's `db.vars` (mutations): `commitTs`, the placeholder of this transaction's commit timestamp. */
  get vars(): { commitTs: CommitTsPlaceholder } | undefined {
    return this.writable ? { commitTs: commitTsPlaceholder } : undefined;
  }

  /** @internal The next `_creationTime` this transaction would hand out (the engine starts the next one past it). */
  get creationCursor(): number {
    return this.nextCreationTime;
  }

  /** Whether a write holds a commit timestamp to resolve at commit. */
  get hasCommitTs() {
    return this.commitTs.size > 0;
  }

  /** A document as the function sees it: its commit timestamps as the placeholder. */
  private handOut<D extends Doc | null>(d: D): D {
    if (!d || !this.commitTs.size) return d;
    const paths = this.commitTs.get(d._id as string);
    return (paths ? setAt(d, paths, commitTsPlaceholder) : d) as D;
  }

  /** The commit: each commit timestamp replaced by `ns` (the commit ts in nanoseconds) in the writes. */
  resolveCommitTs(ns: bigint) {
    for (const [id, paths] of this.commitTs) {
      const w = this.writes.get(id);
      // The rewritten version's keys may change (an index on the commit timestamp): computed again at commit.
      if (w?.next) this.writes.set(id, { ...w, next: setAt(w.next, paths, ns), keys: { old: w.keys?.old } });
    }
    this.commitTs.clear();
  }
  constructor(
    private catalog: Catalog,
    private persistence: Persistence,
    readonly snapshot: number,
    private readonly writable: boolean,
    /** The next `_creationTime` to hand out: the transaction's start time, then strictly increasing. */
    private nextCreationTime: number = wallClock(),
    /** System transactions (the engine's own) may touch `_`-prefixed system tables; app code may not. */
    private readonly systemTx = false,
  ) {
    this.day = Math.floor(nextCreationTime / 86_400_000);
  }
  /** Days since the Unix epoch at the transaction's start: the last two bytes of every id it creates. */
  private readonly day: number;

  private tableDef(name: string) {
    const t = this.findTable(name);
    if (!t) throw new Error(`unknown table ${name}`);
    return t;
  }

  /** Whether the catalog this transaction runs on has table `name` (system code: a table it may write). */
  hasTable(name: string): boolean {
    return this.catalog.tables.has(name);
  }

  /** A table visible to this transaction (the catalog, or one it created), or undefined. */
  private findTable(name: string): TableDef | undefined {
    if (name.startsWith("_") && !this.systemAccess) throw new Error(`System table ${name} is not accessible here.`);
    const t = this.catalog.tables.get(name);
    if (t) this.dependOn(t);
    return t ?? this.createdTables.get(name)?.def;
  }

  private dependedOn = new Set<number>();
  /**
   * Record that this transaction used table `t` as the catalog had it: a read of its `_tables` document, so
   * a commit that replaces or deletes the table (an import's activation, STUDY-42) conflicts with a mutation
   * that wrote it and invalidates a query that read it.
   */
  private dependOn(t: TableDef) {
    if (this.systemTx || t.metaId === undefined || this.dependedOn.has(t.id)) return;
    this.dependedOn.add(t.id);
    const k = encodeKey([t.metaId]);
    this.recordInterval({ index: this.catalog.table(TABLES_TABLE).byId.id, lo: k, hi: prefixEnd(k) });
  }

  /** Tables this transaction created (STUDY-14: a write to an unknown table creates it, as in Convex). */
  readonly createdTables = new Map<
    string,
    { def: TableDef; meta: Omit<TableMeta, "_id">; indexes: Omit<IndexMeta, "_id">[] }
  >();
  private systemDepth = 0;

  /** Who runs this transaction: the server's identity object (opaque here), or null without a token. */
  identity: unknown = null;
  /** The request it runs for (STUDY-44), for `ctx.meta.getRequestMetadata()`. */
  request: import("./engine.ts").CallRequest | null = null;
  /** Whether the body read the identity (Convex's `observe_identity`): its result then depends on the caller. */
  identityObserved = false;
  /** The caller's identity, recording that the result depends on it (`ctx.auth.getUserIdentity()`). */
  readIdentity(): unknown {
    this.identityObserved = true;
    return this.identity;
  }
  private get systemAccess() {
    return this.systemTx || this.systemDepth > 0;
  }

  /**
   * How deeply a written value may nest: Convex's value limit, 64 (STUDY-109). The engine's own records are
   * exempt — a scheduled job keeps its arguments (63 levels) inside its document, which Convex stores as bytes.
   */
  private writtenNesting(): number {
    return this.systemAccess ? Number.POSITIVE_INFINITY : MAX_VALUE_NESTING;
  }

  /**
   * Run `fn` with access to system tables, inside an app transaction: for the engine's own records that
   * must commit with the app's writes (the sync protocol's `_session_requests`). Not for app code.
   */
  async asSystem<T>(fn: () => Promise<T>): Promise<T> {
    this.systemDepth++;
    try {
      return await fn();
    } finally {
      this.systemDepth--;
    }
  }

  /** `asSystem`, for a synchronous call. */
  asSystemSync<T>(fn: () => T): T {
    this.systemDepth++;
    try {
      return fn();
    } finally {
      this.systemDepth--;
    }
  }

  /** Convex's `db.system`: read access to the system tables apps may see (`_scheduled_functions`). */
  get system(): SystemReader {
    return new SystemReader(this);
  }

  /**
   * Convex's `db.table(name)` (STUDY-66 §2): this database scoped to one table — a writer in a mutation, a
   * reader in a query.
   */
  table(name: string): TableReader | TableWriter {
    return this.writable ? new TableWriter(this, name) : new TableReader(this, name);
  }

  /**
   * A read of a table that does not exist yet: nothing, but the read depends on `_tables`, so a cached
   * query or a subscription re-runs when the table is created.
   */
  private readMissingTable() {
    const byCreation = this.catalog.table(TABLES_TABLE).indexes.get("by_creation_time")!;
    this.recordInterval({ index: byCreation.id, lo: FULL.lo, hi: FULL.hi });
  }

  /** Create table `name` in this transaction: the next free Convex number, a fresh tablet, system indexes. */
  private async createTable(name: string): Promise<TableDef> {
    checkIdentifier("table", name);
    if (name.startsWith("_")) throw new Error(`Invalid table name "${name}": names starting with "_" are reserved.`);
    this.systemDepth++;
    try {
      const tables = (await this.query(TABLES_TABLE).collect()) as unknown as TableMeta[];
      const indexes = databaseIndexRows(await this.query(INDEX_TABLE).collect());
      const plan = planCatalog(
        [{ name, indexes: {}, document: ANY }],
        tables,
        indexes,
        true,
        await readNextIndexId(this),
      );
      const meta = plan.insertTables[0];
      let metaId: string | undefined;
      for (const t of plan.insertTables) metaId = await this.insert(TABLES_TABLE, t);
      for (const i of plan.insertIndexes) await this.insert(INDEX_TABLE, i);
      await writeNextIndexId(this, plan.nextIndexId);
      const def = new Catalog().add(
        name,
        meta.tablet,
        meta.number,
        plan.insertIndexes.map((i) => ({ name: i.name, fields: i.fields, id: i.indexId })),
      );
      def.metaId = metaId;
      this.createdTables.set(name, { def, meta, indexes: plan.insertIndexes });
      return def;
    } finally {
      this.systemDepth--;
    }
  }

  /**
   * Called with the commit's ts once it is visible, before any commit listener runs: the engine installs a
   * catalog change there (STUDY-29), so nothing sees the commit with the old catalog.
   */
  onCommitVisible: ((ts: number) => void) | null = null;

  /**
   * @internal (QueryImpl) The index `withIndex(name)` reads, as Convex's `require_enabled`: an enabled
   * index, or Convex's error for one still being built. The read depends on the index's `_index` document,
   * as in Convex, so a cached result or a subscription re-runs when the index is replaced or enabled.
   */
  resolveIndex(t: TableDef, name: string): IndexDef {
    const ix = t.indexes.get(name);
    if (!ix && this.searchIndexes?.get(t, name)) throw new Error(`Index ${t.name}.${name} is not a database index`);
    // An index enabled after this snapshot was still being built at it.
    if (ix && (ix.readyTs ?? 0) <= this.snapshot) {
      if (ix.metaId !== undefined && !(name in SYSTEM_INDEXES)) this.recordIndexMeta(ix);
      return ix;
    }
    const pending = ix ?? t.pending.find((p) => p.name === name);
    if (!pending) throw new Error(`unknown index ${t.name}.${name}`);
    if (pending.metaId !== undefined) this.recordIndexMeta(pending);
    throw pending.staged ? new IndexStagedError(`${t.name}.${name}`) : new IndexBackfillingError(`${t.name}.${name}`);
  }

  private recordIndexMeta(ix: IndexDef) {
    // Built once per index: this is on the path of every indexed query.
    if (!ix.metaRead) {
      const k = encodeKey([ix.metaId!]);
      ix.metaRead = { index: this.catalog.table(INDEX_TABLE).byId.id, lo: k, hi: prefixEnd(k) };
    }
    this.recordInterval(ix.metaRead);
  }

  /**
   * @internal Run `fn` without keeping the reads it records: for values read whole and then recorded one
   * by one (the environment variables, STUDY-37).
   */
  async unrecorded<T>(fn: () => Promise<T>): Promise<T> {
    const n = this.reads.length;
    try {
      return await fn();
    } finally {
      void this.reads; // settle the scans it made
      this.readList.length = n;
    }
  }

  /** @internal (ScanReads) */
  recordInterval(i: Interval) {
    this.readList.push(i);
    if (!this.systemTx && this.readList.length - this.uncountedReads > this.limits.databaseQueries)
      throw paginationLimit(
        `Too many reads in a single function execution (limit: ${this.limits.databaseQueries}). ${OVER_LIMIT_HELP}`,
      );
  }

  /**
   * @internal A read Convex keeps out of a function's limits (its `system_tx_size`, backend-state.ts): `fn`'s
   * reads are neither kept nor counted, and the whole of `index` is recorded (for OCC and subscriptions)
   * without counting against `databaseQueries`.
   */
  async uncountedRead<T>(index: number, fn: () => Promise<T>): Promise<T> {
    const [docs, bytes] = [this.docsRead, this.bytesRead];
    try {
      return await this.unrecorded(fn);
    } finally {
      [this.docsRead, this.bytesRead] = [docs, bytes];
      this.recordUncounted(index);
    }
  }

  /** @internal The whole of `index`, recorded without counting against `databaseQueries` (`uncountedRead`). */
  recordUncounted(index: number) {
    this.readList.push({ index, lo: FULL.lo, hi: FULL.hi });
    this.uncountedReads++;
  }

  /**
   * Check an id argument as Convex does: it must decode, and if it names a known table that table must be
   * `table`. Returns false when it names no known table (Convex's `db.get` then returns null).
   */
  private checkId(table: string, id: string, method: string): boolean {
    let n: number;
    try {
      n = decodeId(id).tableNumber;
    } catch (e) {
      throw new Error(`Invalid argument \`id\` for \`${method}\`: ${(e as Error).message}`);
    }
    const actual = this.catalog.byNumber(n);
    if (!actual) return false;
    if (actual.name !== table)
      throw new Error(
        `Invalid argument \`id\` for \`${method}\`: expected to be an Id<"${table}">, got Id<"${actual.name}"> instead.`,
      );
    return true;
  }

  /** `db.get(table, id)`, or Convex's one-argument `db.get(id)`: the id names its table. */
  async get(tableOrId: string, id?: string): Promise<Doc | null> {
    if (id !== undefined) return this.handOut(await this.read(tableOrId, id, "db.get"));
    const table = this.tableOfIdArg(tableOrId, "db.get");
    // A virtual table's id (`_storage`'s) names a system table apps reach through `db.system` only (Convex's
    // `system_table_guard`).
    const name = table === undefined ? this.publicTableName(decodeId(tableOrId).tableNumber) : undefined;
    if (name !== undefined && !this.systemAccess && VIRTUAL_TO_SYSTEM_TABLE[name] !== undefined)
      throw new Error("System tables can only be accessed with db.system.");
    return table === undefined ? null : this.handOut(await this.read(table, tableOrId, "db.get"));
  }

  /** The table an id argument names (one-argument forms); undefined when it names no known table. */
  private tableOfIdArg(id: unknown, method: string): string | undefined {
    if (typeof id !== "string")
      throw new Error(`Invalid argument \`id\` for \`${method}\`, expected string but got '${typeof id}': ${id}`);
    let n: number;
    try {
      n = decodeId(id).tableNumber;
    } catch (e) {
      throw new Error(`Invalid argument \`id\` for \`${method}\`: ${(e as Error).message}`);
    }
    const name = this.catalog.byNumber(n)?.name;
    if (name?.startsWith("_") && !this.systemAccess) return undefined;
    return name;
  }

  /** Convex's `db.normalizeId(table, s)`: `s` as an id of `table`, or null. */
  normalizeId(table: string, idString: string): string | null {
    if (typeof table !== "string") throw new Error("Invalid argument `table` for `db.normalizeId`");
    if (table.startsWith("_") && !this.systemAccess) return null;
    const t = this.catalog.tables.get(table) ?? this.createdTables.get(table)?.def;
    if (!t || typeof idString !== "string") return null;
    try {
      return decodeId(idString).tableNumber === t.number ? idString : null;
    } catch {
      return null;
    }
  }

  private async read(table: string, id: string, method: string): Promise<Doc | null> {
    const t = this.findTable(table);
    if (!t) {
      this.readMissingTable();
      return null;
    }
    if (!this.checkId(table, id, method)) return null;
    this.countRowsRead(t.name, 1);
    const w = this.writes.get(id);
    // A copy: mutating what `get` returned must not change what this transaction wrote.
    if (w) {
      if (w.next) this.countEgress(t, w.next, null);
      return w.next && structuredClone(w.next);
    }
    const k = encodeKey([id]);
    this.recordInterval({ index: t.byId.id, lo: k, hi: prefixEnd(k) });
    this.retention?.check(this.snapshot);
    const spans = this.indexSpans;
    const start = spans ? monotonicNow() : 0;
    const json = await storeCall(() => this.persistence.get(t.id, id, this.snapshot));
    if (spans) spans.record(t.byId, json ? 1 : 0, start);
    this.retention?.check(this.snapshot);
    if (!json) return null;
    const doc = decodeDoc(json);
    this.countEgress(t, doc, null);
    return doc;
  }

  /**
   * `db.query(table)`: an immutable chain as Convex's (`QueryInitializer` → `Query`): each operator returns
   * a new query and closes the previous one; `withIndex` / `fullTableScan` only on the initializer; `order`
   * at most once; results by `collect` / `take` / `first` / `unique` / `for await` (STUDY-16).
   */
  query(table: string): TxQuery {
    const t = this.findTable(table);
    if (!t) this.readMissingTable(); // a missing table has no rows; the read depends on _tables
    const st: QState = {
      t,
      ix: t?.indexes.get("by_creation_time"),
      range: FULL,
      desc: false,
      orderSet: false,
      ops: [],
      closed: false,
      iterated: false,
    };
    return this.makeQuery(table, st);
  }

  /**
   * @internal `db.system.query(name)` of a virtual table (system-reader.ts, STUDY-125): a query of its system
   * table `system`, each document mapped by `toVirtual` before any operator.
   */
  queryVirtual(name: string, system: string, toVirtual: (d: Doc) => Doc | Promise<Doc>): TxQuery {
    const t = this.asSystemSync(() => this.findTable(system));
    if (!t) this.readMissingTable();
    const st: QState = {
      t,
      ix: t?.indexes.get("by_creation_time"),
      range: FULL,
      desc: false,
      orderSet: false,
      ops: [],
      closed: false,
      iterated: false,
      virtual: toVirtual,
    };
    return this.makeQuery(name, st);
  }

  /** @internal The name an id's table number has for apps (a virtual table's for its system table's), if any. */
  publicTableName(number: number): string | undefined {
    return this.catalog.publicNameOf(number);
  }

  /**
   * @internal (SystemReader) A query of a system table an app may not read (Convex's
   * `StableIndexName::Missing` for a private system table): every read finds nothing and records none, any
   * index name included; its `count()` still counts the table, as Convex's `1.0/count` (STUDY-107).
   */
  privateSystemQuery(table: string): TxQuery {
    const st: QState = {
      t: undefined,
      ix: undefined,
      range: FULL,
      desc: false,
      orderSet: false,
      ops: [],
      closed: false,
      iterated: false,
    };
    return this.makeQuery(table, st);
  }

  /**
   * A query of a table given by its definition, hidden or being deleted too (an import's or the deletion
   * worker's, STUDY-42). System transactions only.
   */
  queryDef(t: TableDef): TxQuery {
    if (!this.systemAccess) throw new Error("queryDef is for system transactions");
    const st: QState = {
      t,
      ix: t.indexes.get("by_creation_time"),
      range: FULL,
      desc: false,
      orderSet: false,
      ops: [],
      closed: false,
      iterated: false,
    };
    return this.makeQuery(t.name, st);
  }

  /**
   * Insert a document as an import does (Convex's `ImportFacingModel::insert`, STUDY-42): its `_id` kept
   * when it has one (it must be an id of this table's number), its `_creationTime` kept when it is a float,
   * else new ones. Into any table given by its definition (an import's hidden table). System only.
   */
  async importInsert(t: TableDef, fields: Record<string, unknown>): Promise<string> {
    if (!this.systemAccess) throw new Error("importInsert is for system transactions");
    if (!this.writable) throw new Error("queries cannot write");
    const { _id, _creationTime, ...rest } = fields;
    let id: string;
    if (_id === undefined) {
      const internal = new Uint8Array(16);
      outsideExecution(() => crypto.getRandomValues(internal.subarray(0, 14)));
      internal[14] = this.day >> 8;
      internal[15] = this.day & 0xff;
      id = encodeId(t.number, internal);
    } else {
      let decoded: { tableNumber: number } | null = null;
      try {
        decoded = typeof _id === "string" ? decodeId(_id) : null;
      } catch {
        decoded = null;
      }
      if (!decoded) throw new ImportIdError("InvalidId", `invalid _id '${String(_id)}'`);
      if (decoded.tableNumber !== t.number)
        throw new ImportIdError(
          "ImportConflict",
          `_id ${_id as string} cannot be imported into '${t.name}' because it came from a different deployment and conflict with preexisting tables in this deployment. Try deleting preexisting tables or importing into an empty deployment.`,
        );
      id = _id as string;
    }
    let creationTime: number;
    if (typeof _creationTime === "number") creationTime = _creationTime;
    else {
      creationTime = this.nextCreationTime;
      this.nextCreationTime = nextUp(creationTime);
    }
    const doc = { ...copyFields(rest, "insert", this.writtenNesting()), _id: id, _creationTime: creationTime };
    checkSystemFields(doc, {}, id, creationTime);
    this.stage(t, id, null, sortFields(doc));
    return id;
  }

  /** Delete a document of a table given by its definition (the deletion worker's). System only. */
  async deleteFrom(t: TableDef, doc: Doc) {
    if (!this.systemAccess) throw new Error("deleteFrom is for system transactions");
    this.stage(t, doc._id as string, this.writes.get(doc._id as string)?.old ?? doc, null);
  }

  private makeQuery(table: string, st: QState): TxQuery {
    return new QueryInitializerImpl(this, table, st);
  }

  /** @internal (QueryImpl) */
  async *iterate(st: QState): AsyncGenerator<Doc> {
    const pipe = new Pipeline(st.ops);
    if (pipe.done) return;
    if (st.search) {
      if (!st.t) return;
      for await (const { doc } of this.searchDocs(st)) {
        if (pipe.offer(doc)) yield doc;
        if (pipe.done) return;
      }
      return;
    }
    if (!st.t || !st.ix) return;
    const reads = new ScanReads(this, st);
    for await (const d of this.stream(st)) {
      reads.reached(d);
      if (pipe.offer(d)) {
        reads.handOut();
        yield this.handOut(d);
      }
      // A full limit: the scan stops at the document that filled it, which ends its read-set.
      if (pipe.done) return;
    }
    reads.exhausted();
  }

  private async snapshotRange(st: QState, lo: Uint8Array, hi: Uint8Array, limit: number): Promise<Doc[]> {
    this.retention?.check(this.snapshot);
    try {
      const out = await this.storeRange(st, lo, hi, limit);
      this.retention?.check(this.snapshot);
      return out;
    } catch (e) {
      // A reference whose document retention pruned during the read is a snapshot too old, not a corrupt store.
      if (e instanceof DanglingReferenceError) this.retention?.check(this.snapshot);
      throw e;
    }
  }

  /** Not async: untraced, the store's promise is returned as is, with no extra turn. */
  private storeRange(st: QState, lo: Uint8Array, hi: Uint8Array, limit: number): Promise<Doc[]> {
    const spans = this.indexSpans;
    return spans ? this.tracedStoreRange(spans, st, lo, hi, limit) : this.storeRangeOf(st, lo, hi, limit);
  }

  private async tracedStoreRange(
    spans: IndexReadSpans,
    st: QState,
    lo: Uint8Array,
    hi: Uint8Array,
    limit: number,
  ): Promise<Doc[]> {
    const start = monotonicNow();
    const out = await this.storeRangeOf(st, lo, hi, limit);
    spans.record(st.ix!, out.length, start);
    return out;
  }

  private async storeRangeOf(st: QState, lo: Uint8Array, hi: Uint8Array, limit: number): Promise<Doc[]> {
    const t = st.t!;
    const ix = st.ix!;
    const p = this.persistence as Persistence & Partial<ScanDocs>;
    if (p.scanDocs) {
      // Remote persistence fuses the index range and the document fetches into one round trip.
      const rows = await storeCall(async () => {
        try {
          return await p.scanDocs!(t.id, ix.id, lo, hi, this.snapshot, limit, st.desc);
        } catch (e) {
          // As snapshotRange does for the engine path: a reference retention pruned during the read is a
          // snapshot too old. Checked here, before storeCall makes the failure a PersistenceReadError.
          if (e instanceof DanglingReferenceError) this.retention?.check(this.snapshot);
          throw e;
        }
      });
      this.countRowsRead(t.name, rows.length);
      return rows.map(decodeDoc);
    }
    const ids = await storeCall(() => this.persistence.scan(ix.id, lo, hi, this.snapshot, limit, st.desc));
    const out: Doc[] = [];
    for (const id of ids) {
      const json = await storeCall(() => this.persistence.get(t.id, id, this.snapshot));
      // A corrupt store: raised, not skipped — a short page would also end the range early (PERSIST-01 C15).
      if (!json) throw new DanglingReferenceError(ix.id, id, this.snapshot, false);
      out.push(decodeDoc(json));
    }
    this.countRowsRead(t.name, out.length);
    return out;
  }

  /** Up to `limit` documents of [lo, hi), this transaction's own writes merged in. */
  private async page(st: QState, lo: Uint8Array, hi: Uint8Array, limit: number): Promise<Doc[]> {
    const ix = st.ix!;
    const pend: [Uint8Array, Doc | null][] = [];
    this.pending.get(ix.id)?.forRange(lo, hi, false, (k, val) => {
      pend.push([k, val]);
    });
    if (pend.length === 0) return this.snapshotRange(st, lo, hi, limit); // the common case: nothing written here
    return this.mergePending(
      ix,
      pend,
      await this.snapshotRange(st, lo, hi, limit + countRemovals(pend)),
      limit,
      st.desc,
    );
  }

  /** Every document of the range in order, fetched in growing pages past the last key seen. */
  private async *stream(st: QState): AsyncGenerator<Doc> {
    let lo = st.range.lo;
    let hi = st.range.hi;
    let n = 64;
    for (;;) {
      const docs = await this.page(st, lo, hi, n);
      for (const d of docs) {
        this.countEgress(st.t!, d, st.ix!);
        if (!st.virtual) yield d;
        else {
          // A mapping that needs no other read (`_storage`'s) is not awaited.
          const m = st.virtual(d);
          yield m instanceof Promise ? await m : m;
        }
      }
      if (docs.length < n) return;
      const last = indexKey(st.ix!, docs[docs.length - 1]);
      if (st.desc) hi = last;
      else {
        lo = new Uint8Array(last.length + 1);
        lo.set(last);
      }
      n = Math.min(n * 2, 1024);
    }
  }

  /** `.paginate()` as Convex's `query_page` (crates/isolate/src/environment/udf/async_syscall.rs). */
  /** @internal (QueryImpl) */
  async paginate(table: string, st: QState, opts: PaginationOptions): Promise<PaginationResult> {
    const n = opts?.numItems;
    if (typeof n !== "number" || !(n > 0))
      throw new Error(`\`options.numItems\` must be a positive number. Received \`${n}\`.`);
    const pageSize = Math.floor(n);
    if (pageSize === 0) throw new Error("Must request at least 1 document while paginating");
    if (pageSize > TRANSACTION_MAX_READ_SIZE_ROWS) throw new Error(`Requested too many items: ${pageSize}`);
    if (opts.maximumRowsRead === 0 || opts.maximumBytesRead === 0)
      throw new Error("maximumRowsRead and maximumBytesRead must be greater than 0");
    if (this.paginated)
      throw new Error(
        "This query or mutation function ran multiple paginated queries. Only a single paginated query is supported in each function.",
      );
    this.paginated = true;
    const pipe = new Pipeline(st.ops);
    const fp = queryFingerprint({
      tablet: st.t?.id ?? 0,
      index: st.ix?.id ?? 0,
      // A search's cursor belongs to its index and filters.
      lo: st.search
        ? new TextEncoder().encode(JSON.stringify(st.search, (_k, x) => (typeof x === "bigint" ? `${x}n` : x)))
        : st.range.lo,
      hi: st.range.hi,
      desc: st.desc,
      ops: serializeOps(st.ops),
    });
    const secret = this.cursorCodec();
    const start = opts.cursor ? decodeCursor(secret, opts.cursor, fp) : null;
    const endStr = opts.endCursor ?? this.prevEndCursor;
    const end = endStr ? decodeCursor(secret, endStr, fp) : null;
    // As Convex's `read_page_from_query`: a limit of 0 never reads, so without an end cursor the page has no
    // cursor at all, and Convex fails with a system error ("Cursor was None").
    if (pipe.done && !end) {
      const e = new QueryCursorError();
      failExecution(e);
      throw e;
    }
    const done = (page: Doc[], pos: CursorPosition, status: PaginationResult["pageStatus"], split: string | null) => {
      const continueCursor = encodeCursor(secret, pos, fp);
      this.nextEndCursor = continueCursor;
      return { page, isDone: pos === "end", continueCursor, splitCursor: split, pageStatus: status };
    };
    if (st.search) {
      // As Convex's search pagination: the search runs again for each page, which keeps what comes after the
      // cursor; never past the candidates it fetches, and no read limits (Convex passes none).
      if (!st.t || start === "end") return done([], "end", null, null);
      const page: Doc[] = [];
      let last: Uint8Array | null = null;
      let exhausted = true;
      for await (const { doc, key } of this.searchDocs(st, start?.after)) {
        if (end && end !== "end" && compareKeys(key, end.after) > 0) break;
        last = key;
        if (pipe.offer(doc)) page.push(doc);
        if ((!end && page.length >= pageSize) || pipe.done) {
          exhausted = false;
          break;
        }
      }
      const status = page.length > (MAX_CANDIDATE_REVISIONS * 3) / 4 ? "SplitRecommended" : null;
      const pos: CursorPosition = end ?? (exhausted ? "end" : { after: last! });
      return done(page, pos, status, null);
    }
    if (!st.t || !st.ix) return done([], "end", null, null);
    if (start === "end") {
      try {
        this.recordInterval({ index: st.ix.id, lo: st.range.lo, hi: st.range.lo });
      } catch (e) {
        // Convex's cursor is already at the end when this read fails: the page ends there, split required.
        if (!isPaginationLimit(e)) throw e;
        return done([], "end", "SplitRequired", null);
      }
      return done([], "end", null, null);
    }
    // The page's range: after the start cursor, up to (and including) the end cursor.
    const succ = (k: Uint8Array) => {
      const x = new Uint8Array(k.length + 1);
      x.set(k);
      return x;
    };
    let lo = st.range.lo;
    let hi = st.range.hi;
    if (!st.desc) {
      if (start) lo = succ(start.after);
      if (end && end !== "end") hi = succ(end.after);
    } else {
      if (start) hi = start.after;
      if (end && end !== "end") lo = end.after;
    }
    const page: Doc[] = [];
    // Every document read, passed by the filters or not: Convex's split cursor is the middle one
    // (`IndexRange::intermediate_cursors`), on any page of more than two.
    const keys: Uint8Array[] = [];
    let rowsRead = 0;
    let bytesRead = 0;
    let last: Uint8Array | null = null;
    let exhausted = true;
    let status: PaginationResult["pageStatus"] = null;
    // As Convex's `IndexRange`: the page's own limits hold without an end cursor only (a pinned page is read to
    // its end), and are checked before the next document is read, which then is not charged.
    const maxRows = end ? undefined : opts.maximumRowsRead;
    const maxBytes = end ? undefined : opts.maximumBytesRead;
    // Convex records the page's read with its first document (or, with none, at the end of the range); at the
    // read-interval limit, that is where the page fails.
    const readsFull = !this.systemTx && this.readList.length - this.uncountedReads >= this.limits.databaseQueries;
    let recorded = false;
    const recordPage = () => {
      recorded = true;
      // The range this page covers (to the end cursor, or to the last key read).
      const readHi = st.desc ? hi : exhausted ? hi : readEndAfter(last ?? lo, hi);
      const readLo = st.desc ? (exhausted ? lo : (last ?? hi)) : lo;
      this.recordInterval({ index: st.ix!.id, lo: readLo, hi: readHi });
    };
    const docs = this.stream({ ...st, range: { lo, hi } });
    try {
      for (;;) {
        if ((maxRows !== undefined && rowsRead >= maxRows) || (maxBytes !== undefined && bytesRead >= maxBytes)) {
          status = "SplitRequired";
          exhausted = false;
          break;
        }
        const next = await docs.next();
        if (next.done) break;
        const d = next.value;
        rowsRead++;
        bytesRead += rawValueSize(d as unknown as Value);
        last = indexKey(st.ix, d);
        keys.push(last);
        if (readsFull && !recorded) {
          exhausted = false;
          recordPage(); // throws: the page ends past its first document, as Convex's
        }
        if (pipe.offer(d)) {
          page.push(this.handOut(d));
          // As Convex: a full page stops without looking further, so its cursor is "after the last
          // document" even if nothing follows (the next page is then empty and done).
          if (!end && page.length >= pageSize) {
            exhausted = false;
            break;
          }
        }
        // A full limit ends the page as Convex's does: not done, the cursor after the last document read.
        if (pipe.done) {
          exhausted = false;
          break;
        }
      }
      if (!recorded) recordPage();
    } catch (e) {
      // A transaction limit hit while reading (Convex's `read_page_from_query`): the page ends at the last
      // document read, split required, instead of failing the function. The document over the limit is
      // charged but not in the page. Before any document, with no cursor to continue from, Convex fails with a
      // system error.
      if (!isPaginationLimit(e)) throw e;
      if (!start && last === null) {
        const err = new QueryCursorError(
          `This should be impossible. Hit pagination limit before setting query cursor: ${(e as Error).message}`,
        );
        failExecution(err);
        throw err;
      }
      status = "SplitRequired";
      exhausted = false;
      if (!recorded && last !== null) recordPage();
    } finally {
      await docs.return(undefined);
    }
    // Convex's soft limits (`IndexRange::is_approaching_data_limit`): 3/4 of the page's limits, or of the
    // transaction's when it sets none, or more than 6144 documents.
    const softRows = Math.min(opts.maximumRowsRead ?? TRANSACTION_MAX_READ_SIZE_ROWS, TRANSACTION_MAX_READ_SIZE_ROWS);
    const softBytes = Math.min(
      opts.maximumBytesRead ?? TRANSACTION_MAX_READ_SIZE_BYTES,
      TRANSACTION_MAX_READ_SIZE_BYTES,
    );
    if (
      status === null &&
      (rowsRead > Math.floor((softRows * 3) / 4) ||
        bytesRead > Math.floor((softBytes * 3) / 4) ||
        page.length > (8192 * 3) / 4)
    )
      status = "SplitRecommended";
    const split = keys.length > 2 ? encodeCursor(secret, { after: keys[Math.floor(keys.length / 2)] }, fp) : null;
    // A page with a pinned end reports that end as its continue cursor even when it stopped early at a read
    // limit (Convex's `end_cursor.or_else(query.cursor())`): the halves of its split then still cover it all.
    // With no document read, the page continues from where it started.
    const pos: CursorPosition = end ?? (exhausted ? "end" : last ? { after: last } : (start ?? "end"));
    return done(page, pos, status, split);
  }

  /** @internal (QueryImpl) The row limit of a `collect()`: one past the read limit raises its error. */
  collectLimit() {
    return this.systemTx ? 1_000_000 : this.limits.documentsRead - this.docsRead + 1;
  }

  /**
   * @internal (QueryImpl) The query's results, its operators applied in order. `take`: `n` is the terminal's
   * limit (`take(n)`, Convex's last operator); else `n` stops the scan early (a `collect()`'s read limit, not
   * an operator of the query).
   */
  async runQuery(st: QState, n: number, take = false): Promise<Doc[]> {
    const pipe = take ? new Pipeline(st.ops, n) : new Pipeline(st.ops);
    const cap = take ? Number.POSITIVE_INFINITY : n;
    if (st.search) return this.searchRun(st, pipe, cap);
    // As Convex's `limit` operator: `take(0)` never pulls from the scan, so it reads nothing.
    if (pipe.done || cap <= 0 || !st.t || !st.ix) return [];
    const reads = new ScanReads(this, st);
    if (pipe.onlyLimits !== null) {
      // Only limits: the smallest is the page size.
      const limit = Math.min(pipe.onlyLimits, cap);
      let docs = await this.page(st, st.range.lo, st.range.hi, limit);
      for (const d of docs) this.countEgress(st.t, d, st.ix);
      if (st.virtual) {
        const mapped = docs.map(st.virtual);
        docs = mapped.some((m) => m instanceof Promise) ? await Promise.all(mapped) : (mapped as Doc[]);
      }
      // A full page stops at its last document (the limit is met, nothing past it was asked for); a short
      // one ran out of the range.
      if (docs.length < limit) reads.exhausted();
      else {
        reads.reached(docs[docs.length - 1]);
        reads.handOut();
      }
      return this.commitTs.size ? docs.map((d) => this.handOut(d)) : docs;
    }
    // With filters: stream until a limit is full (reads count toward the limits as they happen). Documents
    // a filter drops were scanned all the same: they extend the read-set.
    const out: Doc[] = [];
    let stopped = false;
    for await (const d of this.stream(st)) {
      reads.reached(d);
      if (pipe.offer(d)) out.push(d);
      if (pipe.done || out.length >= cap) {
        stopped = true;
        break;
      }
    }
    if (!stopped) reads.exhausted();
    else reads.handOut();
    return this.commitTs.size ? out.map((d) => this.handOut(d)) : out;
  }

  /**
   * Merge a snapshot range with this transaction's pending entries for the same range. The snapshot was
   * fetched with `limit + removals` rows: each pending removal hides at most one of them, so the first
   * `limit` merged rows are exact — any pending entry past the fetched horizon sorts after at least
   * `limit` surviving snapshot rows.
   */
  private mergePending(
    ix: IndexDef,
    pend: [Uint8Array, Doc | null][],
    snapshot: Doc[],
    limit: number,
    desc: boolean,
  ): Doc[] {
    const shadowed = new Set(pend.map(([k]) => Buffer.from(k).toString("hex")));
    const rows: [Uint8Array, Doc][] = [];
    for (const d of snapshot) {
      const k = indexKey(ix, d);
      if (!shadowed.has(Buffer.from(k).toString("hex"))) rows.push([k, d]);
    }
    // The transaction's own versions as copies, as `get` hands them out: a function mutating what a query
    // returned must not change what it wrote (Convex's values cross into the function's runtime).
    for (const [k, d] of pend) if (d) rows.push([k, structuredClone(d)]);
    rows.sort((a, b) => (desc ? compareKeys(b[0], a[0]) : compareKeys(a[0], b[0])));
    return rows.slice(0, limit).map(([, d]) => d);
  }

  private docsWritten = 0;
  private bytesWritten = 0;

  /**
   * Rows read and written per table (Convex's `TableStats`, a function's `tables_touched`): a `get` counts
   * one read whether or not the document exists, a scan one per document it fetched, a write one. A rolled
   * back nested call's stay counted, as Convex's. The app metrics' `table_rate` (STUDY-58).
   */
  readonly tableStats = new Map<string, { rowsRead: number; rowsWritten: number }>();

  private tableStat(table: string) {
    let s = this.tableStats.get(table);
    if (!s) {
      s = { rowsRead: 0, rowsWritten: 0 };
      this.tableStats.set(table, s);
    }
    return s;
  }

  private countRowsRead(table: string, n: number) {
    if (n > 0) this.tableStat(table).rowsRead += n;
  }

  /** @internal Rows a cached read stands for (backend-state.ts): counted as the scan it replaces would be. */
  countRowsReadOf(table: string, n: number) {
    this.countRowsRead(table, n);
  }

  /** Convex's per-document and per-transaction write limits (crates/common/src/document.rs, knobs.rs). */
  private checkWriteLimits(next: Doc | null): { size: number; nesting: number } | undefined {
    let measured: { size: number; nesting: number } | undefined;
    if (next) {
      const v = next as unknown as Value;
      const nesting = valueNesting(v);
      if (nesting > MAX_DOCUMENT_NESTING)
        throw new Error(
          `Document is too nested (nested ${nesting} levels deep > maximum nesting ${MAX_DOCUMENT_NESTING})`,
        );
      const size = rawValueSize(v);
      rememberStagedSize(next, size);
      if (size > MAX_USER_SIZE)
        throw new Error(`Value is too large (${formatBytes(size)} > maximum size ${formatBytes(MAX_USER_SIZE)})`);
      this.bytesWritten += size;
      measured = { size, nesting };
    }
    this.docsWritten++;
    if (this.docsWritten > this.limits.documentsWritten)
      throw paginationLimit(`Too many writes in a single function execution (limit: ${this.limits.documentsWritten})`);
    if (this.bytesWritten > this.limits.bytesWritten)
      throw paginationLimit(
        `Too many bytes written in a single function execution (limit: ${formatBytes(this.limits.bytesWritten)})`,
      );
    return measured;
  }

  /** Validators of the declared tables' documents; set by the engine for mutations (STUDY-14). */
  docValidators: Map<string, GenericValidator> | null = null;
  /**
   * A pushed schema's validators while it is pending (STUDY-35, Convex's `enforce` on a pending schema): a
   * write that does not match is NOT refused — it fails the pending schema once the write commits.
   */
  pendingValidators: Map<string, GenericValidator> | null = null;
  /** The first write this transaction made that the pending schema refuses: its table and message. */
  pendingViolation: { table: string; error: string } | null = null;

  /**
   * The table a number names for the schema's `v.id` checks; an import's, which checks its documents
   * against the tables as they will be once it is activated (Convex's `table_mapping_for_schema`).
   */
  schemaTables: ((n: number) => string | undefined) | null = null;

  private stage(t: TableDef, id: string, old: Doc | null, next: Doc | null) {
    // The versions a write keeps are the engine's own (test mode freezes them: nothing may change them).
    engineOwned(old);
    engineOwned(next);
    this.tableStat(t.name).rowsWritten++;
    if (!this.writable) throw new Error("queries cannot write");
    const measured = t.name.startsWith("_") ? undefined : this.checkWriteLimits(next);
    const dv = next && this.docValidators?.get(t.name);
    if (dv) {
      const msg = checkValue(dv, next as unknown as Value, this.schemaTables ?? ((n) => this.catalog.publicNameOf(n)));
      if (msg)
        throw new Error(
          `Failed to insert or update a document in table "${t.name}" because it does not match the schema: ${msg}`,
        );
    }
    const pv = next && !this.pendingViolation && this.pendingValidators?.get(t.name);
    if (pv) {
      const msg = checkValue(pv, next as unknown as Value, (n) => this.catalog.publicNameOf(n));
      if (msg)
        this.pendingViolation = {
          table: t.name,
          error: `Failed to insert or update a document in table "${t.name}" because it does not match the schema: ${msg}`,
        };
    }
    const prev = this.writes.get(id);
    // The version this transaction currently sees (its own last write, or the snapshot's).
    const current = prev ? prev.next : old;
    // The keys of the first version (the snapshot's) are those of `current` at the first write; kept since.
    const oldKeys = prev ? prev.keys?.old : new Map<number, Uint8Array | null>();
    const nextKeys = new Map<number, Uint8Array | null>();
    for (const ix of maintainedIndexes(t)) {
      const curKey = current ? indexKey(ix, current) : null;
      const newKey = next ? indexKey(ix, next) : null;
      if (!prev) oldKeys!.set(ix.id, curKey);
      nextKeys.set(ix.id, newKey);
      let tree = this.pending.get(ix.id);
      if (!tree) {
        tree = new BTree<Uint8Array, Doc | null>(undefined, compareKeys);
        this.pending.set(ix.id, tree);
      }
      if (curKey && (!newKey || compareKeys(curKey, newKey) !== 0)) tree.set(curKey, null);
      if (newKey && next) tree.set(newKey, next);
    }
    this.writes.set(id, {
      table: t,
      old: prev ? prev.old : old,
      next,
      ...(measured ? { measured } : {}),
      keys: { ...(oldKeys ? { old: oldKeys } : {}), next: nextKeys },
    });
  }

  async insert(table: string, fields: Record<string, unknown>): Promise<string> {
    if (!this.writable) throw new Error("queries cannot write");
    // Validated and copied at the call, as Convex serializes the value: its nesting first, before the table
    // (Convex's `insert` syscall parses `value`, then `table`); an unsupported type throws below, and mutating
    // `fields` afterwards cannot change what is written.
    const x = extractCommitTs(fields, this.writtenNesting(), "insert");
    const t = this.findTable(table) ?? (await this.createTable(table));
    // Convex's generator (STUDY-01): 14 random bytes, then the transaction's day number (big-endian). The
    // randomness is the real CSPRNG, drawn outside the deterministic execution.
    const internal = new Uint8Array(16);
    outsideExecution(() => crypto.getRandomValues(internal.subarray(0, 14)));
    internal[14] = this.day >> 8;
    internal[15] = this.day & 0xff;
    const id = encodeId(t.number, internal);
    // As in Convex: each insert takes the next float, so a transaction's inserts sort in insert order.
    const creationTime = this.nextCreationTime;
    this.nextCreationTime = nextUp(creationTime);
    const doc = {
      ...copyFields(x.value as Record<string, unknown>, "insert", this.writtenNesting()),
      _id: id,
      _creationTime: creationTime,
    };
    checkSystemFields(doc, fields, id, creationTime);
    this.stage(t, id, null, sortFields(doc));
    this.setCommitTs(id, x.paths);
    return id;
  }

  private setCommitTs(id: string, paths: Path[]) {
    if (paths.length) this.commitTs.set(id, paths);
    else this.commitTs.delete(id);
  }

  /** `db.patch(table, id, fields)`, or Convex's `db.patch(id, fields)`. */
  async patch(a: string, b: string | Record<string, unknown>, c?: Record<string, unknown>) {
    if (c === undefined) {
      const table = this.tableOfIdArg(a, "db.patch");
      if (table === undefined) throw new Error(`Update on nonexistent document ID ${a}`);
      return this.patchIn(table, a, b as Record<string, unknown>);
    }
    return this.patchIn(a, b as string, c);
  }

  private async patchIn(table: string, id: string, fields: Record<string, unknown>) {
    // Convex parses the patch before it reads the document. Each field's value is a value of its own, so the
    // patch object may be one level deeper than the limit.
    const x = extractCommitTs(fields, this.writtenNesting() + 1, "patch");
    const t = this.findTable(table);
    const cur = await this.read(table, id, "db.patch");
    if (!cur || !t) throw new Error(`Update on nonexistent document ID ${id}`);
    const old = this.writes.get(id)?.old ?? cur;
    // Convex's shallow merge: a field set to `undefined` is removed.
    const next: Record<string, unknown> = { ...cur };
    for (const [k, v] of Object.entries(fields)) if (v === undefined) delete next[k];
    Object.assign(next, copyFields(x.value as Record<string, unknown>, "patch", this.writtenNesting() + 1));
    checkSystemFields(next, fields, id, cur._creationTime);
    this.stage(t, id, old, sortFields({ ...next, _id: id, _creationTime: cur._creationTime } as Doc));
    // A placeholder in a field the patch leaves alone stays (Convex merges into the pending body).
    const kept = (this.commitTs.get(id) ?? []).filter((p) => !(String(p[0]) in fields));
    this.setCommitTs(id, [...kept, ...x.paths]);
  }

  /** Convex's `db.replace(table, id, value)` or `db.replace(id, value)`: every non-system field is replaced. */
  async replace(a: string, b: string | Record<string, unknown>, c?: Record<string, unknown>) {
    if (c === undefined) {
      const table = this.tableOfIdArg(a, "db.replace");
      if (table === undefined) throw new Error(`Replace on nonexistent document ID ${a}`);
      return this.replaceIn(table, a, b as Record<string, unknown>);
    }
    return this.replaceIn(a, b as string, c);
  }

  private async replaceIn(table: string, id: string, value: Record<string, unknown>) {
    const x = extractCommitTs(value, this.writtenNesting(), "replace"); // before the read, as in Convex
    const t = this.findTable(table);
    const cur = await this.read(table, id, "db.replace");
    if (!cur || !t) throw new Error(`Replace on nonexistent document ID ${id}`);
    const old = this.writes.get(id)?.old ?? cur;
    const next: Record<string, unknown> = {
      ...copyFields(x.value as Record<string, unknown>, "replace", this.writtenNesting()),
      _id: id,
      _creationTime: cur._creationTime,
    };
    checkSystemFields(next, value, id, cur._creationTime);
    this.stage(t, id, old, sortFields(next));
    this.setCommitTs(id, x.paths);
  }

  /** `db.delete(table, id)`, or Convex's `db.delete(id)`. */
  async delete(a: string, b?: string) {
    if (b === undefined) {
      const table = this.tableOfIdArg(a, "db.delete");
      if (table === undefined) throw new Error(`Delete on nonexistent document ID ${a}`);
      return this.deleteIn(table, a);
    }
    return this.deleteIn(a, b);
  }

  private async deleteIn(table: string, id: string) {
    const t = this.findTable(table);
    const cur = await this.read(table, id, "db.delete");
    if (!cur || !t) throw new Error(`Delete on nonexistent document ID ${id}`);
    this.stage(t, id, this.writes.get(id)?.old ?? cur, null);
    this.commitTs.delete(id);
  }

  /**
   * A savepoint (Convex's `begin_subtransaction`, STUDY-41): the writes, each index's pending entries (a
   * copy-on-write clone), the tables created and the write counts. Reads are never rolled back.
   */
  begin(): Savepoint {
    const pending = new Map<number, BTree<Uint8Array, Doc | null>>();
    for (const [ix, tree] of this.pending) pending.set(ix, tree.clone());
    return {
      writes: new Map(this.writes),
      pending,
      createdTables: new Map(this.createdTables) as Tx["createdTables"],
      docsWritten: this.docsWritten,
      bytesWritten: this.bytesWritten,
      pendingViolation: this.pendingViolation,
      commitTs: new Map(this.commitTs),
    };
  }

  /** Undo every write since `sp` (a nested mutation that failed). */
  rollback(sp: Savepoint) {
    this.writes = sp.writes;
    this.pending = sp.pending;
    this.createdTables.clear();
    for (const [k, v] of sp.createdTables) this.createdTables.set(k, v);
    this.docsWritten = sp.docsWritten;
    this.bytesWritten = sp.bytesWritten;
    this.pendingViolation = sp.pendingViolation;
    this.commitTs = sp.commitTs;
  }

  /** The writes as persistence rows: the new version of each doc and the index entries that changed. */
  toWrites(): { docs: DocWrite[]; idx: IndexWrite[] } {
    const docs: DocWrite[] = [];
    const idx: IndexWrite[] = [];
    for (const [id, w] of this.writes) {
      docs.push({ table: w.table.id, id, json: w.next ? encodeDoc(w.next) : null });
      for (const ix of maintainedIndexes(w.table)) {
        const oldK = writtenKey(w, "old", ix);
        const newK = writtenKey(w, "next", ix);
        if (oldK && newK && compareKeys(oldK, newK) === 0) {
          // The key did not move; the entry is rewritten so its version (and the write log) reflect
          // the change — a query on this index must see the new document version.
          idx.push({ index: ix.id, key: newK, id });
          continue;
        }
        if (oldK) idx.push({ index: ix.id, key: oldK, id: null });
        if (newK) idx.push({ index: ix.id, key: newK, id });
      }
    }
    return { docs, idx };
  }

  get hasWrites() {
    return this.writes.size > 0;
  }

  /** The engine's search indexes (STUDY-45), for `withSearchIndex`. */
  searchIndexes: SearchIndexes | null = null;
  /** The vector indexes, for the bytes a write adds to them (STUDY-71). */
  vectorIndexes: VectorIndexes | null = null;
  /** A table's document count at a snapshot, from the table summaries (STUDY-52 PR 2); set by the engine. */
  tableCount: ((tablet: number, snapshot: number) => number) | null = null;

  /**
   * The number of documents of `table` (Convex's internal `count()`: `db.query(table).count()` and its
   * `tableSize` system functions, STUDY-107): the summaries' count at this transaction's snapshot with its own
   * inserts and deletes. The read covers the whole table (not its documents: no read limit is charged), so a
   * cached query or a subscription re-runs when it changes. A system table needs system access.
   */
  /**
   * The system tables the catalog has, by name, `_tables` and `_index` included (they have no `_tables` row):
   * for the system-table browser (STUDY-131 AD-24). System access only.
   */
  systemTableNames(): string[] {
    if (!this.systemAccess) throw new Error("systemTableNames is for system transactions");
    return [...this.catalog.tables.keys()].filter((n) => n.startsWith("_")).sort();
  }

  async countTable(table: string): Promise<number> {
    const t = this.findTable(table);
    if (!t) {
      this.readMissingTable();
      return 0;
    }
    const ix = t.indexes.get("by_creation_time")!;
    this.recordInterval({ index: ix.id, lo: FULL.lo, hi: FULL.hi });
    let n = 0;
    try {
      n = this.tableCount ? this.tableCount(t.id, this.snapshot) : 0;
    } catch (e) {
      // The summaries are still being built (Convex's bootstrapping error), or the snapshot is older than the
      // write log keeps: system errors, which the function cannot catch.
      if (e instanceof TableSummariesUnavailableError || e instanceof OutOfRetentionError) failExecution(e);
      throw e;
    }
    for (const w of this.writes.values()) if (w.table.id === t.id) n += (w.next ? 1 : 0) - (w.old ? 1 : 0);
    return n;
  }

  /** @internal (Engine) The tables this transaction wrote, each once. */
  writtenTables(): TableDef[] {
    const out: TableDef[] = [];
    for (const w of this.writes.values()) if (!out.includes(w.table)) out.push(w.table);
    return out;
  }

  /** @internal (Engine) The documents this transaction wrote, before and after, for the search indexes. */
  writtenDocs(): { table: TableDef; id: string; old: Doc | null; next: Doc | null }[] {
    return [...this.writes].map(([id, w]) => ({ table: w.table, id, old: w.old, next: w.next }));
  }

  /**
   * A mutation's searches (STUDY-45 PR 3), checked at commit by Convex's OCC rule (every filter and one term
   * of a version written since the snapshot). A query records them as read-set intervals instead.
   */
  readonly searchReads: SearchRead[] = [];

  /**
   * The ranked ids of a search (Convex's `SearchQuery`): Convex's checks of the index and the filters, then
   * the index as of this snapshot with this transaction's own writes.
   */
  private searchHits(st: QState) {
    const t = st.t!;
    const spec = st.search!;
    const label = `${t.name}.${spec.name}`;
    const e = this.searchIndexes?.get(t, spec.name);
    if (!e) {
      if (t.indexes.has(spec.name) || t.pending.some((p) => p.name === spec.name))
        throw new Error(`Index ${label} is not a search index`);
      throw new Error(`Index ${label} not found.`);
    }
    // An empty search string finds nothing, whatever the index's state (Convex's `Search::is_empty`, checked
    // before the index is): no read, no charge.
    const searchFilter = spec.filters.find((f) => f.type === "Search");
    if (searchFilter?.value === "") return { hits: [], full: false };
    if (e.staged) throw new IndexStagedError(label);
    if (!e.ready) {
      if (!e.bootstrapping) throw new IndexBackfillingError(label);
      // Rebuilding after a start (STUDY-79): a search with no terms still finds nothing (Convex skips empty
      // compiled queries before its bootstrapping check); any other is Convex's system error, which the
      // function cannot catch.
      if (searchFilter && tokenize(searchFilter.value).length === 0) return { hits: [], full: false };
      const unavailable = searchIndexesUnavailable();
      failExecution(unavailable);
      throw unavailable;
    }
    let text: string | undefined;
    const eqs: [string, string][] = [];
    for (const f of spec.filters) {
      if (f.type === "Search") {
        if (f.field !== e.def.searchField)
          throw new Error(
            `Search query against ${label} contains a search filter against "${f.field}", which doesn't match the indexed \`searchField\` "${e.def.searchField}".`,
          );
        if (text !== undefined)
          throw new Error(
            `Search query against ${label} contains multiple search filters against "${f.field}". Only one is allowed.`,
          );
        text = f.value;
      } else {
        if (!e.def.filterFields.includes(f.field))
          throw new Error(
            `Search query against ${label} contains an equality filter on "${f.field}" but that field isn't indexed for filtering in \`filterFields\`.`,
          );
        eqs.push([f.field, filterKey(f.value)]);
      }
    }
    if (text === undefined)
      throw new Error(
        `Search query against ${label} does not contain any search filters. You must include a search filter like \`q.search(""${e.def.searchField}"", searchText)\`.`,
      );
    if (eqs.length > MAX_SEARCH_FILTER_CONDITIONS)
      throw new Error(
        `Search query against ${label} has too many filter conditions. Max: ${MAX_SEARCH_FILTER_CONDITIONS} Actual: ${eqs.length}`,
      );
    const tokens = tokenize(text).slice(0, MAX_QUERY_TERMS);
    // The read-set (Convex's `QueryReads`): each query term — the last also as a prefix — and each filter.
    const terms = tokens.map((term, i) => ({ term, prefix: i === tokens.length - 1 }));
    if (this.writable) this.searchReads.push({ index: e.readIndex, terms, filters: eqs });
    else for (const i of searchReadIntervals(e.readIndex, terms, eqs)) this.recordInterval(i);
    const pending = new Map<string, Doc | null>();
    for (const [id, w] of this.writes) if (w.table.id === t.id) pending.set(id, w.next);
    // Convex charges a search its whole index's bytes (DV-317: bunvex's indexed bytes for its segments');
    // an empty search string, nothing.
    if (text !== "" && !t.name.startsWith("_")) this.textQueryBytes += e.index.indexedBytes;
    const hits = this.searchIndexes!.search(e, { tokens, prefixLast: true, filters: eqs }, this.snapshot, pending);
    return { hits, full: hits.length >= MAX_CANDIDATE_REVISIONS };
  }

  /** A search's documents in relevance order; reading past the candidates Convex fetches is an error. */
  private async *searchDocs(st: QState, after?: Uint8Array): AsyncGenerator<{ doc: Doc; key: Uint8Array }> {
    const { hits, full } = this.searchHits(st);
    for (const h of hits) {
      const key = searchKey(h);
      if (after && compareKeys(key, after) <= 0) continue;
      const doc = await this.read(st.t!.name, h.id, "withSearchIndex");
      if (doc) yield { doc, key };
    }
    if (full) throw new Error(SCANNED_TOO_MANY);
  }

  private async searchRun(st: QState, pipe: Pipeline, cap: number): Promise<Doc[]> {
    const out: Doc[] = [];
    if (pipe.done || cap <= 0 || !st.t) return out;
    for await (const { doc } of this.searchDocs(st)) {
      if (pipe.offer(doc)) out.push(doc);
      if (pipe.done || out.length >= cap) break;
    }
    return out;
  }
}

/**
 * A search result's position, as Convex's search cursor `(-score, -_creationTime, id)`: byte order is the
 * results' order (the id's bytes complemented, so ties keep the results' newest-id-first order).
 */
function searchKey(h: { id: string; score: number; creationTime: number }): Uint8Array {
  const internal = decodeId(h.id).internalId.map((b) => 255 - b);
  return encodeKey([-h.score, -h.creationTime, internal.buffer as ArrayBuffer]);
}

/**
 * The read-set of one index range as it is consumed, as Convex's `IndexRange` (STUDY-06 §9): each document the
 * scan reaches — filtered out or not — extends the recorded interval from the range's start (in scan order) to
 * that document's key, inclusive; a scan that runs out records the whole range. A scan that stops early
 * (`take(n)`, `first()`, `unique()`, a `for await` that breaks) therefore leaves writes past its last key out
 * of the read-set.
 *
 * The interval is recorded when the scan reaches its first document (nothing for a scan that reads nothing,
 * e.g. `take(0)`), then kept up to date in place. Encoding a key per document would double the cost of a
 * long `for await` or a filtered scan, so only the last document reached is kept, and its key is encoded
 * when the transaction's read-set is next looked at (`Tx.reads`). The app may change a document it was
 * given, and the key must be the stored one: `handOut` keeps the key's values before it gets it.
 */
class ScanReads {
  private iv: Interval | null = null;
  /** The last document reached, while the app does not hold it. */
  private last: Doc | null = null;
  /** Or: the key values of the last document reached, taken when it was handed to the app. */
  private vals: KeyValue[] | null = null;
  constructor(
    private readonly tx: Tx,
    private readonly st: QState,
  ) {}

  /** The scan reached `doc` (in its order). */
  reached(doc: Doc) {
    if (!this.iv) this.open();
    if (this.last === null && this.vals === null) this.tx.unsettled.push(this);
    this.last = doc;
    this.vals = null;
  }

  /**
   * The app is about to get the last document reached, and may change the object: keep its key values now.
   * Strings, numbers, booleans and null cannot change; an object, array or bytes value could, so a key
   * holding one is computed right away.
   */
  handOut() {
    const d = this.last;
    if (d === null) return;
    const vals = indexKeyValues(this.st.ix!, d);
    for (const v of vals)
      if (v !== null && typeof v === "object") {
        this.settle();
        return;
      }
    this.vals = vals;
    this.last = null;
  }

  /** The scan ran out of its range. */
  exhausted() {
    if (!this.iv) this.open();
    const iv = this.iv!;
    iv.lo = this.st.range.lo;
    iv.hi = this.st.range.hi;
    this.last = null;
    this.vals = null;
  }

  /** @internal (Tx.reads) End the interval at the last document reached. */
  settle() {
    let key: Uint8Array;
    if (this.vals !== null) key = encodeKey(this.vals);
    else if (this.last !== null) key = indexKey(this.st.ix!, this.last);
    else return;
    this.last = null;
    this.vals = null;
    const iv = this.iv!;
    if (this.st.desc) {
      iv.lo = key;
      iv.hi = this.st.range.hi;
    } else {
      iv.lo = this.st.range.lo;
      iv.hi = readEndAfter(key, this.st.range.hi);
    }
  }

  private open() {
    // The whole range until settled; never seen as such (`Tx.reads` settles first).
    this.iv = { index: this.st.ix!.id, lo: this.st.range.lo, hi: this.st.range.hi };
    this.tx.recordInterval(this.iv);
  }
}

/**
 * Where an ascending scan's read-set ends once it reached `key`, as Convex's `Interval::split_after`: just
 * past every key starting with `key` (Convex's `BinaryKey::increment`; an index key ends with the document id,
 * so that is just past `key` itself), but never past the range's own end `hi`.
 */
export function readEndAfter(key: Uint8Array, hi: Uint8Array): Uint8Array {
  const end = prefixEnd(key);
  return compareKeys(end, hi) < 0 ? end : hi;
}

function countRemovals(pend: [Uint8Array, Doc | null][]) {
  let n = 0;
  for (const [, d] of pend) if (d === null) n++;
  return n;
}

/**
 * A validated deep copy of a write's fields (Convex serializes values at the call), nested at most
 * `maxNesting` levels.
 */
function copyFields(fields: Record<string, unknown>, method: string, maxNesting: number): Record<string, unknown> {
  if (!isSimpleObject(fields))
    throw new TypeError(`Invalid argument \`value\` for \`db.${method}\`: expected an object`);
  return copyValue(fields as Value, maxNesting) as Record<string, unknown>;
}

/**
 * As Convex's `ResolvedDocument::new`: `_id` / `_creationTime` in a written value must equal the document's,
 * and no other top-level field may start with an underscore.
 */
function checkSystemFields(
  doc: Record<string, unknown>,
  fields: Record<string, unknown>,
  id: string,
  creationTime: number,
) {
  if ("_id" in fields && fields._id !== undefined && fields._id !== id)
    throw new Error(`Provided document ID "${id}" doesn't match '_id' field ${JSON.stringify(fields._id)}`);
  if ("_creationTime" in fields && fields._creationTime !== undefined && fields._creationTime !== creationTime)
    throw new Error(
      `Provided creation time ${creationTime} doesn't match '_creationTime' field in ${JSON.stringify(fields)}`,
    );
  for (const k of Object.keys(doc))
    if (k.startsWith("_") && k !== "_id" && k !== "_creationTime")
      throw new Error(`Field '${k}' starts with an underscore, which is only allowed for system fields like '_id'`);
}

/** Documents keep their fields sorted by name, as Convex objects do. */
function sortFields(doc: Record<string, unknown>): Doc {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(doc).sort()) out[k] = doc[k];
  return out as Doc;
}

/** A write's key on `ix` for `old` or `next`, as `stage` computed it, else computed now. */
function writtenKey(
  w: {
    old: Doc | null;
    next: Doc | null;
    keys?: { old?: Map<number, Uint8Array | null>; next?: Map<number, Uint8Array | null> };
  },
  which: "old" | "next",
  ix: IndexDef,
): Uint8Array | null {
  const doc = w[which];
  if (!doc) return null;
  const known = w.keys?.[which];
  if (known?.has(ix.id)) return known.get(ix.id)!;
  return indexKey(ix, doc);
}

/** A document as stored (Convex's JSON form: $integer, $float, $bytes). */
export const encodeDoc = (doc: Doc): string => JSON.stringify(toJsonValue(doc as unknown as Value));
export const decodeDoc = (json: string): Doc => fromJsonValue(JSON.parse(json)) as unknown as Doc;

const reusedError = () => new Error("This query has been chained with another operator and can't be reused.");

/**
 * Convex's "Cursor was None" (crates/isolate/src/environment/udf/async_syscall.rs, `read_page_from_query`):
 * `paginate` over a `limit(0)` never reads, so it has no cursor to return; nor does a first page that hits a
 * transaction limit before its first document (STUDY-108). Convex raises both without error metadata, a
 * system error: the client gets the internal-error message, and the function cannot catch it.
 */
export class QueryCursorError extends Error {
  constructor(message = "Cursor was None. This should be impossible if `.next` was called on the query.") {
    super(message);
    this.name = "QueryCursorError";
  }
}

/**
 * `db.query(table)` — one object per link of the chain, with its methods on the prototype (no closures
 * allocated per query: this is the hot path of every read).
 */
/**
 * `q` of `withSearchIndex(name, q => q.search(field, text).eq(field, value)…)`, as Convex's
 * `SearchFilterBuilderImpl`: each builder is used once; `eq(field, undefined)` matches a missing field.
 */
export class SearchFilterBuilder {
  private used = false;
  constructor(private readonly parts: SearchFilter[]) {}

  private next(part: SearchFilter): SearchFilterBuilder {
    if (this.used)
      throw new Error(
        "SearchFilterBuilder has already been used! Chain your method calls like `q => q.search(...).eq(...)`.",
      );
    this.used = true;
    return new SearchFilterBuilder([...this.parts, part]);
  }

  search(fieldName: string, query: string): SearchFilterBuilder {
    if (fieldName === undefined) throw new TypeError("Must provide arg 1 `fieldName` to `search`");
    if (query === undefined) throw new TypeError("Must provide arg 2 `query` to `search`");
    return this.next({ type: "Search", field: fieldName, value: query });
  }

  eq(fieldName: string, value: unknown): SearchFilterBuilder {
    if (fieldName === undefined) throw new TypeError("Must provide arg 1 `fieldName` to `eq`");
    // Convex's own label for a missing value (its check names `search`); an explicit undefined is allowed.
    if (arguments.length !== 2) throw new TypeError("Must provide arg 2 `value` to `search`");
    return this.next({
      type: "Eq",
      field: fieldName,
      value: value === undefined ? undefined : copyValue(value as Value),
    });
  }

  /** @internal */
  filters(): SearchFilter[] {
    return this.parts;
  }
}

/**
 * Whether `value` is a query object (`db.query(…)` and its operators, `db.system.query(…)`): what Convex's
 * `validateReturnValue` refuses as a function's result (STUDY-66 §3).
 */
export function isQueryObject(value: unknown): boolean {
  return value instanceof QueryImpl || value instanceof VirtualQuery;
}

class QueryImpl implements TxQueryChained {
  constructor(
    protected readonly tx: Tx,
    protected readonly table: string,
    protected readonly st: QState,
  ) {}

  protected chain(change: (next: QState) => void): TxQueryChained {
    const st = this.st;
    if (st.iterated) throw new Error("A query can only be chained once and can't be chained after iteration begins.");
    if (st.closed) throw reusedError();
    st.closed = true;
    const next: QState = { ...st, ops: [...st.ops], closed: false, iterated: false };
    change(next);
    return new QueryImpl(this.tx, this.table, next);
  }

  /**
   * Run the query to its end: `take(n)` (and `first`, `unique`) adds its limit as Convex's (`limit(n).collect()`),
   * then the start's checks (Convex's backend parses the query here).
   */
  private results(take: number | null): Promise<Doc[]> {
    if (this.st.closed || this.st.iterated) throw reusedError();
    this.st.closed = true;
    try {
      checkOps(this.st.ops, "queryStream", take !== null);
    } catch (e) {
      return Promise.reject(e);
    }
    return take === null ? this.tx.runQuery(this.st, this.tx.collectLimit()) : this.tx.runQuery(this.st, take, true);
  }

  order(dir: "asc" | "desc"): TxQueryChained {
    if (this.st.search)
      throw new Error("Search queries must always be in relevance order. Can not set order manually.");
    if (this.st.orderSet) throw new Error("Queries may only specify order at most once");
    return this.chain((n) => {
      n.desc = dir === "desc";
      n.orderSet = true;
    });
  }

  filter(predicate: (q: FilterBuilder) => ExpressionOrValue<boolean>): TxQueryChained {
    if (typeof predicate !== "function") throw new TypeError("Must provide arg 1 `predicate` to `filter`");
    return this.chain((n) => {
      // Convex checks on the client, in `filter` only; `limit` and the start count too (`checkOps`).
      if (n.ops.length >= MAX_QUERY_OPERATORS) throw new Error(TOO_MANY_OPERATORS);
      n.ops.push({ filter: predicate(filterBuilder) });
    });
  }

  /** Convex's `limit(n)`: `n` is checked when the query starts, as its backend does. */
  limit(n: number): TxQueryChained {
    if (n === undefined) throw new TypeError("Must provide arg 1 `n` to `limit`");
    return this.chain((next) => {
      next.ops.push({ limit: n });
    });
  }

  take(n: number): Promise<Doc[]> {
    if (n === undefined) throw new TypeError("Must provide arg 1 `n` to `take`");
    if (!Number.isInteger(n) || n < 0) throw new TypeError("Arg 1 `n` to `take` must be a non-negative integer");
    return this.results(n);
  }

  async first(): Promise<Doc | null> {
    return (await this.results(1))[0] ?? null;
  }

  async unique(): Promise<Doc | null> {
    const two = await this.results(2);
    if (two.length > 1)
      throw new Error(
        `unique() query returned more than one result from table ${this.table}:\n [${two[0]._id}, ${two[1]._id}, ...]`,
      );
    return two[0] ?? null;
  }

  collect(): Promise<Doc[]> {
    // No cap: everything in the range, bounded only by the transaction's read limit (one row past it is
    // enough to raise Convex's error).
    return this.results(null);
  }

  paginate(opts: PaginationOptions): Promise<PaginationResult> {
    if (this.st.closed || this.st.iterated) throw reusedError();
    this.st.closed = true;
    return (async () => {
      checkOps(this.st.ops, "queryPage");
      return this.tx.paginate(this.table, this.st, opts);
    })();
  }

  [Symbol.asyncIterator](): AsyncIterator<Doc> {
    if (this.st.iterated) throw new Error("Iteration can only begin on a query once.");
    if (this.st.closed) throw reusedError();
    this.st.iterated = true;
    // Convex starts the stream here, synchronously: its checks throw from this call.
    checkOps(this.st.ops, "queryStream");
    return this.tx.iterate(this.st);
  }
}

/**
 * `db.query(table)`, as Convex's `QueryInitializerImpl`: the index or scan is picked here, before any other
 * operator. Each operator returns a plain `QueryImpl`, which has none of these methods.
 */
class QueryInitializerImpl extends QueryImpl implements TxQuery {
  withIndex(name: string, f?: (b: IndexRangeBuilder) => IndexRangeBuilder): TxQueryChained {
    const t = this.st.t;
    return this.chain((n) => {
      if (!t) return;
      const found = this.tx.resolveIndex(t, name);
      n.ix = found;
      n.range = f ? compileRange(found, f(new IndexRangeBuilder()).exprs) : FULL;
    });
  }

  /** Convex's `withSearchIndex`: results in relevance order (STUDY-45). */
  withSearchIndex(name: string, f: (q: SearchFilterBuilder) => SearchFilterBuilder): TxQueryChained {
    if (typeof f !== "function") throw new TypeError("Must provide arg 2 `filter` to `withSearchIndex`");
    const filters = (f(new SearchFilterBuilder([])) as SearchFilterBuilder).filters();
    return this.chain((n) => {
      n.search = { name, filters };
    });
  }

  fullTableScan(): TxQueryChained {
    return this.chain(() => {});
  }

  /**
   * Convex's internal `count()` (STUDY-107; `@internal` in its types, and so not in bunvex's public ones): the
   * table's documents at this snapshot, with this transaction's own writes. On the initializer only, and it
   * leaves the query usable, as Convex's (a call of its own, by table name).
   */
  async count(): Promise<number> {
    try {
      checkIdentifier("table", this.table);
    } catch (e) {
      throw new Error(`Invalid argument \`table\` for \`db.count\`: ${(e as Error).message}`);
    }
    return this.tx.countTable(this.table);
  }
}

// Printed by name only: `console.log` of one never shows the engine's state (inspect.ts).
opaqueToInspect(Tx, QueryImpl, QueryInitializerImpl, ScanReads);

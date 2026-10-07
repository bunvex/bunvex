// The Persistence interface — the whole contract between the engine and wherever its bytes live
// (PERSIST-01, docs/specs/PERSIST-01-contract.md). The engine never looks past it: every driver (memory,
// SQLite, and the external ones in @bunvex/persistence) implements exactly this, and must pass
// @bunvex/persistence-conformance.

/**
 * A table's persistence id (Convex's `TabletId`): the internal id of its `_tables` document, as Convex prints it
 * (base64url without padding, 22 characters). An index's (`IndexId`) is its `_index` document's (STUDY-133 §5.1).
 * A document's (`InternalId`) is the 16 bytes inside its id, printed the same way: persistence keys a
 * document by (tablet, internal id), as Convex's `InternalDocumentId`; its `_id` is in its JSON.
 */
export type TabletId = string;
export type IndexId = string;
export type InternalId = string;
/**
 * One document version, as Convex's `DocumentLogEntry`: `json === null` is a delete; `prevTs` is the ts of the
 * version it replaces (null for a new document), set by the committer.
 */
export type DocWrite = { table: TabletId; id: InternalId; json: string | null; prevTs: bigint | null };
/** A document version as `get` and `getVersions` return it (PERSIST-01 C16): its JSON and the ts it was written at. */
export type DocVersion = { json: string; ts: bigint } | null;
/**
 * One index entry version, as Convex's `PersistenceIndexEntry`: `id` (and `table`) null means the entry was
 * removed. `key` is opaque (keyenc bytes).
 */
export type IndexWrite = { index: IndexId; key: Uint8Array; table: TabletId | null; id: InternalId | null };
/** A live index entry and its document at the entry's own ts (PERSIST-01 C2/C6): what `scan` returns. */
export type IndexedDoc = { id: InternalId; ts: bigint; json: string };
/** An index entry at a past ts: an index backfill's, at its document version's own ts (PERSIST-01 C17). */
export type IndexEntryAt = IndexWrite & { ts: bigint };

export interface Persistence {
  /** Apply one commit's writes at `ts`. Called by the committer, possibly several times per group. */
  apply(ts: bigint, docs: DocWrite[], idx: IndexWrite[]): void;
  /** Make every applied commit durable (one fsync for the whole group). May be async. */
  flush(): void | Promise<void>;
  /**
   * PERSIST-01 C17, an index backfill's write (Convex's `write_index_backfill`, `ConflictStrategy::Overwrite`):
   * each entry at its own (past) ts, the ts of the document version it indexes, replacing an entry of the same
   * index, key and ts. Not a commit: it is in no commit's log, and moves no durable prefix. Durable when it
   * returns; only the lease holder writes (`LeaseLostError` otherwise).
   */
  writeIndexEntries(entries: IndexEntryAt[]): void | Promise<void>;
  /**
   * Index range [lo, hi) of `table`'s index as of `ts` (PERSIST-01 C2, C6): the newest entry of each key at or
   * below `ts`, removed ones left out, in byte order of the key (reversed if `desc`), up to `limit`, each with
   * its document at the entry's own ts, as Convex's `index_scan` (DV-67 reversed): an entry whose document is
   * missing or deleted there rejects with `DanglingReferenceError` (C15). Embedded drivers answer
   * synchronously; remote ones return a promise.
   */
  scan(
    table: TabletId,
    index: IndexId,
    lo: Uint8Array,
    hi: Uint8Array,
    ts: bigint,
    limit: number,
    desc: boolean,
  ): IndexedDoc[] | Promise<IndexedDoc[]>;
  /** The document version visible at `ts` and its ts, or null (missing, or deleted at `ts`). */
  get(table: TabletId, id: InternalId, ts: bigint): DocVersion | Promise<DocVersion>;
  /**
   * PERSIST-01 C16, document versions: for each id, the version of `(table, id)` visible at `ts` and the ts
   * it was written at, or null (missing, or deleted at `ts`); one answer per id, in order, duplicates
   * included. One round trip on a remote store. Optional for third-party drivers; every first-party driver
   * has it (streaming export's per-document timestamps, STUDY-69).
   */
  getVersions?(table: TabletId, ids: InternalId[], ts: bigint): DocVersion[] | Promise<DocVersion[]>;
  /** The highest durable commit ts (recovery on open). */
  maxTs?(): bigint | Promise<bigint>;
  /**
   * Whether an error of `flush()` is transient (STUDY-25 L4, as Convex's `is_transient_db_error`): a timeout
   * or an "operational" error (a lost connection, a server shutting down). The committer retries a transient
   * flush failure with backoff, so a driver that classifies anything as transient MUST keep the group a failed
   * `flush()` did not make durable: the next `flush()` first checks whether an earlier attempt did commit it
   * (`retriedGroupLanded`: then it succeeds without writing), and otherwise writes the same rows at the same
   * timestamps behind the same fence (PERSIST-01 C9). Absent: nothing is transient, any flush failure is
   * fail-stop (the embedded drivers).
   */
  isTransient?(e: unknown): boolean;
  /**
   * PERSIST-01 C14: a persistence global (Convex's `persistence_globals`), JSON, or null if unset. Required:
   * a start finds the catalog from the bootstrap globals (STUDY-133 §5.2). An integer above 2^53 is a
   * `bigint` (`decodeGlobal`), as `max_repeatable_ts`.
   */
  getGlobal(key: string): unknown | Promise<unknown>;
  /** PERSIST-01 C14: set a global; refused (`LeaseLostError`) once the lease is lost. A `bigint` is stored as
   *  a plain JSON integer (`encodeGlobal`). */
  setGlobal(key: string, value: unknown): void | Promise<void>;
  /** AUDIT ONLY (conformance K6, never used by the engine): live documents of a table at ts. */
  auditLiveDocs?(table: TabletId, ts: bigint): number | Promise<number>;
  /** AUDIT ONLY (conformance K21): the rows stored at exactly `ts`, duplicates included. */
  auditRowsAt?(ts: bigint): { docs: number; idx: number } | Promise<{ docs: number; idx: number }>;
  /** AUDIT ONLY (conformance K27): every stored row, every version and tombstone included. */
  auditRowCount?(): { docs: number; idx: number } | Promise<{ docs: number; idx: number }>;
  close(): void | Promise<void>;
}

/** What `acquireLease` found: the lease is now ours (`epoch`), or another process holds it — until its lease
 *  expires (`expiresInMs`), or for as long as it lives (`null`: a process-scoped lease, an OS lock). */
export type LeaseAcquire = { epoch: number } | { heldBy: string; expiresInMs: number | null };

/**
 * PERSIST-01 C7, single writer: one lease record in the store, taken only when free, released or expired
 * (on the store's clock), and checked by every `flush()` in the same atomic write as the group (the fence).
 * Optional per driver; the engine uses it when the driver has it.
 */
export interface Lease {
  /**
   * "process": an OS lock that lives exactly as long as the holding process (no TTL, no renewal).
   * "newest": Convex's lease (DV-413): a start takes it at once from whoever holds it (the newest process
   * wins), there is no TTL, renewing only checks it is still ours, and the previous holder fails its next
   * write with `LeaseLostError`. "ttl" (default): taken only when free, released or expired.
   */
  readonly leaseScope?: "ttl" | "process" | "newest";
  acquireLease(opts: { holder: string; ttlMs: number }): Promise<LeaseAcquire>;
  /** Extend the lease by its TTL; throws `LeaseLostError` if another holder has taken it. */
  renewLease(): Promise<void>;
  /** Free the lease if it is still ours (a clean shutdown hands over at once). */
  releaseLease(): Promise<void>;
}

export const hasLease = (p: Persistence): p is Persistence & Lease =>
  typeof (p as Partial<Lease>).acquireLease === "function";

/**
 * An index entry whose document is not there at the entry's ts (PERSIST-01 C15): no version of the document
 * at that ts (`deleted` false) or a delete there (`deleted` true). The engine writes an entry and its document
 * in the same commit, so this means a corrupt store; a read raises it instead of returning fewer documents than
 * the range holds, as Convex does ("Dangling index reference", "Index reference to deleted document",
 * crates/sqlite/src/lib.rs `index_scan_inner`).
 */
export class DanglingReferenceError extends Error {
  constructor(
    readonly index: IndexId,
    readonly id: InternalId,
    readonly ts: bigint,
    readonly deleted: boolean,
  ) {
    super(
      deleted
        ? `Index reference to deleted document: index ${index} points to ${id}, deleted at ${ts}`
        : `Dangling index reference: index ${index} points to ${id}, which has no version at ${ts}`,
    );
    this.name = "DanglingReferenceError";
  }
}

/** Another process took the store's lease: this one must stop writing (its flushes are fenced). */
export class LeaseLostError extends Error {
  constructor(message = "the store's lease was taken by another process; this one can no longer write") {
    super(message);
    this.name = "LeaseLostError";
  }
}

/**
 * Whether a group a driver failed to flush did commit after all (PERSIST-01 C9, STUDY-25 §3.5, DV-124): the
 * one rule every remote driver applies, before re-running such a group, to the lease record it just read. The
 * fence writes the lease's `max_ts` in the same transaction as the group, and only our own flushes write it
 * under our epoch, in increasing order: our epoch with `max_ts` ≥ the group's top means the group is there
 * (the flush then succeeds without writing: its commits are acknowledged, exactly once). Another epoch, or no
 * lease record: `LeaseLostError`.
 */
export function retriedGroupLanded(
  lease: { epoch: number; maxTs: bigint } | null | undefined,
  epoch: number,
  top: bigint,
): boolean {
  if (!lease || lease.epoch !== epoch) throw new LeaseLostError();
  return lease.maxTs >= top;
}

/** The store is held by another live process (PERSIST-01 C7): only one process may write a store. */
export class LeaseHeldError extends Error {
  constructor(
    readonly heldBy: string,
    /** null: the holder keeps it for as long as it lives (an OS lock on an embedded store). */
    readonly expiresInMs: number | null,
  ) {
    super(
      expiresInMs === null
        ? `another bunvex process (${heldBy}) holds this store; it is released when that process exits`
        : `another bunvex process (${heldBy}) holds this store's lease; it expires in ${Math.ceil(expiresInMs / 1000)} s if that process is gone`,
    );
    this.name = "LeaseHeldError";
  }
}

/** One stored document version, as the document log returns it (PERSIST-01 C12): Convex's `DocumentLogEntry`. */
export type DocLogRow = { ts: bigint; table: TabletId; id: InternalId; deleted: boolean; prevTs: bigint | null };
/** A retention delete (PERSIST-01 C13): every stored version of one index key at or below `ts`. */
export type IndexPrune = { index: IndexId; key: Uint8Array; ts: bigint };
/** A retention delete (PERSIST-01 C13): every stored version of one document at or below `ts`. */
export type DocPrune = { table: TabletId; id: InternalId; ts: bigint };

/**
 * What retention needs from a store (STUDY-33, Convex's `retention.rs`). Optional per driver: without it
 * the engine keeps every version, as before.
 */
export interface RetentionStore {
  /**
   * PERSIST-01 C12, the document log by timestamp: the stored document versions of the durable commits with
   * `afterTs < ts <= upToTs`, in ts order, whole commits only, at most `limit` commits. Never
   * a commit above the durable prefix. Below the retention window it returns what retention left.
   */
  readDocumentLog(afterTs: bigint, upToTs: bigint, limit: number): DocLogRow[] | Promise<DocLogRow[]>;
  /**
   * PERSIST-01 C13: delete every stored version at or below each entry's ts; how many rows went. Only the
   * lease holder deletes: a holder that lost the lease gets `LeaseLostError` and deletes nothing.
   * `through` is how far the caller has read the log (every entry is at or below it): a driver that keeps
   * the log apart from its rows (the memory driver) may forget the log up to there.
   */
  pruneIndexes(entries: IndexPrune[], through: bigint): number | Promise<number>;
  pruneDocuments(entries: DocPrune[], through: bigint): number | Promise<number>;
}

export const hasRetention = (p: Persistence): p is Persistence & RetentionStore =>
  typeof (p as Partial<RetentionStore>).pruneIndexes === "function";

export { wallClockNs } from "../determinism.ts";
export { opaqueToInspect } from "../inspect.ts";
export { bytesToHex, internalIdBytes, internalIdHex, internalIdString } from "../internal-id.ts";
export { chunkRows, MYSQL_MAX_CHUNK_BYTES, POSTGRES_ROWS_PER_STATEMENT } from "./chunks.ts";
export { decodeGlobal, encodeGlobal } from "./global-json.ts";
export {
  checkLayoutVersion,
  checkStoreTables,
  checkUnversionedTables,
  decodeLayoutVersion,
  LAYOUT_VERSION,
  LayoutError,
  type OpenOptions,
  ReadOnlyError,
  type ReadOnlyFlag,
} from "./layout.ts";

export { retryOnce, UnsureCommitError } from "./retry.ts";
export { type IndexRow, type LiveEntry, type Page, type PageRequest, scanLatest, scanLatestSync } from "./scan.ts";
export {
  keySha256,
  keySha256Hex,
  MAX_KEY_PREFIX_LEN,
  type SplitRow,
  type SplitSource,
  splitKey,
  splitPages,
} from "./split.ts";
export { DatabaseTimeoutError, renewTimeoutMs, withTimeout } from "./timeout.ts";

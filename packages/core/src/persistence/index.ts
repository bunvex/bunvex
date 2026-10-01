// The Persistence interface — the whole contract between the engine and wherever its bytes live
// (PERSIST-01, docs/specs/PERSIST-01-contract.md). The engine never looks past it: every driver (memory,
// SQLite, and the external ones in @bunvex/persistence) implements exactly this, and must pass
// @bunvex/persistence-conformance.

/** One document version. `json === null` is a delete. */
export type DocWrite = { table: number; id: string; json: string | null };
/** One index entry version. `id === null` means the entry was removed. `key` is opaque (keyenc bytes). */
export type IndexWrite = { index: number; key: Uint8Array; id: string | null };
/**
 * One commit of the store's log (PERSIST-01 C11): its ts, its index write set (as `apply` received it; the
 * order inside a commit is unspecified), and `prevTs`, the ts of the commit just before it in the log (0 if
 * none). Timestamps are sparse, so `prevTs` is how a reader tells a gap from the next commit.
 */
export type LogCommit = { ts: number; prevTs: number; writes: IndexWrite[] };

export interface Persistence {
  /** Apply one commit's writes at `ts`. Called by the committer, possibly several times per group. */
  apply(ts: number, docs: DocWrite[], idx: IndexWrite[]): void;
  /** Make every applied commit durable (one fsync for the whole group). May be async. */
  flush(): void | Promise<void>;
  /** Index range [lo, hi) as of `ts`: live document ids, in byte order of the key (reversed if `desc`),
   *  up to `limit`. Embedded drivers answer synchronously; remote ones return a promise. */
  scan(
    index: number,
    lo: Uint8Array,
    hi: Uint8Array,
    ts: number,
    limit: number,
    desc: boolean,
  ): string[] | Promise<string[]>;
  /** The document version visible at `ts` (JSON), or null. */
  get(table: number, id: string, ts: number): string | null | Promise<string | null>;
  /** The highest durable commit ts (recovery on open). */
  maxTs?(): number | Promise<number>;
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
   * PERSIST-01 C11, the log by timestamp: the durable commits with `afterTs < ts <= upToTs`, in ts order, at
   * most `limit` of them and never part of one. Never a commit above the durable prefix (`maxTs`), so
   * never one of an unflushed group. Read from `indexes` by ts (every commit writes index entries).
   * Optional for third-party drivers; every first-party driver has it.
   */
  readLog?(afterTs: number, upToTs: number, limit: number): LogCommit[] | Promise<LogCommit[]>;
  /** AUDIT ONLY (conformance K6, never used by the engine): live documents of a table at ts. */
  auditLiveDocs?(table: number, ts: number): number | Promise<number>;
  /** AUDIT ONLY (conformance K21): the rows stored at exactly `ts`, duplicates included. */
  auditRowsAt?(ts: number): { docs: number; idx: number } | Promise<{ docs: number; idx: number }>;
  /** AUDIT ONLY (conformance K26): every stored row, every version and tombstone included. */
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
  /** "process": an OS lock that lives exactly as long as the holding process (no TTL, no renewal). */
  readonly leaseScope?: "ttl" | "process";
  acquireLease(opts: { holder: string; ttlMs: number }): Promise<LeaseAcquire>;
  /** Extend the lease by its TTL; throws `LeaseLostError` if another holder has taken it. */
  renewLease(): Promise<void>;
  /** Free the lease if it is still ours (a clean shutdown hands over at once). */
  releaseLease(): Promise<void>;
}

export const hasLease = (p: Persistence): p is Persistence & Lease =>
  typeof (p as Partial<Lease>).acquireLease === "function";

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
  lease: { epoch: number; maxTs: number } | null | undefined,
  epoch: number,
  top: number,
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

/** One stored document version, as the document log returns it (PERSIST-01 C12). */
export type DocLogRow = { ts: number; table: number; id: string; deleted: boolean };
/** A retention delete (PERSIST-01 C13): every stored version of one index key at or below `ts`. */
export type IndexPrune = { index: number; key: Uint8Array; ts: number };
/** A retention delete (PERSIST-01 C13): every stored version of one document at or below `ts`. */
export type DocPrune = { table: number; id: string; ts: number };

/**
 * What retention needs from a store (STUDY-33, Convex's `retention.rs`). Optional per driver: without it
 * the engine keeps every version, as before.
 */
export interface RetentionStore {
  /**
   * PERSIST-01 C12, the document log by timestamp: the stored document versions of the durable commits with
   * `afterTs < ts <= upToTs`, in ts order, whole commits only, at most `limit` commits. Like `readLog`, never
   * a commit above the durable prefix. Below the retention window it returns what retention left.
   */
  readDocumentLog(afterTs: number, upToTs: number, limit: number): DocLogRow[] | Promise<DocLogRow[]>;
  /**
   * PERSIST-01 C13: delete every stored version at or below each entry's ts; how many rows went. Only the
   * lease holder deletes: a holder that lost the lease gets `LeaseLostError` and deletes nothing.
   * `through` is how far the caller has read the log (every entry is at or below it): a driver that keeps
   * the log apart from its rows (the memory driver) may forget the log up to there.
   */
  pruneIndexes(entries: IndexPrune[], through: number): number | Promise<number>;
  pruneDocuments(entries: DocPrune[], through: number): number | Promise<number>;
  /** PERSIST-01 C14: a persistence global (Convex's `persistence_globals`), JSON, or null if unset. */
  getGlobal(key: string): unknown | Promise<unknown>;
  /** PERSIST-01 C14: set a global; refused (`LeaseLostError`) once the lease is lost. */
  setGlobal(key: string, value: unknown): void | Promise<void>;
}

export const hasRetention = (p: Persistence): p is Persistence & RetentionStore =>
  typeof (p as Partial<RetentionStore>).pruneIndexes === "function";

/** Optional fast path: the documents for what `scan` would return, in one round trip (PERSIST-01 C6). */
export interface ScanDocs {
  scanDocs(
    table: number,
    index: number,
    lo: Uint8Array,
    hi: Uint8Array,
    ts: number,
    limit: number,
    desc: boolean,
  ): Promise<string[]>;
}

export {
  checkLayoutVersion,
  checkUnversionedTables,
  decodeLayoutVersion,
  LAYOUT_VERSION,
  LayoutError,
  type OpenOptions,
  ReadOnlyError,
  type ReadOnlyFlag,
} from "./layout.ts";
export { groupLog, type LogRow } from "./log.ts";
export { retryOnce, UnsureCommitError } from "./retry.ts";
export { type IndexRow, type Page, type PageRequest, scanLatest, scanLatestSync } from "./scan.ts";
export { MAX_KEY_PREFIX_LEN, type SplitRow, type SplitSource, splitKey, splitPages } from "./split.ts";
export { DatabaseTimeoutError, renewTimeoutMs, withTimeout } from "./timeout.ts";

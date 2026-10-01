// The Persistence interface — the whole contract between the engine and wherever its bytes live
// (PERSIST-01, docs/specs/PERSIST-01-contract.md). The engine never looks past it: every driver (memory,
// SQLite, and the external ones in @bunvex/persistence) implements exactly this, and must pass
// @bunvex/persistence-conformance.

/** One document version. `json === null` is a delete. */
export type DocWrite = { table: number; id: string; json: string | null };
/** One index entry version. `id === null` means the entry was removed. `key` is opaque (keyenc bytes). */
export type IndexWrite = { index: number; key: Uint8Array; id: string | null };

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
   * `flush()` did not make durable: the next `flush()` writes the same rows at the same timestamps behind the
   * same fence, and fails (not transient) if an earlier attempt did commit (PERSIST-01 C8). Absent: nothing is
   * transient, any flush failure is fail-stop (the embedded drivers).
   */
  isTransient?(e: unknown): boolean;
  /** AUDIT ONLY (conformance K6, never used by the engine): live documents of a table at ts. */
  auditLiveDocs?(table: number, ts: number): number | Promise<number>;
  /** AUDIT ONLY (conformance K21): the rows stored at exactly `ts`, duplicates included. */
  auditRowsAt?(ts: number): { docs: number; idx: number } | Promise<{ docs: number; idx: number }>;
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

export { retryOnce, UnsureCommitError } from "./retry.ts";
export { type IndexRow, type Page, type PageRequest, scanLatest, scanLatestSync } from "./scan.ts";
export { MAX_KEY_PREFIX_LEN, type SplitRow, type SplitSource, splitKey, splitPages } from "./split.ts";
export { DatabaseTimeoutError, renewTimeoutMs, withTimeout } from "./timeout.ts";
